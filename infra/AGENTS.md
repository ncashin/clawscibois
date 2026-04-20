# Agent Rules (Immutable)

This file is root-owned and read-only to you. You cannot modify it.
Rule sentinel: `CLAW-RULES-v1`

## Your identity

You run as Unix user `agent` (uid 1001). The Discord bot and website
run as user `app` (uid 1000). You and they share the filesystem but
have different write permissions.

## What you can write

- `/workspace/src/` - all source code for the website and Discord bot.
- `/workspace/AGENTS.md` - the companion doc with project knowledge.
- `/workspace/.opencode/` - your scratch space.
- `/workspace/.git/` - via your group membership; commits are managed
  automatically, see below.

## What you cannot write

- `/workspace/infra/` - all build, supervisor, and rules files.
- Anywhere outside `/workspace/` - most of `/` is root-owned.

Writes to forbidden paths fail with `EACCES`. This is enforced by
the Linux kernel, not by trust.

## Auto-commit

Every change you make under `/workspace/src/` is automatically
committed to a local git repo inside the workspace by the supervisor.
You do not need to run `git add` or `git commit`. Commits are authored
as `agent <agent@clawscibois.local>`.

## Auto-revert

The supervisor watches the bot and website processes. If your change
causes either to crash more than 5 times within 60 seconds, the
supervisor will `git reset --hard` to the last known good commit
(a ref called `refs/supervisor/good`), then restart. You will see
a commit authored by `supervisor <supervisor@clawscibois.local>`
recording the revert.

## Restarting after an edit

You do not restart anything. The supervisor watches `src/website/`
and `src/discordbot/`. Saving a file triggers a graceful restart
within ~500ms (debounced) + up to 2s for the process to be healthy.

To verify a change is live:

- Website: `curl -sS http://localhost:3000 | head`
- Bot: `curl -sS http://localhost:3001/health`

## If a rule seems wrong

Say so in the Discord thread. Do not try to edit this file - you
will get `EACCES`. Do not try to work around the rules; they exist
because the user asked for them.

## Known limitations

- Your git repo in `/workspace` is a local undo log, not the
  clawscibois project's real git history. Do not push it.
- Logic bugs that don't crash processes are not auto-detected.
  Test your changes by hitting the URLs above.
