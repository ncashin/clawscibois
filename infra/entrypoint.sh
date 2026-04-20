#!/bin/bash
set -euo pipefail

ROOT="${WORKSPACE:-/workspace}"
SEED=/opt/workspace-seed

log() { printf '%s [entrypoint] %s\n' "$(date -Iseconds)" "$*"; }

# 1. Seed workspace on first boot.
# Infra (entrypoint, supervisor) runs from /opt/workspace-seed and is NOT
# copied here. node_modules and dist are excluded - they're heavy and
# don't belong in the workspace git repo.
if [ ! -f "$ROOT/.workspace-seed" ]; then
  log "seeding $ROOT from $SEED"
  mkdir -p "$ROOT"
  rsync -a --exclude='node_modules' --exclude='dist' "$SEED/src/" "$ROOT/src/"
  mkdir -p "$ROOT/infra"
  cp -a "$SEED/infra/workspace.gitignore" "$ROOT/.gitignore"
  touch "$ROOT/.workspace-seed"
fi

# Refresh root-owned workspace infra files from the image every boot so
# image updates reach the agent without requiring a re-seed.
mkdir -p "$ROOT/infra"
cp -f "$SEED/infra/AGENTS.md" "$ROOT/infra/AGENTS.md"
cp -f "$SEED/infra/opencode.json" "$ROOT/infra/opencode.json"

# 2. Regenerate /workspace/AGENTS.md (immutable rules + editable tail).
# Read rules from the image, not the workspace copy, so image updates
# reach the agent without requiring a re-seed.
RULES="$SEED/infra/AGENTS.md"
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

# 3. Set ownership & permissions. Requires running as root.
if [ "$(id -u)" -eq 0 ]; then
  log "setting ownership"
  chown -R root:root "$ROOT/infra"
  chmod 755 "$ROOT/infra"
  chmod 644 "$ROOT/infra/AGENTS.md"
  chmod 644 "$ROOT/infra/opencode.json"

  chown app:app "$ROOT"
  chmod 755 "$ROOT"

  # src/ and AGENTS.md: app:agent, group-writable + setgid on dirs.
  # Prune node_modules from the walk; its perms come from `bun install`
  # (executable .bin/* scripts) and we don't want to strip them.
  chown -R app:agent "$ROOT/src"
  find "$ROOT/src" -name node_modules -prune -o \
       \( -type d -exec chmod 2775 {} + \)
  find "$ROOT/src" -name node_modules -prune -o \
       \( -type f -exec chmod 664 {} + \)

  chown app:agent "$ROOT/AGENTS.md"
  chmod 664 "$ROOT/AGENTS.md"

  # .gitignore is app-owned so the agent can't un-ignore node_modules.
  if [ -f "$ROOT/.gitignore" ]; then
    chown app:app "$ROOT/.gitignore"
    chmod 644 "$ROOT/.gitignore"
  fi

  # Agent scratch.
  mkdir -p "$ROOT/.opencode"
  chown -R agent:agent "$ROOT/.opencode"

  # Bot's SQLite state. app-only (mode 700) so the agent cannot read,
  # wipe, or corrupt the bot's memory.
  mkdir -p "$ROOT/.chat-state"
  chown -R app:app "$ROOT/.chat-state"
  chmod 700 "$ROOT/.chat-state"
  find "$ROOT/.chat-state" -exec chown app:app {} +
  find "$ROOT/.chat-state" -type d -exec chmod 700 {} +
  find "$ROOT/.chat-state" -type f -exec chmod 600 {} +

  # Workspace git repo: the supervisor manages it; agent writes via group.
  if [ -d "$ROOT/.git" ]; then
    chown -R app:agent "$ROOT/.git"
    find "$ROOT/.git" -type d -exec chmod 2775 {} +
    find "$ROOT/.git" -type f -exec chmod 664 {} +
  fi
fi

# 4. Install per-project deps on first boot. Supervisor deps are
# pre-installed in the image under /opt/workspace-seed/infra/supervisor.
if [ ! -d "$ROOT/src/website/node_modules" ]; then
  log "installing website deps"
  (cd "$ROOT/src/website" && su -s /bin/bash -c "bun install --ignore-scripts" app)
fi
if [ ! -d "$ROOT/src/discordbot/node_modules" ]; then
  log "installing discordbot deps"
  (cd "$ROOT/src/discordbot" && su -s /bin/bash -c "bun install" app)
fi

# 5. Drop privs and exec the supervisor.
log "handing off to supervisor as user app"
cd "$ROOT"
exec su -s /bin/bash -c "cd $SEED/infra/supervisor && exec bun run src/index.ts" app
