#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
ROOT="${WORKSPACE:-$SCRIPT_DIR}"
PROJECT="$ROOT"
SEED=/opt/workspace-seed

if [ ! -f "$PROJECT/.workspace-seed" ]; then
  mkdir -p "$PROJECT"
  cp -a "$SEED"/. "$PROJECT"/
fi

cd "$PROJECT"

(cd "$PROJECT/src/website" && bun install --ignore-scripts)
(cd "$PROJECT/src/discordbot" && bun install)

OPENCODE_PORT="${OPENCODE_SERVE_PORT:-4096}"
OPENCODE_HOST="${OPENCODE_SERVE_HOSTNAME:-0.0.0.0}"
CORS_DEFAULT="http://localhost:${WEBSITE_PORT:-${PORT:-3000}}"
OPENCODE_CORS="${OPENCODE_CORS:-$CORS_DEFAULT}"

opencode serve \
  --hostname "$OPENCODE_HOST" \
  --port "$OPENCODE_PORT" \
  --cors "$OPENCODE_CORS" \
  "$PROJECT" &
opencode_pid=$!

DISCORD_PORT="${DISCORD_BOT_PORT:-3001}"
(cd "$PROJECT/src/discordbot" && PORT="$DISCORD_PORT" bun --hot run src/index.ts) &
discord_pid=$!

cleanup() {
  if kill -0 "$discord_pid" 2>/dev/null; then
    kill "$discord_pid" 2>/dev/null || true
    wait "$discord_pid" 2>/dev/null || true
  fi
  if kill -0 "$opencode_pid" 2>/dev/null; then
    kill "$opencode_pid" 2>/dev/null || true
    wait "$opencode_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

sleep 1
cd "$PROJECT/src/website"
bun run dev
