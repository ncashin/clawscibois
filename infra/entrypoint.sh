#!/bin/bash
set -euo pipefail

ROOT="${WORKSPACE:-/workspace}"
SEED=/opt/workspace-seed

log() { printf '%s [entrypoint] %s\n' "$(date -Iseconds)" "$*"; }

# -----------------------------------------------------------------------
# 1. Seed workspace on first boot
# -----------------------------------------------------------------------
if [ ! -f "$ROOT/.workspace-seed" ]; then
  log "seeding $ROOT from $SEED"
  mkdir -p "$ROOT"
  # Copy source trees WITHOUT their node_modules / dist — those are heavy,
  # vary per-machine, and should not end up in the workspace git repo.
  rsync -a --exclude='node_modules' --exclude='dist' "$SEED/src/" "$ROOT/src/"
  # Place the immutable rules doc inside the workspace so OpenCode sessions
  # can read it. Everything else infra-related (entrypoint, supervisor) runs
  # from /opt/workspace-seed and is NOT copied into the workspace volume —
  # keeps the agent surface minimal and lets us update infra via image rebuild.
  mkdir -p "$ROOT/infra"
  cp -a "$SEED/infra/AGENTS.md" "$ROOT/infra/AGENTS.md"
  cp -a "$SEED/infra/workspace.gitignore" "$ROOT/.gitignore"
  touch "$ROOT/.workspace-seed"
fi

# -----------------------------------------------------------------------
# 2. Always regenerate /workspace/AGENTS.md (rules + editable tail)
# -----------------------------------------------------------------------
RULES="$ROOT/infra/AGENTS.md"
AGENTS="$ROOT/AGENTS.md"
TMPL="$SEED/AGENTS.md.tmpl"
SENTINEL='<!-- @@agent-editable-below -->'

if [ -f "$AGENTS" ] && grep -q "$SENTINEL" "$AGENTS"; then
  TAIL=$(awk -v s="$SENTINEL" 'f{print} $0==s{f=1}' "$AGENTS")
else
  if [ -f "$AGENTS" ]; then
    mv "$AGENTS" "$ROOT/AGENTS.md.salvage.$(date +%s)"
  fi
  TAIL=$(awk -v s="$SENTINEL" 'f{print} $0==s{f=1}' "$TMPL")
fi

{
  cat "$RULES"
  echo
  echo "$SENTINEL"
  echo
  printf '%s\n' "$TAIL"
} > "$AGENTS"

# -----------------------------------------------------------------------
# 3. Set ownership & permissions (requires running as root up to here)
# -----------------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  log "setting ownership"
  chown -R root:root "$ROOT/infra"
  chmod 755 "$ROOT/infra"
  chmod 644 "$ROOT/infra/AGENTS.md"

  # src/ and AGENTS.md: app:agent, group-writable + setgid on dirs.
  chown app:app "$ROOT"
  chmod 755 "$ROOT"

  chown -R app:agent "$ROOT/src"
  # Prune node_modules from the permission walk: their perms come from
  # `bun install` (executable bits on .bin/*, etc.) and we don't want to
  # clobber them. `find -prune` applies BEFORE further descent.
  find "$ROOT/src" -name node_modules -prune -o \
       \( -type d -exec chmod 2775 {} + \)
  find "$ROOT/src" -name node_modules -prune -o \
       \( -type f -exec chmod 664 {} + \)

  chown app:agent "$ROOT/AGENTS.md"
  chmod 664 "$ROOT/AGENTS.md"

  # Workspace .gitignore: owned by app:app and read-only to the agent so
  # the agent can't quietly un-ignore node_modules and bloat the repo.
  if [ -f "$ROOT/.gitignore" ]; then
    chown app:app "$ROOT/.gitignore"
    chmod 644 "$ROOT/.gitignore"
  fi

  # .opencode: agent-owned scratch
  mkdir -p "$ROOT/.opencode"
  chown -R agent:agent "$ROOT/.opencode"

  # .chat-state: app-owned, agent-unreadable. Holds the Discord bot's
  # SQLite state (subscriptions, locks, cached keys, queues). Keeping
  # this strictly out of reach of the agent ensures the bot cannot have
  # its memory wiped, corrupted, or exfiltrated by agent activity.
  mkdir -p "$ROOT/.chat-state"
  chown -R app:app "$ROOT/.chat-state"
  chmod 700 "$ROOT/.chat-state"
  # Any files that already exist inside (from previous runs) should be
  # owned app:app too.
  find "$ROOT/.chat-state" -exec chown app:app {} +
  find "$ROOT/.chat-state" -type d -exec chmod 700 {} +
  find "$ROOT/.chat-state" -type f -exec chmod 600 {} +

  # .git will be created/used by the supervisor if missing; ensure the
  # workspace itself is traversable and give agent group write via .git
  # once it exists.
  if [ -d "$ROOT/.git" ]; then
    chown -R app:agent "$ROOT/.git"
    find "$ROOT/.git" -type d -exec chmod 2775 {} +
    find "$ROOT/.git" -type f -exec chmod 664 {} +
  fi
fi

# -----------------------------------------------------------------------
# 4. Ensure per-project deps exist in the volume (first boot does this)
# -----------------------------------------------------------------------
if [ ! -d "$ROOT/src/website/node_modules" ]; then
  log "installing website deps"
  (cd "$ROOT/src/website" && su -s /bin/bash -c "bun install --ignore-scripts" app)
fi
if [ ! -d "$ROOT/src/discordbot/node_modules" ]; then
  log "installing discordbot deps"
  (cd "$ROOT/src/discordbot" && su -s /bin/bash -c "bun install" app)
fi

# Supervisor deps live in the image (pre-installed by Dockerfile into
# /opt/workspace-seed/infra/supervisor/node_modules), not in the workspace.

# -----------------------------------------------------------------------
# 5. Drop privs and exec the supervisor
# -----------------------------------------------------------------------
log "handing off to supervisor as user app"
cd "$ROOT"
exec su -s /bin/bash -c "cd $SEED/infra/supervisor && exec bun run src/index.ts" app
