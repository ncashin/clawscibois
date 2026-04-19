export type Author = { name: string; email: string };

async function run(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function runOrThrow(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  const { exitCode, stdout, stderr } = await run(cwd, args, env);
  if (exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${exitCode}: ${stderr || stdout}`,
    );
  }
  return stdout;
}

export async function ensureWorkspaceRepo(dir: string): Promise<void> {
  const check = await run(dir, ["rev-parse", "--verify", "HEAD"]);
  if (check.exitCode === 0) return;

  await runOrThrow(dir, ["init", "--initial-branch=main"]);
  await runOrThrow(dir, ["config", "user.name", "seed"]);
  await runOrThrow(dir, ["config", "user.email", "seed@clawscibois.local"]);
  await runOrThrow(dir, ["add", "-A"]);
  // --allow-empty in case the workspace is literally empty on first boot.
  await runOrThrow(dir, ["commit", "--allow-empty", "-m", "seed: initial workspace snapshot"]);
}

// Remove a path from the git index without touching the working tree.
// Used on boot to self-heal volumes where paths that shouldn't be tracked
// (e.g., the root-owned `infra/` dir which `app` cannot modify during
// a `git reset --hard`) got committed historically. Idempotent: if the
// path isn't tracked, this is a no-op.
//
// Returns true iff a new "prune" commit was created as a result.
export async function untrackPath(
  dir: string,
  path: string,
  author: Author,
): Promise<boolean> {
  // ls-files exits 0 whether or not anything matches; the empty-string
  // check tells us whether the path is currently tracked.
  const { stdout } = await run(dir, ["ls-files", "--", path]);
  if (stdout === "") return false;

  await runOrThrow(dir, ["rm", "-r", "--cached", "--ignore-unmatch", "--", path]);
  const env = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  await runOrThrow(
    dir,
    ["commit", "-m", `supervisor: stop tracking ${path}`],
    env,
  );
  return true;
}

export async function getHeadSha(dir: string): Promise<string | null> {
  const { exitCode, stdout } = await run(dir, ["rev-parse", "HEAD"]);
  if (exitCode !== 0) return null;
  return stdout || null;
}

export async function commitAll(
  dir: string,
  opts: { author: Author; message: string; allowEmpty?: boolean },
): Promise<string | null> {
  await runOrThrow(dir, ["add", "-A"]);
  if (!opts.allowEmpty) {
    const status = await runOrThrow(dir, ["status", "--porcelain"]);
    if (status === "") return null;
  }

  const env = {
    GIT_AUTHOR_NAME: opts.author.name,
    GIT_AUTHOR_EMAIL: opts.author.email,
    GIT_COMMITTER_NAME: opts.author.name,
    GIT_COMMITTER_EMAIL: opts.author.email,
  };
  const commitArgs = opts.allowEmpty
    ? ["commit", "--allow-empty", "-m", opts.message]
    : ["commit", "-m", opts.message];
  await runOrThrow(dir, commitArgs, env);
  return getHeadSha(dir);
}

export async function hardResetTo(dir: string, sha: string): Promise<void> {
  const check = await run(dir, ["cat-file", "-e", `${sha}^{commit}`]);
  if (check.exitCode !== 0) {
    throw new Error(
      `hardResetTo: ${sha} is not a reachable commit in ${dir}`,
    );
  }
  await runOrThrow(dir, ["reset", "--hard", sha]);
}

const GOOD_REF = "refs/supervisor/good";

export async function updateGoodRef(dir: string, sha: string): Promise<void> {
  const check = await run(dir, ["cat-file", "-e", `${sha}^{commit}`]);
  if (check.exitCode !== 0) {
    throw new Error(
      `updateGoodRef: ${sha} is not a reachable commit in ${dir}`,
    );
  }
  await runOrThrow(dir, ["update-ref", GOOD_REF, sha]);
}

export async function getGoodRef(dir: string): Promise<string | null> {
  const { exitCode, stdout } = await run(dir, ["rev-parse", GOOD_REF]);
  if (exitCode !== 0) return null;
  return stdout || null;
}
