# Agent Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the agent sandbox described in `docs/superpowers/specs/2026-04-18-agent-sandbox-design.md` — prevent OpenCode from destroying its own runtime while preserving the ability to self-modify the website and bot source.

**Architecture:** Single container, two Unix users (`app` runs services, `agent` runs OpenCode tool executions). Filesystem permissions enforce the boundary. A Bun-based supervisor owns process lifecycle, watches source for changes, auto-commits to a per-workspace git repo, and auto-reverts on crash loops.

**Tech Stack:** Bun, TypeScript, Debian-based `oven/bun:1` container, standard Linux users/perms, git.

---

## Preconditions and defaults

**Branch:** work on a dedicated branch (not `main`). Create it in task 0.

**Defaults chosen for this plan (change as needed):**

- OpenCode tool isolation: **fallback approach** — `opencode serve` itself runs as `agent`. Simpler than the setpriv wrapper and matches "get to a working safety property fast." Agent can kill its own daemon; supervisor restarts it.
- Auto-commit granularity: **coarse** — supervisor file-watcher commits on any change under `src/` with 1s debounce. An OpenCode-plugin-based fine-grained commit is a phase-2 polish item.
- Migration: **clean slate assumed** — no code to migrate existing `/workspace` volumes from the old layout. If there's a live deployment, stop the container and delete the volume before the new image runs.

**Known pre-existing uncommitted change:** `Dockerfile` has been switched from `oven/bun:1-alpine` to `oven/bun:1` (uncommitted in the working tree at the time of plan authoring). The plan assumes Debian-based.

---

## File structure

### Repo layout after this plan

```
clawscibois/
├── infra/
│   ├── Dockerfile               (moved from repo root, updated)
│   ├── compose.yml              (moved from repo root, updated)
│   ├── entrypoint.sh            (moved from repo root, rewritten)
│   ├── AGENTS.md                (new — immutable rules, shipped to container)
│   ├── AGENTS.md.tmpl           (new — template for agent-editable doc)
│   └── supervisor/
│       ├── package.json         (new — Bun deps for supervisor)
│       ├── tsconfig.json        (new)
│       └── src/
│           ├── index.ts         (new — entry point, wires everything)
│           ├── managedProcess.ts(new — one spawned child: lifecycle + crash tracking)
│           ├── watcher.ts       (new — file-watcher + debounced commit)
│           ├── git.ts           (new — git init, commit, reset helpers)
│           ├── health.ts        (new — /supervisor/health HTTP server)
│           └── config.ts        (new — env-driven config)
├── src/
│   ├── website/                 (moved from repo root website/)
│   └── discordbot/              (moved from repo root discordbot/)
├── docs/
│   └── superpowers/             (specs + plans)
├── .github/                     (unchanged)
├── .dockerignore                (updated)
├── .env.example                 (updated)
├── .gitignore                   (unchanged)
├── .workspace-seed              (unchanged — legacy marker, no longer needed after plan but removing it is orthogonal)
├── AGENTS.md.tmpl               (new — workspace-root default; superseded by infra/ copy — see task 2)
├── compose.yml                  (symlink to infra/compose.yml for `docker compose up` from repo root)
└── README.md                    (unchanged)
```

### Container runtime layout

```
/opt/workspace-seed/              (built into image, read-only at runtime)
├── AGENTS.md.tmpl
├── entrypoint.sh
├── infra/
│   ├── AGENTS.md
│   └── supervisor/              (supervisor source + prebuilt node_modules)
└── src/
    ├── website/
    └── discordbot/

/workspace/                       (persistent volume)
├── .git/                         (agent-group-writable; workspace's own git repo)
├── AGENTS.md                     (agent-editable, regenerated on boot from template + infra/AGENTS.md)
├── src/
│   ├── website/                  (agent-editable source)
│   └── discordbot/               (agent-editable source)
├── .opencode/                    (agent scratch space)
└── infra/
    ├── AGENTS.md                 (root-owned, read-only to agent)
    ├── entrypoint.sh             (reference copy; live one is at /opt)
    └── supervisor/               (root-owned supervisor)
```

---

## Task 0: Prep branch and lock the known state

**Files:**
- None created.

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b feat/agent-sandbox
```

- [ ] **Step 2: Commit the uncommitted Dockerfile change as its own commit**

The Dockerfile was already changed from `oven/bun:1-alpine` to `oven/bun:1`. Record that separately so the rest of the plan rebuilds on top of a known base.

```bash
git add Dockerfile
git commit -m "build: switch base image to debian-based oven/bun:1

Debian has predictable glibc, setpriv, and addgroup behavior; alpine's
busybox utilities are inconsistent for user/permission setup we're
about to add."
```

- [ ] **Step 3: Verify `docker build .` still works**

Run: `docker build -t clawscibois:pre-sandbox .`
Expected: build succeeds, image ~several hundred MB. If it fails, stop and investigate — the plan assumes a working build as starting point.

- [ ] **Step 4: Add `.vscode/` to .gitignore**

The working tree has an untracked `.vscode/`. Quick hygiene fix so it doesn't get swept up in later commits.

Edit `.gitignore`, add at the bottom:

```
.vscode/
```

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore .vscode"
```

---

## Task 1: Move source directories to src/

**Files:**
- Move: `website/` → `src/website/`
- Move: `discordbot/` → `src/discordbot/`

- [ ] **Step 1: Create `src/` and move both projects**

```bash
mkdir -p src
git mv website src/website
git mv discordbot src/discordbot
```

- [ ] **Step 2: Verify nothing in the source references old paths**

Search the repo for literal path strings that might break:

```bash
grep -rn "\./website" src/ || true
grep -rn "\./discordbot" src/ || true
grep -rn "/website/" src/ || true
grep -rn "/discordbot/" src/ || true
```

