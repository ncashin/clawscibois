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

export async function getHeadSha(dir: string): Promise<string | null> {
  const { exitCode, stdout } = await run(dir, ["rev-parse", "HEAD"]);
  if (exitCode !== 0) return null;
  return stdout || null;
}

export async function commitAll(
  dir: string,
  opts: { author: Author; message: string },
): Promise<string | null> {
  await runOrThrow(dir, ["add", "-A"]);
  const status = await runOrThrow(dir, ["status", "--porcelain"]);
  if (status === "") return null;

  const env = {
    GIT_AUTHOR_NAME: opts.author.name,
    GIT_AUTHOR_EMAIL: opts.author.email,
    GIT_COMMITTER_NAME: opts.author.name,
    GIT_COMMITTER_EMAIL: opts.author.email,
  };
  await runOrThrow(dir, ["commit", "-m", opts.message], env);
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
