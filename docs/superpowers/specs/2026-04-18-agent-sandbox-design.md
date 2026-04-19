# Agent Sandbox & Self-Modification Design

**Status:** Draft
**Date:** 2026-04-18
**Scope:** `clawscibois` — the container running `opencode serve`, the Discord bot, and the website.

## Problem

OpenCode runs inside the same container as the Discord bot and website, with full read/write access to `/workspace`. Because `/workspace` contains the very code that runs those services (and the infra that builds and launches them), a user prompt like *"delete the entire repo"* can cause the agent to destroy its own runtime. There is currently no boundary between:

- Code the agent is allowed to modify (feature: self-modding website & bot behavior).
- Code the agent must not modify (how the container is built, launched, and deployed).
- Files the agent may overwrite with broken content (recoverable) vs. files whose loss bricks the system (unrecoverable).

The fix must preserve two properties:

1. The agent can still modify the website source and the Discord bot's runtime source — self-modification is a feature, not a bug.
2. A destructive or broken edit is **cheaply recoverable** (seconds, one command) rather than requiring a container rebuild or manual intervention.

Constraints confirmed with the user:

- Single container (no split into two services yet).
- No human-in-the-loop approval gate — edits go live immediately.
- Infra (`Dockerfile`, `entrypoint.sh`, `compose.yml`, `.github/`) is off-limits to the agent.
- Website source and Discord bot runtime source are both in-scope for agent edits.

## Design

### 1. Two Unix identities inside the container

Two users are created in the image:

| User    | UID  | Purpose                                                                 |
|---------|------|-------------------------------------------------------------------------|
| `app`   | 1000 | Runs the website process, the Discord bot process, the supervisor, and `opencode serve`. Owns binaries and everything that must survive the agent. |
| `agent` | 1001 | The identity used when OpenCode executes tool subprocesses (shell, edit, write). |

The `agent` user has no login shell and no sudo privileges. The container itself no longer runs as root once initialization is complete.

OpenCode's tool execution is scoped to `agent` via one of:

- **Preferred:** `opencode serve` runs as `app`, and wraps each shell tool invocation with `setpriv --reuid=agent --regid=agent --clear-groups ...` or equivalent. This requires OpenCode support for a configurable tool-exec prefix. To be verified during implementation.
- **Fallback:** `opencode serve` itself runs as `agent`. Simpler, but the agent can then kill its own server daemon. Acceptable because the supervisor (running as `app`) restarts it.

If neither is feasible without upstream changes, we accept the fallback. This is an explicit trade-off discussed with the user.

### 2. Filesystem layout and permissions

Two distinct layouts are in play and must not be confused:

**Repo layout (what lives in the git repository at build time):**

```
clawscibois/                         (host / git repo)
├── infra/                           (new — consolidates all build/runtime infra)
│   ├── Dockerfile
│   ├── compose.yml
│   ├── entrypoint.sh
│   ├── supervisor/                  (supervisor source)
│   └── AGENTS.md                    (rules doc, copied into container at root-owned path)
├── src/                             (new top-level — consolidates agent-editable code)
│   ├── website/
│   └── discordbot/
├── .github/                         (CI config; never copied into container)
├── AGENTS.md.tmpl                   (template for agent-editable doc)
├── docs/                            (specs, not shipped in image)
└── README.md
```

**Container runtime layout (`/workspace`, the working directory OpenCode operates in):**

```
/workspace/                          app:app       755   (traversable, not agent-writable)
├── .git/                            app:agent     2775  (agent writes commits via group)
├── AGENTS.md                        app:agent     664   (agent-editable; auto-loaded by OpenCode)
├── src/                             app:agent     2775  (group-writable by agent)
│   ├── website/                     app:agent     2775
│   └── discordbot/                  app:agent     2775
├── .opencode/                       agent:agent   755   (agent scratch: sessions, tmp)
└── infra/                           root:root     755   (read-only to agent; runtime-only files)
    ├── AGENTS.md                    root:root     644   (the immutable rules doc)
    ├── entrypoint.sh                root:root     755   (reference copy; the live one is at /opt)
    └── supervisor/                  root:root     755   (supervisor binary/script)
```