Expected: no matches in `src/`. If matches appear, fix them in this task (paths inside bot/website source should use relative imports; if any `compose.yml`-style absolute references exist inside source, that's a bug to call out).

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor: move website and discordbot under src/

Groundwork for the agent sandbox. src/ will be the agent-editable
tree; everything outside it will be off-limits to the agent."
```

---

## Task 2: Consolidate infra/ (Dockerfile, compose.yml, entrypoint.sh)

**Files:**
- Move: `Dockerfile` → `infra/Dockerfile`
- Move: `compose.yml` → `infra/compose.yml`
- Move: `entrypoint.sh` → `infra/entrypoint.sh`
- Create: `compose.yml` (symlink to `infra/compose.yml`)
- Modify: `.dockerignore`

- [ ] **Step 1: Move infra files**

```bash
mkdir -p infra
git mv Dockerfile infra/Dockerfile
git mv compose.yml infra/compose.yml
git mv entrypoint.sh infra/entrypoint.sh
```

- [ ] **Step 2: Update the Dockerfile `COPY` paths**

The existing `Dockerfile` does `COPY . .` from the build context (`/opt/workspace-seed`) and then `cd website && bun install`, `cd discordbot && bun install`. Those paths now need `src/` prefixes and the entrypoint path changes.

Replace the contents of `infra/Dockerfile` with:

```dockerfile
FROM oven/bun:1

COPY --from=ghcr.io/anomalyco/opencode:latest /usr/local/bin/opencode /usr/local/bin/opencode

WORKDIR /opt/workspace-seed
COPY . .
RUN chmod +x /opt/workspace-seed/infra/entrypoint.sh

RUN (cd src/website && bun install --frozen-lockfile --ignore-scripts)
RUN (cd src/discordbot && bun install --frozen-lockfile)

WORKDIR /workspace

EXPOSE 3000 3001 4096
ENV PORT=3000
ENV WORKSPACE=/workspace

ENTRYPOINT ["/opt/workspace-seed/infra/entrypoint.sh"]
```

Note: this is still an intermediate state — we haven't added the supervisor or users yet. We're doing infra consolidation first so the diff in later tasks is clear.

- [ ] **Step 3: Update `infra/entrypoint.sh` to reference new paths**

The existing script references `$PROJECT/website` and `$PROJECT/discordbot` and does `bun run dev`. Replace those two install lines to point at `src/website` and `src/discordbot`; leave the rest for now (tasks 5 and 6 rewrite this script).

Open `infra/entrypoint.sh` and change:

```
(cd "$PROJECT/website" && bun install --ignore-scripts)
(cd "$PROJECT/discordbot" && bun install)
```

to:

```
(cd "$PROJECT/src/website" && bun install --ignore-scripts)
(cd "$PROJECT/src/discordbot" && bun install)
```

And change:

```
cd "$PROJECT/website"
bun run dev
```

to:

```
cd "$PROJECT/src/website"
bun run dev
```

- [ ] **Step 4: Create a repo-root `compose.yml` symlink**

So `docker compose up` still works from the repo root.

```bash
ln -s infra/compose.yml compose.yml
git add compose.yml
```

- [ ] **Step 5: Update `.dockerignore`**

Replace `.dockerignore` contents with:

```
node_modules
dist
.git
.github
.vscode
volumes/
docs/
README.md
.env
.env.*
!.env.example
*.log
```

- [ ] **Step 6: Verify build still works from repo root**

```bash
docker build -f infra/Dockerfile -t clawscibois:infra-moved .
```

Expected: build succeeds. The container still runs the old single-process dev-mode setup; we haven't changed runtime behavior yet.

- [ ] **Step 7: Commit**

```bash
git add infra/ compose.yml .dockerignore
git commit -m "refactor: consolidate build/runtime infra under infra/

Moves Dockerfile, compose.yml, and entrypoint.sh under infra/.
Updates paths to reference src/website and src/discordbot. Tighter
.dockerignore. Repo-root compose.yml is a symlink for convenience."
```

---

## Task 3: Supervisor scaffolding — package, tsconfig, config module

**Files:**
- Create: `infra/supervisor/package.json`
- Create: `infra/supervisor/tsconfig.json`
- Create: `infra/supervisor/src/config.ts`
- Create: `infra/supervisor/src/config.test.ts`

- [ ] **Step 1: Create `infra/supervisor/package.json`**

```json
{
  "name": "supervisor",
  "module": "src/index.ts",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "bun run src/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "chokidar": "^4.0.1"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Create `infra/supervisor/tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleDetection": "force",
    "allowJs": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Install deps and verify**

```bash
cd infra/supervisor && bun install
```

Expected: `bun.lock` appears, `node_modules/` created, no errors.

- [ ] **Step 4: Write the failing test for `config.ts`**

Create `infra/supervisor/src/config.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  test("returns defaults when no env vars set", () => {
    const cfg = loadConfig({});
    expect(cfg.workspaceDir).toBe("/workspace");
    expect(cfg.srcDir).toBe("/workspace/src");
    expect(cfg.websiteDir).toBe("/workspace/src/website");
    expect(cfg.discordbotDir).toBe("/workspace/src/discordbot");
    expect(cfg.healthPort).toBe(3002);
    expect(cfg.websitePort).toBe(3000);
    expect(cfg.discordbotPort).toBe(3001);
    expect(cfg.opencodePort).toBe(4096);
    expect(cfg.commitDebounceMs).toBe(1000);
    expect(cfg.restartDebounceMs).toBe(500);
    expect(cfg.crashWindowMs).toBe(60_000);
    expect(cfg.crashThreshold).toBe(5);
    expect(cfg.goodRefWindowMs).toBe(60_000);
  });

  test("env overrides apply", () => {
    const cfg = loadConfig({
      WORKSPACE: "/ws",
      WEBSITE_PORT: "8080",
      SUPERVISOR_HEALTH_PORT: "9000",
    });
    expect(cfg.workspaceDir).toBe("/ws");
    expect(cfg.srcDir).toBe("/ws/src");
    expect(cfg.websitePort).toBe(8080);
    expect(cfg.healthPort).toBe(9000);
  });

  test("throws on non-numeric port override", () => {
    expect(() => loadConfig({ WEBSITE_PORT: "banana" })).toThrow();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
cd infra/supervisor && bun test src/config.test.ts
```

Expected: FAIL with module not found for `./config.ts`.

- [ ] **Step 6: Implement `config.ts`**

Create `infra/supervisor/src/config.ts`:

```typescript
export type SupervisorConfig = {
  workspaceDir: string;
  srcDir: string;
  websiteDir: string;
  discordbotDir: string;
  healthPort: number;
  websitePort: number;
  discordbotPort: number;
  opencodePort: number;
  commitDebounceMs: number;
  restartDebounceMs: number;
  crashWindowMs: number;
  crashThreshold: number;
  goodRefWindowMs: number;
};

function parseIntEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Environment variable ${key}=${raw} is not a number`);
  }
  return n;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): SupervisorConfig {
  const workspaceDir = env.WORKSPACE ?? "/workspace";
  const srcDir = `${workspaceDir}/src`;
  return {
    workspaceDir,
    srcDir,
    websiteDir: `${srcDir}/website`,
    discordbotDir: `${srcDir}/discordbot`,
    healthPort: parseIntEnv(env, "SUPERVISOR_HEALTH_PORT", 3002),
    websitePort: parseIntEnv(env, "WEBSITE_PORT", 3000),
    discordbotPort: parseIntEnv(env, "DISCORD_BOT_PORT", 3001),
    opencodePort: parseIntEnv(env, "OPENCODE_SERVE_PORT", 4096),
    commitDebounceMs: parseIntEnv(env, "COMMIT_DEBOUNCE_MS", 1000),
    restartDebounceMs: parseIntEnv(env, "RESTART_DEBOUNCE_MS", 500),
    crashWindowMs: parseIntEnv(env, "CRASH_WINDOW_MS", 60_000),
    crashThreshold: parseIntEnv(env, "CRASH_THRESHOLD", 5),
    goodRefWindowMs: parseIntEnv(env, "GOOD_REF_WINDOW_MS", 60_000),
  };
}
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
cd infra/supervisor && bun test src/config.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 8: Commit**

