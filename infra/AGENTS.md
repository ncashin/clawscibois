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

## Upgrading to newer code from the image

The container image ships a pristine copy of the intended source tree
at `/opt/workspace-seed/src/`. This is root-owned and read-only to
you. Your editable working copy at `/workspace/src/` persists on the
volume, so your past edits survive restarts - but that also means
updates baked into a newer image do NOT automatically reach you. The
operator has to deliberately pull them in via you.

When asked to "upgrade", "pull the latest code", "sync from the
image", "check for new code", or similar, do the following:

1. See what's different:

   ```
   diff -r /opt/workspace-seed/src/ /workspace/src/
   ```

   Ignore any differences inside `node_modules/`, `dist/`, or
   `bun.lock` - those are dependency artifacts, not source. A clean
   way to filter: pipe through `grep -v node_modules | grep -v dist`.

2. Summarise the diff for the user. Include a bullet list of the
   files that differ, and where it's short, the gist of each change.

3. Ask the user whether to adopt the pristine version, specific
   files, or none of it. Do not adopt without confirmation - your
   working copy may contain the user's own in-progress edits.

4. To adopt, copy from the pristine tree:

   ```
   cp /opt/workspace-seed/src/<path> /workspace/src/<path>
   ```

   You can overwrite as many files as confirmed. The supervisor will
   auto-commit and restart the affected processes. Do NOT copy
   `node_modules/` - it's heavy and varies per image build; the
   supervisor's entrypoint manages those.

5. After copying, verify the processes came back cleanly via the
   URLs in "Restarting after an edit".

If the upgrade bricks the bot or website, the supervisor will
auto-revert and you'll see a `supervisor:` commit in `git log`.

## If a rule seems wrong

Say so in the Discord thread. Do not try to edit this file - you
will get `EACCES`. Do not try to work around the rules; they exist
because the user asked for them.

## Known limitations

- Your git repo in `/workspace` is a local undo log, not the
  clawscibois project's real git history. Do not push it.
- Logic bugs that don't crash processes are not auto-detected.
  Test your changes by hitting the URLs above.
