# clawscibois

A Discord bot, a website, and a sandboxed OpenCode agent - all in one container.
The agent can modify the bot's and the website's source at runtime. Destructive
edits are automatically recovered via an internal git repo and a crash-loop
watchdog.

## Running

Required `.env` at the repo root (see `.env.example`):

- `DISCORD_BOT_TOKEN`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_APPLICATION_ID`
- `OPENCODE_SERVER_PASSWORD` (used by the bot to talk to OpenCode)

Then:

```
docker compose up --build
```

- Website: http://localhost:3000
- Bot webhook: http://localhost:3001/api/webhooks/discord
- Supervisor health: http://127.0.0.1:3002/supervisor/health (internal only;
  exec into the container to hit it)

## Architecture

- Container runs as user `app` after setup; OpenCode runs as `agent`.
- `infra/` is root-owned and unwritable to the agent.
- `src/` is agent-editable. Changes are auto-committed to `/workspace/.git`.
- A supervisor watches source, restarts processes on change, and
  `git reset --hard`s to the last healthy commit if either process crash-loops.

## Repo layout

- `src/website/`: SSR React site
- `src/discordbot/`: Discord bot that proxies to OpenCode
- `infra/`: Dockerfile, supervisor, entrypoint, rules
- `docs/`: specs and plans