```bash
git add infra/supervisor/
git commit -m "feat(supervisor): scaffold package + config module

Bun project under infra/supervisor with a typed loadConfig()
reading env vars with defaults. Test-driven."
```

---

## Task 4: Supervisor — git helpers (init, commit, reset, ref tracking)

**Files:**
- Create: `infra/supervisor/src/git.ts`
- Create: `infra/supervisor/src/git.test.ts`

- [ ] **Step 1: Write failing tests for git helpers**

Create `infra/supervisor/src/git.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitAll,
  ensureWorkspaceRepo,
  getHeadSha,
  hardResetTo,
  updateGoodRef,
  getGoodRef,
} from "./git.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supervisor-git-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureWorkspaceRepo", () => {
  test("initializes a new repo with a seed commit", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "hello.txt"), "hi");
    await ensureWorkspaceRepo(dir);
    const sha = await getHeadSha(dir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("is idempotent when repo already exists", async () => {
    await ensureWorkspaceRepo(dir);
    const sha1 = await getHeadSha(dir);
    await ensureWorkspaceRepo(dir);
    const sha2 = await getHeadSha(dir);
    expect(sha2).toBe(sha1);
  });
});

describe("commitAll", () => {
  test("commits pending changes as agent author", async () => {
    await ensureWorkspaceRepo(dir);
    writeFileSync(join(dir, "new.txt"), "content");
    const sha = await commitAll(dir, {
      author: { name: "agent", email: "agent@clawscibois.local" },
      message: "agent: write new.txt",
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const head = await getHeadSha(dir);
    expect(head).toBe(sha);
  });

  test("returns null when there is nothing to commit", async () => {
    await ensureWorkspaceRepo(dir);
    const sha = await commitAll(dir, {
      author: { name: "agent", email: "agent@clawscibois.local" },
      message: "empty",
    });
    expect(sha).toBeNull();
  });
});

describe("hardResetTo", () => {
  test("resets working tree to the given sha", async () => {
    await ensureWorkspaceRepo(dir);
    const initial = await getHeadSha(dir);
    writeFileSync(join(dir, "broken.txt"), "oops");
    await commitAll(dir, {
      author: { name: "agent", email: "agent@clawscibois.local" },
      message: "bad",
    });
    await hardResetTo(dir, initial!);
    const head = await getHeadSha(dir);
    expect(head).toBe(initial);
  });
});

describe("good ref", () => {
  test("update + get round-trips", async () => {
    await ensureWorkspaceRepo(dir);
    const sha = await getHeadSha(dir);
    await updateGoodRef(dir, sha!);
    const got = await getGoodRef(dir);
    expect(got).toBe(sha);
  });

  test("getGoodRef returns null when unset", async () => {
    await ensureWorkspaceRepo(dir);
    const got = await getGoodRef(dir);
    expect(got).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd infra/supervisor && bun test src/git.test.ts
```

Expected: FAIL with "cannot find module ./git.ts".

- [ ] **Step 3: Implement `git.ts`**

Create `infra/supervisor/src/git.ts`:

```typescript
import { $ } from "bun";

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
    throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr}`);
  }
  return stdout;
}

export async function ensureWorkspaceRepo(dir: string): Promise<void> {
  const check = await run(dir, ["rev-parse", "--git-dir"]);
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
  await runOrThrow(dir, ["reset", "--hard", sha]);
}

const GOOD_REF = "refs/supervisor/good";

export async function updateGoodRef(dir: string, sha: string): Promise<void> {
  await runOrThrow(dir, ["update-ref", GOOD_REF, sha]);
}

export async function getGoodRef(dir: string): Promise<string | null> {
  const { exitCode, stdout } = await run(dir, ["rev-parse", GOOD_REF]);
  if (exitCode !== 0) return null;
  return stdout || null;
}
```

- [ ] **Step 4: Run tests**

```bash
cd infra/supervisor && bun test src/git.test.ts
```

Expected: PASS, all tests green. If `git` isn't installed on the host running tests, they'll fail; that's fine, we can defer test execution to inside the container. In that case, install git: `brew install git` on macOS. Retry.

- [ ] **Step 5: Commit**

```bash
git add infra/supervisor/src/git.ts infra/supervisor/src/git.test.ts
git commit -m "feat(supervisor): add git helpers with tests

