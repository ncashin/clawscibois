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
  # Copy only the files we want the agent (and the running processes) to see.
  cp -a "$SEED/src" "$ROOT/src"
  mkdir -p "$ROOT/infra"
  cp -a "$SEED/infra/AGENTS.md" "$ROOT/infra/AGENTS.md"
  cp -a "$SEED/infra/supervisor" "$ROOT/infra/supervisor"
  cp -a "$SEED/infra/entrypoint.sh" "$ROOT/infra/entrypoint.sh"
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
  chmod 755 "$ROOT/infra/entrypoint.sh"

  # src/ and AGENTS.md: app:agent, group-writable + setgid on dirs.
  chown app:app "$ROOT"
  chmod 755 "$ROOT"

  chown -R app:agent "$ROOT/src"
  find "$ROOT/src" -type d -exec chmod 2775 {} +
  find "$ROOT/src" -type f -exec chmod 664 {} +

  chown app:agent "$ROOT/AGENTS.md"
  chmod 664 "$ROOT/AGENTS.md"

  # .opencode: agent-owned scratch
  mkdir -p "$ROOT/.opencode"
  chown -R agent:agent "$ROOT/.opencode"

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
if [ ! -d "$ROOT/infra/supervisor/node_modules" ]; then
  log "installing supervisor deps"
  (cd "$ROOT/infra/supervisor" && su -s /bin/bash -c "bun install" app)
fi

# -----------------------------------------------------------------------
# 5. Drop privs and exec the supervisor
# -----------------------------------------------------------------------
log "handing off to supervisor as user app"
cd "$ROOT"
exec su -s /bin/bash -c "cd $ROOT/infra/supervisor && exec bun run src/index.ts" app