Intentionally **not** in the container's `/workspace/infra/`:

- `Dockerfile` — build-time only; irrelevant at runtime.
- `compose.yml` — orchestrator-level; irrelevant at runtime.
- `.github/` — CI-only; irrelevant at runtime.

Those files live only in the repo and in `/opt/workspace-seed/` inside the image (for seeding). They are never placed under `/workspace/`. This prevents the agent from seeing or referencing files it cannot influence anyway.

Permission properties:

- The agent **cannot** unlink, create, or modify anything under `/workspace/infra/` — enforced by the kernel via directory ownership and mode.
- The agent **can** freely edit files under `/workspace/src/` and `/workspace/AGENTS.md`.
- The agent **can** commit to `/workspace/.git/` (directory is group-writable with the setgid bit so new objects inherit the group).
- `rm -rf /workspace/src` succeeds; recovery is handled by git + supervisor (see §4).
- `rm -rf /workspace` fails because `/workspace` itself is not agent-writable.
- `rm -rf /` fails at `/`.

The setgid bit (the leading `2` in the mode) on `src/` and `.git/` ensures that files the agent creates inherit the `agent` group, keeping the permission model stable across edits.

### 3. Supervisor process

A small supervisor binary (or shell script, or Bun script) runs as `app` and owns the lifecycle of the website and Discord bot processes. Responsibilities:

1. **Watch** `/workspace/src/website/` and `/workspace/src/discordbot/` for file changes (e.g., via `chokidar`, `inotifywait`, or Bun's `--watch`).
2. **Restart** the relevant process on change, with a short debounce (~500ms) to coalesce rapid edits.
3. **Track "last known good commit"** — a git ref updated when a process has been healthy for a configurable window (default: 60 seconds).
4. **Detect crash loops** — if a process exits non-zero N times within T seconds (default: 5 crashes in 60s), declare it bricked.
5. **Auto-revert** on bricked state — `git reset --hard <last-known-good>`, then restart. Log the revert to stdout. Optionally, if `DISCORD_OPS_CHANNEL_ID` is set in the environment, post a notification to that Discord channel. Ops-channel notification is a v1 nice-to-have, not a requirement.
6. **Expose health** — expose a `/supervisor/health` endpoint (on an internal port) reporting process states, last-good SHA, and crash counts. Used by the container `HEALTHCHECK` and by the bot's own `/health` answer.

The supervisor runs `bun run src/server.tsx` (website) and `bun run src/index.ts` (bot) directly — **not** `bun --hot` or `bun --watch`. We want clean process restarts with a crash-loop detector, not in-process HMR that can silently persist corrupt state.

`opencode serve` is also a child of the supervisor, treated as a third managed process alongside the website and bot. An agent-caused crash of the OpenCode daemon is therefore recoverable without a container restart. The supervisor does not auto-revert on OpenCode crashes (they have no associated code change); it simply restarts with exponential backoff and marks the bot "in maintenance" if OpenCode is unavailable for >30 seconds.

### 4. Auto-commit on agent edits

Every filesystem mutation performed by an agent tool call is auto-committed to git:

- **Mechanism:** an OpenCode post-tool hook (if supported) that runs `git add -A && git commit -m "agent: <tool> <target>" --allow-empty` after any edit/write/bash tool completes. If OpenCode does not support post-tool hooks, we fall back to a file-watcher in the supervisor that commits on any change under `/workspace/src/` with a short debounce, which captures the same information at coarser granularity.
- **Authors:** agent-initiated commits are authored as `agent <agent@clawscibois.local>`. Supervisor-initiated revert commits are authored as `supervisor <supervisor@clawscibois.local>`. Both are distinct from any human commits that may be made manually on the workspace via exec-into-container.
- **No remote push by default.** All history is local to the workspace volume. Remote push is a future addition (see "Future work").
- **`.git/` lives on the persistent volume.** Since `/workspace` is bind-mounted, history survives container restarts and rebuilds.
- **The workspace git repo is separate from the clawscibois repo.** On first seed, `entrypoint.sh` runs `git init` inside `/workspace` and creates an initial "seed" commit. This repo is local-only by default, tracks only the contents of `/workspace/src/` and `/workspace/AGENTS.md`, and has no relation to the clawscibois source-control history. It exists purely as the agent's undo log.

Recovery operations (triggered by the supervisor or invoked manually):

- **Revert last agent change:** `git reset --hard HEAD~1`
- **Revert to a specific SHA:** `git reset --hard <sha>`
- **Nuclear reset to seed:** re-run the seed step from the image (see §7).

### 5. Agent-facing documentation

Two files teach the agent its environment.

#### `/workspace/infra/AGENTS.md` (root-owned, immutable)

Short, imperative, stable. Contents:

- Agent identity: "You run as uid `agent`. Writes outside `/workspace/src/` and `/workspace/AGENTS.md` will fail with `EACCES`. This is enforced by the kernel, not by trust."
- Writable paths: explicit list.
- Auto-commit contract: "Every edit you make is automatically committed to git. You do not need to commit yourself."
- Auto-rollback contract: "If your change causes the website or bot to crash more than 5 times in 60 seconds, the supervisor will automatically `git reset --hard` to the last known good commit. You will see this in `git log` as a human-authored revert commit."
- Restart mechanics: "The supervisor watches `src/website/` and `src/discordbot/`. Saving a file restarts the relevant process within ~2 seconds. No manual restart command is needed. To verify: `curl -sS http://localhost:3000 | head` for the website; `curl -sS http://localhost:3001/health` for the bot."
- Rule-change protocol: "If you believe a rule in this file is wrong, say so in the Discord thread. Do not attempt to edit this file — you will get `EACCES`."
- Sentinel phrase: a fixed string (e.g., `CLAW-RULES-v1`) so humans can verify via a Discord prompt whether the agent has actually read the file.

#### `/workspace/AGENTS.md` (agent-editable)

Auto-loaded by OpenCode at session start (this is OpenCode's default behavior for a file of this name at the project root). Contents:

- **Top section, regenerated on every container boot:** the full contents of `infra/AGENTS.md`, followed by a sentinel comment `<!-- @@agent-editable-below -->`.
- **Below the sentinel, preserved across boots:** project guide (what this app is, file map), verification commands, conventions, known gotchas. Initially minimal; grows over time as the agent learns.

Regeneration rule (in `entrypoint.sh`, runs on every container start before the supervisor launches):

1. Read the current `/workspace/AGENTS.md` if it exists (from the persistent volume).
2. Split it at the first occurrence of the sentinel marker `<!-- @@agent-editable-below -->`. Call the portion after the sentinel `tail`. If the file does not exist or the sentinel is absent, treat `tail` as the full default template from `AGENTS.md.tmpl`, and preserve any existing file contents in a sibling file `AGENTS.md.salvage` with a timestamp suffix (so nothing is silently lost if the agent deleted the sentinel).
3. Write a fresh `/workspace/AGENTS.md` containing: contents of `/workspace/infra/AGENTS.md`, a blank line, the sentinel marker, a blank line, then `tail`.
4. `chown app:agent`, `chmod 664`.

This guarantees the rules section is byte-identical to the source of truth on every boot, regardless of what the agent did during the previous run, and no agent-curated content is ever silently deleted.

This gives: immutable rules that cannot drift, plus a growable knowledge base the agent can curate.

### 6. Session creation — unchanged

OpenCode already auto-loads `AGENTS.md` from the project root for every session. The Discord bot's existing call to `createSession(opencode, "discord:${threadId}")` continues to work unchanged. No new session-start plumbing is needed in bot code.

Optional addition (not required for v1): after `createSession`, the bot posts a hidden priming message asking the agent to confirm it has loaded `AGENTS.md` by echoing the sentinel phrase in its first response metadata. Useful sanity check; cheap to add; skip if implementation friction.

### 7. Seed & recovery from image

The existing `entrypoint.sh` seeds `/workspace` from `/opt/workspace-seed` on first boot (via the `.workspace-seed` marker file). This mechanism is kept and extended:

- **Expand what is seeded** so the new layout (`infra/`, `AGENTS.md`, supervisor files) is present on first boot.
- **Fix the leakage** in the current seed: stop copying `.git/`, `.github/`, `Dockerfile`, `entrypoint.sh`, `.env.example`, and the top-level `README.md` into the user's workspace. Only the intended project files go in.
- **Add a `reseed` path** the supervisor can invoke as a last-resort recovery: wipe `/workspace/src/` and restore from `/opt/workspace-seed/src/`. Preserves `.git/` so history isn't lost, but returns source to a known-good state.
- **`infra/` is owned by root in the image** and laid down with those permissions during seed, so the agent never has a window in which it could modify it.

### 8. Container `HEALTHCHECK`

A Docker `HEALTHCHECK` queries the supervisor's `/supervisor/health` endpoint and returns unhealthy if:

- The website has been down (not responsive on :3000) for >30 seconds, or
- The Discord bot has been down (not responsive on :3001/health) for >30 seconds, or
- The supervisor has halted recovery (3+ consecutive failed auto-reverts — see Error handling).

An in-progress auto-revert is **not** unhealthy. Reverting is the recovery mechanism; marking it unhealthy would cause orchestrators to restart the container in the middle of recovery and defeat the point. Reverts are logged and optionally announced to the Discord ops channel, but the healthcheck stays green as long as the supervisor itself is functioning and processes eventually come back up.

## Components

| Component                              | Repo path                    | Container runtime path              | Runs as    | New/Changed | Purpose |
|----------------------------------------|------------------------------|-------------------------------------|------------|-------------|---------|
| Supervisor                             | `infra/supervisor/`          | `/workspace/infra/supervisor/`      | `app`      | New         | Spawns website, bot, and `opencode serve`; watches `src/`; restarts on change; auto-reverts on crash loop; exposes `/supervisor/health`. |
| Entrypoint                             | `infra/entrypoint.sh`        | `/opt/workspace-seed/entrypoint.sh` (executed); `/workspace/infra/entrypoint.sh` (reference copy) | root → app | Changed | Creates users, sets perms, seeds workspace on first boot (fixed to avoid leakage), initializes workspace git repo, regenerates `AGENTS.md` rules section, drops to `app` to run supervisor. |
| Dockerfile                             | `infra/Dockerfile`           | (not in container)                  | —          | Changed     | Multi-stage build; adds `app`/`agent` users; installs `setpriv`, `git`; copies infra to root-owned paths; sets `HEALTHCHECK`. Entrypoint still starts as root so it can perform setup, then drops privileges. |
| OpenCode launch config                 | `infra/supervisor/`          | `/workspace/infra/supervisor/`      | `app`      | Changed     | Spawns `opencode serve` such that tool subprocesses run as `agent` (preferred via wrapper; fallback: daemon itself runs as `agent`). |
| Discord bot source                     | `src/discordbot/`            | `/workspace/src/discordbot/`        | `app`      | Moves       | From `discordbot/` to `src/discordbot/`. No logic changes in this spec. |
| Website source                         | `src/website/`               | `/workspace/src/website/`           | `app`      | Moves       | From `website/` to `src/website/`. No logic changes in this spec. |
| Immutable rules doc                    | `infra/AGENTS.md`            | `/workspace/infra/AGENTS.md`        | —          | New         | Root-owned, read-only to agent. Source of truth for the rules section. |
| Agent-editable doc template            | `AGENTS.md.tmpl`             | `/opt/workspace-seed/AGENTS.md.tmpl`| —          | New         | Template used when `/workspace/AGENTS.md` doesn't exist or the sentinel is missing. |
| Auto-commit hook                       | `infra/supervisor/commit-hook` | `/workspace/infra/supervisor/commit-hook` | `agent` via OpenCode | New | Invoked after agent tool calls to `git add -A && git commit`. Supervisor watcher is the fallback if OpenCode doesn't support post-tool hooks. |
| Compose file                           | `infra/compose.yml`          | (not in container)                  | —          | Changed     | Sets `restart: unless-stopped`; mounts `/workspace` volume; no longer exposes :4096 by default (only :3000 and :3001). |

## Data flow — one "agent edits a page" cycle

```
Discord thread: "make the homepage title green"
    │
    ▼
Discord bot (runs as app) → POST /session/:id/message → opencode serve (app)
    │
    ▼
opencode dispatches its "edit" tool → subprocess as uid agent
    │
    ▼
write to /workspace/src/website/src/App.tsx   (allowed; perms permit)
    │
    ▼
post-tool hook (or supervisor watcher) → git add + commit, author=agent
    │
    ▼
supervisor notices change under src/website/ → debounce → restart website process
    │
    ▼
website (app) reboots, serves new markup on :3000
    │
    ▼
if website stays healthy for ≥60s → supervisor updates "last known good" ref to this SHA
    │
    ▼
opencode returns assistant reply → bot posts to Discord: "done, see localhost:3000"
```

Crash-loop path (agent writes broken code):

```
agent writes /workspace/src/discordbot/index.ts with a syntax error
    │
    ▼ (commit)
    ▼
supervisor restarts bot → bot exits 1
    │
    ▼ repeat 5 times in 60s
    ▼
supervisor: "bricked" → git reset --hard <last-known-good>  → restart bot
    │
    ▼
bot boots, serves /health=ok → log "auto-reverted from <bad-sha> to <good-sha>"
    │
    ▼ (optional) post to Discord ops channel
```

## Error handling

| Failure                                                  | Handling                                                                                                          |
|----------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| Agent deletes everything under `src/`                    | Next process restart fails → crash loop → auto-revert to last good commit.                                        |
| Agent writes syntactically broken code                   | Same: crash loop → auto-revert.                                                                                   |
| Agent writes logically broken code that *doesn't* crash  | Not caught by crash-loop detector. Recovery is manual: `git log`, `git reset --hard <sha>`. Acceptable for v1.    |
| Agent deletes/rewrites `/workspace/AGENTS.md`            | Rule section is regenerated on next container boot from `/workspace/infra/AGENTS.md`. If the sentinel marker is missing, the previous file contents are preserved as `AGENTS.md.salvage.<timestamp>` and a fresh template is laid down. Nothing is silently lost. |
| Agent corrupts `/workspace/.git/`                        | Genuinely bad. Mitigation deferred: post-v1 work should mirror-push to a bare repo on the same volume. Documented as known limitation. |
| `opencode serve` dies                                    | Supervisor restarts it. If it crash-loops, supervisor halts it, reports unhealthy; bot begins returning a maintenance message to new Discord prompts. |
| Supervisor dies                                          | Container `HEALTHCHECK` returns unhealthy. In the current single-container Compose setup this surfaces to the operator; orchestrators (k8s etc.) would restart. Container-level restart policy `unless-stopped` in `compose.yml` ensures restart. |
| Auto-revert loops (every revert also crashes)            | Supervisor halts after 3 consecutive failed reverts, marks the container unhealthy, stops trying. Requires human intervention. |
| OpenCode cannot be configured to drop privs for tools    | Fallback: run `opencode serve` itself as `agent`. Documented trade-off. |
| First-boot seeding races with the supervisor starting    | `entrypoint.sh` completes seeding synchronously before spawning the supervisor. |

## Testing

Unit-level:

- Permission tests: as user `agent`, attempt to write to each of `infra/`, `entrypoint.sh`, `Dockerfile`, `.github/`, `/workspace/AGENTS.md` (should succeed), `/workspace/infra/AGENTS.md` (should fail with `EACCES`).
- Supervisor crash-loop detector: spawn a fake child that exits 1 immediately; verify supervisor declares bricked after 5 crashes in 60s and performs a revert.
- Supervisor "last known good" tracker: spawn a fake child that stays up for 61s; verify the ref advances.
- `AGENTS.md` regeneration: corrupt the rules section on disk, boot the container, verify the rules section is restored and the below-sentinel content is preserved.

Integration-level (in a throwaway container):

- Start the container, confirm all three processes come up and `HEALTHCHECK` reports healthy.
- Open an OpenCode session, instruct the agent to modify `src/website/src/App.tsx`, confirm the change is committed, the website restarts, and the new content is served.
- Instruct the agent to `rm -rf /workspace/src` and verify: crash loop is detected, auto-revert happens, services come back, `git log` shows the agent's destructive commit followed by a revert.
- Instruct the agent to modify `/workspace/infra/entrypoint.sh` and verify the attempt fails with `EACCES` and the agent reports the failure back to the user.
- Prompt "what is your sentinel phrase?" and verify it returns the value from `infra/AGENTS.md`.

## Future work (explicitly out of scope for v1)

- Mirror-push git history to a bare repo or remote for `.git/` corruption resilience.
- Split into two containers (`opencode` + `app`), removing the OpenCode priv-drop from the TCB.
- Resource limits (CPU/memory/fork caps) on the agent user to block fork bombs / runaway processes.
- Network egress controls for the agent (block exfiltration of secrets).
- Review-gate mode (agent commits to a branch; merge requires human approval) as an opt-in.
- Multi-user concurrency control on shared files within a single Discord guild.
- `!rollback <sha>` and `!reseed` Discord commands.

## Behavior changes from current system

- **Repository layout changes.** `website/` and `discordbot/` move under `src/`. Infra consolidates under `infra/`. Users running the existing image against an existing `/workspace` volume need a one-time migration (done by `entrypoint.sh` on boot: if it detects the old layout, it moves directories into the new layout before seeding).
- **Port `:4096` (OpenCode) no longer exposed to the host by default.** It is reachable only from inside the container (the bot talks to `127.0.0.1:4096`). Operators who were hitting OpenCode from the host must set `OPENCODE_EXPOSE=1` in the environment to restore the mapping. Rationale: an unauthenticated or weakly-authenticated OpenCode on a public port is the single largest security hole in the current setup.
- **Container no longer runs as root after setup.** `entrypoint.sh` starts as root, performs setup, then `exec`s the supervisor as `app`. Anyone relying on `docker exec ... sh` landing as root will now land as `app` unless they pass `--user root`.
- **No more `bun --hot` / `bun run dev` in the shipped container.** Processes run via the supervisor with clean restarts. Developer workflows that relied on in-place HMR now get out-of-process restart (still under 2s on save).
- **First Discord reply after cold-start is slower** (~1–3 s additional) because OpenCode now runs under the supervisor with health gating before the bot accepts traffic.

## Trade-offs accepted

- **Single-container blast radius.** If `opencode serve` fails to drop privs for tool exec, the agent effectively runs as `app` and can kill the bot/website processes directly. Mitigated by running the daemon itself as `agent` if needed; re-evaluated if this becomes a real problem.
- **No remote git push in v1.** Loss of the workspace volume = loss of history. Volume is persistent; backup is the operator's responsibility at the infra layer.
- **No logic-bug detection.** Crash-loop recovery only catches changes that crash. Changes that compile and run but are wrong must be caught by humans.
- **Agent can still waste time.** Nothing in this design prevents the agent from making slow, expensive, or useless edits. Scope is safety, not quality.
- **The agent's workspace git repo is disposable.** Its history has no relationship to the clawscibois source tree's git history. Agents cannot push or PR; humans reading `git log` in `/workspace` are reading the agent's private undo log, not project history.