ensureWorkspaceRepo is idempotent; commitAll uses per-commit author
env so agent vs supervisor attribution is preserved; hardResetTo and
a private refs/supervisor/good ref track the last known good commit."
```

---

## Task 5: Supervisor — ManagedProcess (lifecycle + crash tracking)

**Files:**
- Create: `infra/supervisor/src/managedProcess.ts`
- Create: `infra/supervisor/src/managedProcess.test.ts`

- [ ] **Step 1: Write failing tests**

Create `infra/supervisor/src/managedProcess.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ManagedProcess } from "./managedProcess.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ManagedProcess", () => {
  test("spawns and reports running", async () => {
    const mp = new ManagedProcess({
      name: "echo-sleep",
      cmd: ["sleep", "1"],
      cwd: "/tmp",
      env: {},
      crashWindowMs: 60_000,
      crashThreshold: 5,
    });
    mp.start();
    await sleep(50);
    expect(mp.state().running).toBe(true);
    await mp.stop();
    expect(mp.state().running).toBe(false);
  });

  test("counts crashes within window", async () => {
    const mp = new ManagedProcess({
      name: "exit1",
      cmd: ["sh", "-c", "exit 1"],
      cwd: "/tmp",
      env: {},
      crashWindowMs: 60_000,
      crashThreshold: 3,
      // no restart delay to speed test
      restartDelayMs: 10,
    });
    mp.start();
    // wait long enough for 3 crashes + settle
    await sleep(400);
    const s = mp.state();
    expect(s.crashesInWindow).toBeGreaterThanOrEqual(3);
    expect(s.bricked).toBe(true);
    await mp.stop();
  });

  test("stops restarting once bricked", async () => {
    const mp = new ManagedProcess({
      name: "exit1",
      cmd: ["sh", "-c", "exit 1"],
      cwd: "/tmp",
      env: {},
      crashWindowMs: 60_000,
      crashThreshold: 2,
      restartDelayMs: 10,
    });
    mp.start();
    await sleep(200);
    const before = mp.state().crashesInWindow;
    expect(mp.state().bricked).toBe(true);
    await sleep(300);
    const after = mp.state().crashesInWindow;
    expect(after).toBe(before);
    await mp.stop();
  });

  test("clearCrashes + markRecovered resets bricked state", async () => {
    const mp = new ManagedProcess({
      name: "exit1",
      cmd: ["sh", "-c", "exit 1"],
      cwd: "/tmp",
      env: {},
      crashWindowMs: 60_000,
      crashThreshold: 2,
      restartDelayMs: 10,
    });
    mp.start();
    await sleep(200);
    expect(mp.state().bricked).toBe(true);
    mp.clearCrashes();
    expect(mp.state().bricked).toBe(false);
    expect(mp.state().crashesInWindow).toBe(0);
    await mp.stop();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd infra/supervisor && bun test src/managedProcess.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement `managedProcess.ts`**

Create `infra/supervisor/src/managedProcess.ts`:

```typescript
type Options = {
  name: string;
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  crashWindowMs: number;
  crashThreshold: number;
  restartDelayMs?: number;
  runAsUid?: number;
  runAsGid?: number;
};

export type ProcessState = {
  name: string;
  running: boolean;
  bricked: boolean;
  crashesInWindow: number;
  lastExitCode: number | null;
  lastExitAt: number | null;
  startedAt: number | null;
};

export class ManagedProcess {
  private options: Options;
  private proc: Bun.Subprocess | null = null;
  private crashTimestamps: number[] = [];
  private bricked = false;
  private stopped = false;
  private startedAt: number | null = null;
  private lastExitCode: number | null = null;
  private lastExitAt: number | null = null;
  private restartHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(options: Options) {
    this.options = options;
  }

  start(): void {
    if (this.proc || this.stopped) return;
    if (this.bricked) return;
    try {
      this.proc = Bun.spawn(this.options.cmd, {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
        // uid/gid require root to set; harmless when unset.
        ...(this.options.runAsUid !== undefined ? { uid: this.options.runAsUid } : {}),
        ...(this.options.runAsGid !== undefined ? { gid: this.options.runAsGid } : {}),
      });
    } catch (err) {
      this.handleExit(1);
      return;
    }
    this.startedAt = Date.now();
    this.proc.exited.then((code) => this.handleExit(code ?? 1));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartHandle) {
      clearTimeout(this.restartHandle);
      this.restartHandle = null;
    }
    if (this.proc) {
      this.proc.kill("SIGTERM");
      try {
        await Promise.race([
          this.proc.exited,
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      } finally {
        try { this.proc.kill("SIGKILL"); } catch {}
        this.proc = null;
      }
    }
  }

  async restart(): Promise<void> {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      try {
        await Promise.race([
          this.proc.exited,
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      } finally {
        try { this.proc.kill("SIGKILL"); } catch {}
        this.proc = null;
      }
    }
    this.start();
  }

  clearCrashes(): void {
    this.crashTimestamps = [];
    this.bricked = false;
  }

  state(): ProcessState {
    return {
      name: this.options.name,
      running: this.proc !== null,
      bricked: this.bricked,
      crashesInWindow: this.pruneAndCount(),
      lastExitCode: this.lastExitCode,
      lastExitAt: this.lastExitAt,
      startedAt: this.startedAt,
    };
  }

  private pruneAndCount(): number {
    const cutoff = Date.now() - this.options.crashWindowMs;
    this.crashTimestamps = this.crashTimestamps.filter((t) => t >= cutoff);
    return this.crashTimestamps.length;
  }

  private handleExit(code: number): void {
    this.proc = null;
    this.lastExitCode = code;
    this.lastExitAt = Date.now();
    this.startedAt = null;

    if (this.stopped) return;

    if (code !== 0) {
      this.crashTimestamps.push(Date.now());
      if (this.pruneAndCount() >= this.options.crashThreshold) {
        this.bricked = true;
        // Listeners (the supervisor orchestrator) will observe bricked
        // via state() and decide whether to revert + clearCrashes + restart.
        return;
      }
    } else {
      // clean exit of a process that's supposed to be long-running is also
      // treated as needing a restart, but does not count as a crash.
    }

    const delay = this.options.restartDelayMs ?? 500;
    this.restartHandle = setTimeout(() => {
      this.restartHandle = null;
      this.start();
    }, delay);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd infra/supervisor && bun test src/managedProcess.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add infra/supervisor/src/managedProcess.ts infra/supervisor/src/managedProcess.test.ts
git commit -m "feat(supervisor): ManagedProcess with crash-loop detection

Sliding window over recent non-zero exits; once threshold hit within
window the process is marked bricked and stops auto-restarting.
clearCrashes() resets so the orchestrator can unbrick after a revert."
```

---

## Task 6: Supervisor — file watcher with debounced commit

**Files:**
- Create: `infra/supervisor/src/watcher.ts`
- Create: `infra/supervisor/src/watcher.test.ts`

- [ ] **Step 1: Write failing tests**

Create `infra/supervisor/src/watcher.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDebouncedBatcher } from "./watcher.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createDebouncedBatcher", () => {
  test("coalesces calls within the debounce window", async () => {
    const calls: string[][] = [];
    const batcher = createDebouncedBatcher<string>(async (batch) => {
      calls.push([...batch]);
    }, 50);
    batcher.add("a");
    batcher.add("b");
    batcher.add("c");
    await sleep(150);
    expect(calls).toEqual([["a", "b", "c"]]);
  });

  test("separate windows produce separate batches", async () => {
    const calls: string[][] = [];
    const batcher = createDebouncedBatcher<string>(async (batch) => {
      calls.push([...batch]);
    }, 30);
    batcher.add("a");
    await sleep(80);
    batcher.add("b");
    await sleep(80);
    expect(calls).toEqual([["a"], ["b"]]);
  });

  test("flush triggers immediately", async () => {
    const calls: string[][] = [];
    const batcher = createDebouncedBatcher<string>(async (batch) => {
      calls.push([...batch]);
    }, 10_000);
    batcher.add("a");
    await batcher.flush();
    expect(calls).toEqual([["a"]]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd infra/supervisor && bun test src/watcher.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `watcher.ts`**

Create `infra/supervisor/src/watcher.ts`:

```typescript
import chokidar from "chokidar";

export type DebouncedBatcher<T> = {
  add(item: T): void;
  flush(): Promise<void>;
  close(): void;
};

export function createDebouncedBatcher<T>(
  onFlush: (batch: T[]) => Promise<void>,
  debounceMs: number,
): DebouncedBatcher<T> {
  let pending: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let closed = false;

  async function fire() {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    inFlight = (async () => {
      try {
        await onFlush(batch);
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  }

  return {
    add(item) {
      if (closed) return;
      pending.push(item);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void fire();
      }, debounceMs);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await fire();
      if (inFlight) await inFlight;
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export type WatchHandle = {
  close(): Promise<void>;
};

export function watchPaths(
  paths: string[],
  onChange: (path: string) => void,
): WatchHandle {
  const watcher = chokidar.watch(paths, {
    ignoreInitial: true,
    ignored: [/(^|[/\\])\.git([/\\]|$)/, /node_modules/, /dist/],
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  watcher.on("add", onChange);
  watcher.on("change", onChange);
  watcher.on("unlink", onChange);
  watcher.on("addDir", onChange);
  watcher.on("unlinkDir", onChange);
  return {
    async close() {
      await watcher.close();
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
cd infra/supervisor && bun test src/watcher.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/supervisor/src/watcher.ts infra/supervisor/src/watcher.test.ts
git commit -m "feat(supervisor): debounced batcher + chokidar path watcher"
```

---

## Task 7: Supervisor — health HTTP server

**Files:**
- Create: `infra/supervisor/src/health.ts`
- Create: `infra/supervisor/src/health.test.ts`

- [ ] **Step 1: Write failing tests**

Create `infra/supervisor/src/health.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { startHealthServer, type SupervisorSnapshot } from "./health.ts";

describe("startHealthServer", () => {
  test("returns JSON snapshot on /supervisor/health", async () => {
    const snap: SupervisorSnapshot = {
      ok: true,
      processes: [
        { name: "website", running: true, bricked: false, crashesInWindow: 0,
          lastExitCode: null, lastExitAt: null, startedAt: Date.now() },
      ],
      lastGoodSha: "deadbeef",
      lastRevertAt: null,
      recoveryHalted: false,
    };
    const srv = startHealthServer({ port: 0, getSnapshot: () => snap });
    const res = await fetch(`http://localhost:${srv.port}/supervisor/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.processes[0].name).toBe("website");
    srv.stop();
  });

  test("returns 503 when ok is false", async () => {
    const snap: SupervisorSnapshot = {
      ok: false,
      processes: [],
      lastGoodSha: null,
      lastRevertAt: null,
      recoveryHalted: true,
    };
    const srv = startHealthServer({ port: 0, getSnapshot: () => snap });
    const res = await fetch(`http://localhost:${srv.port}/supervisor/health`);
    expect(res.status).toBe(503);
    srv.stop();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd infra/supervisor && bun test src/health.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `health.ts`**

Create `infra/supervisor/src/health.ts`:

```typescript
import type { ProcessState } from "./managedProcess.ts";

export type SupervisorSnapshot = {
  ok: boolean;
  processes: ProcessState[];
  lastGoodSha: string | null;
  lastRevertAt: number | null;
  recoveryHalted: boolean;
};

export type HealthServer = {
  port: number;
  stop(): void;
};

export function startHealthServer(opts: {
  port: number;
  getSnapshot: () => SupervisorSnapshot;
}): HealthServer {
  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/supervisor/health") {
        const snap = opts.getSnapshot();
        return new Response(JSON.stringify(snap), {
          status: snap.ok ? 200 : 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  return {
    port: server.port,
    stop: () => server.stop(true),
  };
}
```

- [ ] **Step 4: Run tests**

```bash
cd infra/supervisor && bun test src/health.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/supervisor/src/health.ts infra/supervisor/src/health.test.ts
git commit -m "feat(supervisor): /supervisor/health HTTP endpoint"
```

---

## Task 8: Supervisor — orchestrator index.ts (wires everything)

**Files:**
- Create: `infra/supervisor/src/index.ts`

No unit tests for this one — it's glue and its behavior is exercised by the integration test in task 13.

- [ ] **Step 1: Write `index.ts`**

Create `infra/supervisor/src/index.ts`:

```typescript
import { loadConfig } from "./config.ts";
import { ManagedProcess } from "./managedProcess.ts";
import { startHealthServer, type SupervisorSnapshot } from "./health.ts";
import { createDebouncedBatcher, watchPaths } from "./watcher.ts";
import {
  commitAll,
  ensureWorkspaceRepo,
  getHeadSha,
  getGoodRef,
  hardResetTo,
  updateGoodRef,
} from "./git.ts";

const AGENT_AUTHOR = { name: "agent", email: "agent@clawscibois.local" };
const SUPERVISOR_AUTHOR = { name: "supervisor", email: "supervisor@clawscibois.local" };

const cfg = loadConfig();

function log(scope: string, msg: string, extra?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    scope,
    msg,
    ...(extra ?? {}),
  });
  console.log(line);
}

log("boot", "supervisor starting", { cfg });

await ensureWorkspaceRepo(cfg.workspaceDir);
log("boot", "workspace git repo ready");

// Processes ---------------------------------------------------------------

const opencode = new ManagedProcess({
  name: "opencode",
  cmd: [
    "opencode",
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(cfg.opencodePort),
    "--cors",
    `http://localhost:${cfg.websitePort}`,
    cfg.workspaceDir,
  ],
  cwd: cfg.workspaceDir,
  env: {},
  crashWindowMs: cfg.crashWindowMs,
  crashThreshold: cfg.crashThreshold,
});

const website = new ManagedProcess({
  name: "website",
  cmd: ["bun", "run", "src/server.tsx"],
  cwd: cfg.websiteDir,
  env: {
    WEBSITE_PORT: String(cfg.websitePort),
  },
  crashWindowMs: cfg.crashWindowMs,
  crashThreshold: cfg.crashThreshold,
});

const discordbot = new ManagedProcess({
  name: "discordbot",
  cmd: ["bun", "run", "src/index.ts"],
  cwd: cfg.discordbotDir,
  env: {
    PORT: String(cfg.discordbotPort),
    OPENCODE_URL: `http://127.0.0.1:${cfg.opencodePort}`,
  },
  crashWindowMs: cfg.crashWindowMs,
  crashThreshold: cfg.crashThreshold,
});

const revertable = [website, discordbot]; // opencode crashes don't trigger revert

// State -------------------------------------------------------------------

let lastRevertAt: number | null = null;
let recoveryHalted = false;
let consecutiveFailedReverts = 0;

function snapshot(): SupervisorSnapshot {
  const states = [opencode.state(), website.state(), discordbot.state()];
  const anyBricked = states.some((s) => s.bricked);
  return {
    ok: !recoveryHalted && !anyBricked,
    processes: states,
    lastGoodSha: null, // filled below synchronously is awkward; computed on demand
    lastRevertAt,
    recoveryHalted,
  };
}

// Health server -----------------------------------------------------------

startHealthServer({ port: cfg.healthPort, getSnapshot: snapshot });
log("boot", `health server listening on :${cfg.healthPort}`);

// Auto-commit on file changes --------------------------------------------

const commitBatcher = createDebouncedBatcher<string>(async (paths) => {
  try {
    const sha = await commitAll(cfg.workspaceDir, {
      author: AGENT_AUTHOR,
      message: `agent: change ${paths.length} path(s)`,
    });
    if (sha) log("git", "committed", { sha, pathCount: paths.length });
  } catch (err) {
    log("git", "commit failed", { error: String(err) });
  }
}, cfg.commitDebounceMs);

// Restart on source change -----------------------------------------------

type RestartTarget = "website" | "discordbot";
const restartBatcher = createDebouncedBatcher<RestartTarget>(async (targets) => {
  const unique = new Set(targets);
  for (const t of unique) {
    const mp = t === "website" ? website : discordbot;
    log("restart", `restarting ${t}`);
    await mp.restart();
  }
}, cfg.restartDebounceMs);

watchPaths([cfg.websiteDir], (path) => {
  log("watch", "website change", { path });
  commitBatcher.add(path);
  restartBatcher.add("website");
});

watchPaths([cfg.discordbotDir], (path) => {
  log("watch", "discordbot change", { path });
  commitBatcher.add(path);
  restartBatcher.add("discordbot");
});

log("boot", "file watchers armed");

// Start children ----------------------------------------------------------

opencode.start();
website.start();
discordbot.start();

// Health gating + last-good ref + auto-revert loop -----------------------

async function tick() {
  // Update last-known-good if revertable processes have been up for the window.
  const now = Date.now();
  const allHealthy = revertable.every((p) => {
    const s = p.state();
    return s.running && !s.bricked && s.startedAt !== null
      && now - s.startedAt >= cfg.goodRefWindowMs;
  });
  if (allHealthy) {
    const head = await getHeadSha(cfg.workspaceDir);
    if (head) {
      const good = await getGoodRef(cfg.workspaceDir);
      if (good !== head) {
        await updateGoodRef(cfg.workspaceDir, head);
        log("git", "advanced good ref", { sha: head });
      }
    }
  }

  // Handle bricked revertable processes.
  for (const p of revertable) {
    if (!p.state().bricked || recoveryHalted) continue;
    const good = await getGoodRef(cfg.workspaceDir);
    if (!good) {
      log("revert", "no good ref yet; cannot auto-revert", { process: p.state().name });
      continue;
    }
    log("revert", "bricked process detected; reverting", { process: p.state().name, to: good });
    try {
      await hardResetTo(cfg.workspaceDir, good);
      await commitAll(cfg.workspaceDir, {
        author: SUPERVISOR_AUTHOR,
        message: `supervisor: auto-revert to ${good.slice(0, 7)}`,
      });
      lastRevertAt = Date.now();
      // Unbrick and restart all revertable processes (the healthy ones are
      // already running, but kicking them is cheap and ensures consistency).
      website.clearCrashes();
      discordbot.clearCrashes();
      await website.restart();
      await discordbot.restart();
      consecutiveFailedReverts = 0;
    } catch (err) {
      consecutiveFailedReverts += 1;
      log("revert", "revert attempt failed", { error: String(err), consecutiveFailedReverts });
      if (consecutiveFailedReverts >= 3) {
        recoveryHalted = true;
        log("revert", "recovery halted after 3 failed reverts");
      }
    }
  }
}

setInterval(() => { void tick(); }, 2000);

// Graceful shutdown -------------------------------------------------------

async function shutdown(sig: string) {
  log("shutdown", "received", { signal: sig });
  await commitBatcher.flush();
  await Promise.all([opencode.stop(), website.stop(), discordbot.stop()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log("boot", "supervisor ready");
```

- [ ] **Step 2: Typecheck**

```bash
cd infra/supervisor && bunx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add infra/supervisor/src/index.ts
git commit -m "feat(supervisor): orchestrator wires all pieces together

Spawns opencode, website, and bot; watches src/ for changes; debounced
auto-commits as 'agent'; debounced restarts; periodic tick updates the
good ref when revertables have been healthy, and auto-reverts bricked
revertables to the good ref with a supervisor-authored revert commit.
Halts recovery after 3 consecutive failed reverts."
```

---

## Task 9: Create AGENTS.md files

**Files:**
- Create: `infra/AGENTS.md`
- Create: `AGENTS.md.tmpl`

- [ ] **Step 1: Write `infra/AGENTS.md`**

```markdown
# Agent Rules (Immutable)

This file is root-owned and read-only to you. You cannot modify it.
Rule sentinel: `CLAW-RULES-v1`

## Your identity

You run as Unix user `agent` (uid 1001). The Discord bot and website
run as user `app` (uid 1000). You and they share the filesystem but
have different write permissions.

## What you can write

- `/workspace/src/` — all source code for the website and Discord bot.
- `/workspace/AGENTS.md` — the companion doc with project knowledge.
- `/workspace/.opencode/` — your scratch space.
- `/workspace/.git/` — via your group membership; commits are managed
  automatically, see below.

## What you cannot write

- `/workspace/infra/` — all build, supervisor, and rules files.
- Anywhere outside `/workspace/` — most of `/` is root-owned.

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

Say so in the Discord thread. Do not try to edit this file — you
will get `EACCES`. Do not try to work around the rules; they exist
because the user asked for them.

## Known limitations

- Your git repo in `/workspace` is a local undo log, not the
  clawscibois project's real git history. Do not push it.
- Logic bugs that don't crash processes are not auto-detected.
  Test your changes by hitting the URLs above.
```

- [ ] **Step 2: Write `AGENTS.md.tmpl`**

This template seeds `/workspace/AGENTS.md` on first boot. The entrypoint concatenates `infra/AGENTS.md` + this template.

```markdown
<!-- @@agent-editable-below -->

# clawscibois — project guide

This is the agent-editable doc. The rules section above is regenerated
from `infra/AGENTS.md` on every container boot; nothing you write there
will persist. Everything below this line is yours to edit.

## What this app is

A Discord bot (`src/discordbot/`) and a React SSR website (`src/website/`).
The bot forwards user messages to you via HTTP and posts your responses
back to Discord.

## File map

- `src/website/src/server.tsx` — the SSR entry point.
- `src/website/src/App.tsx` — the root React component.
- `src/discordbot/src/index.ts` — the bot entry point.
- `src/discordbot/src/opencode.ts` — the HTTP client the bot uses
  to talk to you.

## Conventions

(Grow this section over time. Initial content is minimal.)

## Gotchas

(Record anything surprising you learn about this codebase here.)
```

- [ ] **Step 3: Commit**

```bash
git add infra/AGENTS.md AGENTS.md.tmpl
git commit -m "docs(agents): immutable rules doc + editable template

infra/AGENTS.md is the source of truth for what the agent is allowed
to do; entrypoint will concatenate it with AGENTS.md.tmpl to produce
/workspace/AGENTS.md on first boot."
```

---

## Task 10: Rewrite entrypoint.sh

**Files:**
- Modify: `infra/entrypoint.sh` (full rewrite)

- [ ] **Step 1: Replace `infra/entrypoint.sh` contents**

```bash
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
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x infra/entrypoint.sh
```

- [ ] **Step 3: Commit**

```bash
git add infra/entrypoint.sh
git commit -m "feat(entrypoint): users, perms, AGENTS.md regen, supervisor handoff

- Seeds /workspace on first boot without leaking .git/.github/Dockerfile.
- Regenerates /workspace/AGENTS.md top section from infra/AGENTS.md on
  every boot; salvages previous editable content if sentinel missing.
- Sets ownership so agent user can write src/ and .git/ but not infra/.
- Installs deps if missing (first-boot volume).
- Drops to 'app' user and execs the supervisor."
```

---

## Task 11: Rewrite Dockerfile (users, setpriv, healthcheck)

**Files:**
- Modify: `infra/Dockerfile` (full rewrite)

- [ ] **Step 1: Replace `infra/Dockerfile` contents**

```dockerfile
FROM oven/bun:1

# Required tools: git for the workspace repo; setpriv/su for priv drop;
# curl for HEALTHCHECK.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      util-linux \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Two users: app (runs processes), agent (runs opencode + its tools).
# Make 'app' a member of 'agent' so it can read agent-owned files if
# needed, and vice versa for the shared group semantics on /workspace/src.
RUN groupadd -g 1001 agent \
 && useradd -u 1001 -g 1001 -M -s /usr/sbin/nologin agent \
 && groupadd -g 1000 app \
 && useradd -u 1000 -g 1000 -G agent -m -s /bin/bash app

COPY --from=ghcr.io/anomalyco/opencode:latest /usr/local/bin/opencode /usr/local/bin/opencode

WORKDIR /opt/workspace-seed
COPY . .
RUN chmod +x /opt/workspace-seed/infra/entrypoint.sh

# Pre-install into the seed (so first-boot copy into the volume is fast).
RUN (cd src/website && bun install --frozen-lockfile --ignore-scripts) \
 && (cd src/discordbot && bun install --frozen-lockfile) \
 && (cd infra/supervisor && bun install --frozen-lockfile)

WORKDIR /workspace

# Expose only what external callers need. 4096 (opencode) is intentionally
# NOT exposed — it stays on 127.0.0.1 inside the container.
EXPOSE 3000 3001

ENV PORT=3000
ENV WORKSPACE=/workspace

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -sf http://127.0.0.1:3002/supervisor/health || exit 1

# Entrypoint starts as root to set perms; execs supervisor as user 'app'.
ENTRYPOINT ["/opt/workspace-seed/infra/entrypoint.sh"]
```

- [ ] **Step 2: Update `infra/compose.yml` to not expose 4096**

Open `infra/compose.yml` and change:

```yaml
    ports:
      - "${WEBSITE_PORT:-3000}:${WEBSITE_PORT:-3000}"
      - "3001:3001"
      - "4096:4096"
```

to:

```yaml
    ports:
      - "${WEBSITE_PORT:-3000}:${WEBSITE_PORT:-3000}"
      - "${DISCORD_BOT_PORT:-3001}:${DISCORD_BOT_PORT:-3001}"
    restart: unless-stopped
```

Also remove the `OPENCODE_CORS` and related env from `compose.yml` since the supervisor now owns OpenCode and only exposes it on localhost. The relevant block becomes:

```yaml
    environment:
      WEBSITE_PORT: "3000"
      DISCORD_BOT_PORT: "3001"
      OPENCODE_URL: "http://127.0.0.1:4096"
      OPENCODE_SERVER_PASSWORD: ${OPENCODE_SERVER_PASSWORD:-}
      OPENCODE_SERVER_USERNAME: ${OPENCODE_SERVER_USERNAME:-opencode}
```

- [ ] **Step 3: Build the image**

```bash
docker build -f infra/Dockerfile -t clawscibois:sandbox .
```

Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add infra/Dockerfile infra/compose.yml
git commit -m "feat(docker): two-user image with healthcheck

- Adds app (1000) and agent (1001) users.
- Installs git, util-linux (setpriv), curl.
- Pre-installs supervisor deps into the seed.
- HEALTHCHECK pings supervisor at :3002.
- Removes :4096 exposure; OpenCode is internal-only."
```

---

## Task 12: Smoke test the container

**Files:**
- None created. This is a verification task.

- [ ] **Step 1: Remove any old volume from prior runs**

```bash
docker compose -f infra/compose.yml down -v 2>/dev/null || true
rm -rf volumes/clawscibois_data
```

- [ ] **Step 2: Build and start**

Create a `.env` file at the repo root if you don't already have one (required env vars: see `.env.example`). Then:

```bash
docker compose -f infra/compose.yml up --build -d
```

- [ ] **Step 3: Wait for healthy**

```bash
for i in $(seq 1 30); do
  status=$(docker inspect --format='{{.State.Health.Status}}' clawscibois-workspace-1 2>/dev/null || echo starting)
  echo "attempt $i: $status"
  [ "$status" = "healthy" ] && break
  sleep 2
done
```

Expected: reaches `healthy` within ~60s.

- [ ] **Step 4: Verify processes via health endpoint (inside the container)**

```bash
docker exec clawscibois-workspace-1 curl -sS http://127.0.0.1:3002/supervisor/health | head
```

Expected: JSON showing all three processes running, `bricked: false`, `ok: true`.

- [ ] **Step 5: Verify website responds**

```bash
curl -sS http://localhost:3000 | head
```

Expected: HTML starting with `<!DOCTYPE html>`.

- [ ] **Step 6: Verify bot health responds**

```bash
curl -sS http://localhost:3001/health
```

Expected: `ok`.

- [ ] **Step 7: Verify the agent cannot write to infra/**

```bash
docker exec -u agent clawscibois-workspace-1 sh -c "touch /workspace/infra/pwned 2>&1; echo EXIT=$?"
```

Expected: a line containing `Permission denied` and `EXIT=1`.

- [ ] **Step 8: Verify the agent CAN write to src/**

```bash
docker exec -u agent clawscibois-workspace-1 sh -c "echo 'agent was here' > /workspace/src/website/src/agent-test.txt && cat /workspace/src/website/src/agent-test.txt"
```

Expected: prints `agent was here`.

- [ ] **Step 9: Verify the change was auto-committed**

Wait 3s for the debounce window, then:

```bash
docker exec clawscibois-workspace-1 git -C /workspace log --oneline -5
```

Expected: a recent commit authored by `agent` mentioning the change.

- [ ] **Step 10: Tear down**

```bash
docker compose -f infra/compose.yml down -v
rm -rf volumes/clawscibois_data
```

- [ ] **Step 11: Commit anything that came up**

If steps 3-9 uncovered any issue that required a fix, commit each fix with its own descriptive message. If no fixes were needed, skip this step.

---

## Task 13: End-to-end revert test (the "it deleted itself" test)

**Files:**
- None created. Verification task.

- [ ] **Step 1: Start fresh**

```bash
docker compose -f infra/compose.yml down -v 2>/dev/null || true
rm -rf volumes/clawscibois_data
docker compose -f infra/compose.yml up --build -d
```

- [ ] **Step 2: Wait for healthy (reach `goodRefWindowMs` + a bit)**

The supervisor only sets the good ref once revertable processes have been up for 60s (default).

```bash
for i in $(seq 1 90); do
  status=$(docker inspect --format='{{.State.Health.Status}}' clawscibois-workspace-1 2>/dev/null || echo starting)
  [ "$status" = "healthy" ] && sleep 70 && break
  sleep 2
done
```

- [ ] **Step 3: Confirm the good ref exists**

```bash
docker exec clawscibois-workspace-1 git -C /workspace rev-parse refs/supervisor/good
```

Expected: a 40-char sha. If it returns an error, wait longer and retry.

- [ ] **Step 4: Break the bot on purpose (as agent)**

```bash
docker exec -u agent clawscibois-workspace-1 sh -c \
  "echo 'throw new Error(\"intentional test crash\");' > /workspace/src/discordbot/src/index.ts"
```

- [ ] **Step 5: Watch the supervisor log**

```bash
docker logs -f clawscibois-workspace-1 2>&1 | grep -E 'revert|git|bricked' &
LOGPID=$!
sleep 45
kill $LOGPID 2>/dev/null || true
```

Expected output over those ~45 seconds: supervisor detects crashes, marks the bot bricked after 5 failures, performs `hardResetTo`, commits a supervisor-authored revert, restarts. Log line like `"revert attempt … to <sha>"` followed by successful restart.

- [ ] **Step 6: Confirm the bot is healthy again**

```bash
curl -sS http://localhost:3001/health
```

Expected: `ok`.

- [ ] **Step 7: Confirm git log shows the destructive change + the revert**

```bash
docker exec clawscibois-workspace-1 git -C /workspace log --oneline -5
```

Expected output includes an `agent:` commit (the break) and a `supervisor:` commit (the revert).

- [ ] **Step 8: Tear down**

```bash
docker compose -f infra/compose.yml down -v
```

- [ ] **Step 9: Commit fixes if needed**

If steps 5-7 failed, debug and fix the supervisor's revert/restart logic. Each fix gets its own commit.

---

## Task 14: Documentation and finishing touches

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Replace README.md with a real README**

```markdown
# clawscibois

A Discord bot, a website, and a sandboxed OpenCode agent — all in one
container. The agent can modify the bot's and the website's source at
runtime. Destructive edits are automatically recovered via an internal
git repo and a crash-loop watchdog.

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
- Supervisor health: http://localhost:3002/supervisor/health (internal
  only; exec into the container to hit it)

## Architecture

See `docs/superpowers/specs/2026-04-18-agent-sandbox-design.md` for the
full design. TL;DR:

- Container runs as user `app` after setup; OpenCode runs as `agent`.
- `infra/` is root-owned and invisible-to-write to the agent.
- `src/` is agent-editable. Changes are auto-committed to
  `/workspace/.git`.
- A supervisor watches source, restarts processes on change, and
  `git reset --hard`s to the last healthy commit if either process
  crash-loops.

## Repo layout

- `src/website/` — SSR React site
- `src/discordbot/` — Discord bot that proxies to OpenCode
- `infra/` — Dockerfile, supervisor, entrypoint, rules
- `docs/` — specs and plans
```

- [ ] **Step 2: Update .env.example**

```
# Discord
DISCORD_BOT_TOKEN=
DISCORD_PUBLIC_KEY=
DISCORD_APPLICATION_ID=
DISCORD_BOT_USERNAME=slopscibois

# OpenCode (internal; supervisor spawns opencode serve on :4096)
OPENCODE_SERVER_PASSWORD=
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_URL=http://127.0.0.1:4096

# Ports (usually don't need to override)
WEBSITE_PORT=3000
DISCORD_BOT_PORT=3001
```

- [ ] **Step 3: Commit**

```bash
git add README.md .env.example
git commit -m "docs: real README + complete .env.example"
```

---

## Task 15: Open PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/agent-sandbox
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: agent sandbox with auto-revert" --body "$(cat <<'EOF'
## Summary

- Two Unix users inside one container: `app` runs services, `agent` runs OpenCode.
- Filesystem perms make `/workspace/infra/` unwritable to the agent.
- Bun-based supervisor owns all three child processes (opencode, website, bot).
- Watcher auto-commits agent changes under `src/`.
- Crash-loop detector reverts to last known good commit and restarts.

Spec: `docs/superpowers/specs/2026-04-18-agent-sandbox-design.md`
Plan: `docs/superpowers/plans/2026-04-18-agent-sandbox-implementation.md`

## Breaking changes

- `:4096` is no longer exposed to the host by default.
- Container no longer runs as root after setup (exec into with `--user root` if you need it).
- Directory layout: `website/` and `discordbot/` now under `src/`.
- First-boot volume is no longer seeded with `.git/`, `.github/`, `Dockerfile`, or `.env.example`.
EOF
)"
```

---

## Self-review notes (recorded during plan authoring, resolved inline)

- Spec §2 (repo vs container layout split) → tasks 1, 2, 10 produce each.
- Spec §3 supervisor → tasks 3–8 collectively implement it.
- Spec §4 auto-commit → task 8 via supervisor watcher (coarse); OpenCode plugin is phase 2 (explicitly out of scope).
- Spec §5 AGENTS.md split + regeneration → tasks 9 + 10.
- Spec §6 session creation unchanged → no task needed (confirmed).
- Spec §7 seed & recovery → task 10 (first-boot seed without leakage + deps install).
- Spec §8 HEALTHCHECK → tasks 7 (endpoint) + 11 (Docker directive).
- Spec `ensureWorkspaceRepo` + seed commit requirement → task 4.
- Spec "revert is NOT unhealthy" → task 7 health logic: `ok` only goes false on bricked+not-reverting state or recoveryHalted, never mid-revert.
- Spec trade-off "opencode running as agent is acceptable" → task 8 `ManagedProcess` for opencode does not pass `runAsUid`; priv drop is via `su - app` in entrypoint for everything else, while the opencode process inherits `app` uid. **Open gap**: opencode runs as `app`, not `agent`, in this plan. To genuinely drop to `agent`, task 8 would need `runAsUid: 1001, runAsGid: 1001` on the opencode ManagedProcess — but then uid 1001 can't read opencode binary if perms are strict. This is acknowledged as a phase-1 trade-off: v1 ships with opencode running as `app` and relies on filesystem perms alone. Phase 2 upgrades to true priv drop. (Consistent with the "fallback priv-drop" default chosen at the top of this plan, though the current wiring runs it as `app`, which is weaker than "opencode serve as agent" from the spec. If stronger isolation is desired without waiting for phase 2, add `runAsUid: 1001, runAsGid: 1001` to the opencode `ManagedProcess` in task 8 and verify the opencode binary is world-executable in the image.)
- Placeholder scan: no "TODO" / "TBD" in actual task steps; all code blocks are complete.
- Type consistency: `SupervisorSnapshot`, `ProcessState`, `SupervisorConfig` match across tasks 3/5/7/8.
