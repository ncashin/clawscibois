import { loadConfig } from "./config.ts";
import { ManagedProcess, type ProcessState } from "./managedProcess.ts";
import { startHealthServer, type SupervisorSnapshot } from "./health.ts";
import {
  createDebouncedBatcher,
  watchPaths,
  type WatchHandle,
} from "./watcher.ts";
import {
  commitAll,
  ensureWorkspaceRepo,
  getGoodRef,
  getHeadSha,
  hardResetTo,
  untrackPath,
  updateGoodRef,
} from "./git.ts";

const AGENT_AUTHOR = { name: "agent", email: "agent@clawscibois.local" };
const SUPERVISOR_AUTHOR = {
  name: "supervisor",
  email: "supervisor@clawscibois.local",
};

const cfg = loadConfig();

function log(
  scope: string,
  msg: string,
  extra?: Record<string, unknown>,
): void {
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

// Self-heal: if a prior image tracked `infra/` (which is root-owned),
// stop tracking it now so future reverts don't fail on unlink permission
// errors when HEAD crosses commits that changed those files.
const prunedInfra = await untrackPath(
  cfg.workspaceDir,
  "infra",
  SUPERVISOR_AUTHOR,
);
if (prunedInfra) {
  log("git", "stopped tracking infra/ (self-heal)");
}

// Processes ---------------------------------------------------------------

// OpenCode is fail-closed: we refuse to start it without a password.
// Rationale: the serve port is exposed beyond localhost (so Traefik can
// route to it). An unauthenticated server on a public hostname would be
// a backdoor into the agent sandbox. We'd rather degrade — bot + website
// keep working, opencode-dependent paths error clearly — than silently
// run an open door.
const opencodePassword = process.env.OPENCODE_SERVER_PASSWORD?.trim() ?? "";
const opencodeUsername =
  process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
const opencodeCors =
  process.env.OPENCODE_CORS?.trim() ||
  `http://localhost:${cfg.websitePort}`;

let opencode: ManagedProcess | null = null;
if (opencodePassword) {
  opencode = new ManagedProcess({
    name: "opencode",
    cmd: [
      "opencode",
      "serve",
      "--hostname",
      "0.0.0.0",
      "--port",
      String(cfg.opencodePort),
      "--cors",
      opencodeCors,
      cfg.workspaceDir,
    ],
    cwd: cfg.workspaceDir,
    env: {
      OPENCODE_SERVER_PASSWORD: opencodePassword,
      OPENCODE_SERVER_USERNAME: opencodeUsername,
    },
    crashWindowMs: cfg.crashWindowMs,
    crashThreshold: cfg.crashThreshold,
  });
} else {
  log("opencode", "refusing to start; OPENCODE_SERVER_PASSWORD is unset", {
    hint: "set OPENCODE_SERVER_PASSWORD in the environment and restart",
  });
}

// Synthetic state for snapshot() when opencode is intentionally absent.
// Marked `bricked: true` so supervisor health reports ok:false — that
// matters for the HEALTHCHECK and for surface visibility: a
// misconfigured deploy should look unhealthy, not "working but lying".
function opencodeState(): ProcessState {
  if (opencode) return opencode.state();
  return {
    name: "opencode",
    running: false,
    bricked: true,
    crashesInWindow: 0,
    lastExitCode: null,
    lastExitAt: null,
    startedAt: null,
  };
}

const website = new ManagedProcess({
  name: "website",
  // Build CSS, then exec the SSR server. `exec` replaces the shell so
  // signals still reach the server directly.
  cmd: ["bash", "-c", "bun run build:css && exec bun run src/server.tsx"],
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

// These are cached so snapshot() can return them synchronously.
let lastGoodSha: string | null = null;
let lastRevertAt: number | null = null;
let recoveryHalted = false;
let consecutiveFailedReverts = 0;

function snapshot(): SupervisorSnapshot {
  const states = [opencodeState(), website.state(), discordbot.state()];
  const anyBricked = states.some((s) => s.bricked);
  return {
    ok: !recoveryHalted && !anyBricked,
    processes: states,
    lastGoodSha,
    lastRevertAt,
    recoveryHalted,
  };
}

// Health server -----------------------------------------------------------

const healthSrv = startHealthServer({
  port: cfg.healthPort,
  getSnapshot: snapshot,
});
log("boot", `health server listening on :${cfg.healthPort}`);

// Auto-commit on file changes --------------------------------------------

const commitBatcher = createDebouncedBatcher<string>(async (paths) => {
  const sha = await commitAll(cfg.workspaceDir, {
    author: AGENT_AUTHOR,
    message: `agent: change ${paths.length} path(s)`,
  });
  if (sha) log("git", "committed", { sha, pathCount: paths.length });
}, cfg.commitDebounceMs, (err) => log("git", "commit failed", { error: String(err) }));

// Restart on source change -----------------------------------------------

type RestartTarget = "website" | "discordbot";
const restartBatcher = createDebouncedBatcher<RestartTarget>(
  async (targets) => {
    const unique = new Set(targets);
    for (const t of unique) {
      const mp = t === "website" ? website : discordbot;
      log("restart", `restarting ${t}`);
      await mp.restart();
    }
  },
  cfg.restartDebounceMs,
  (err) => log("restart", "restart batch failed", { error: String(err) }),
);

const watchers: WatchHandle[] = [];

watchers.push(
  watchPaths([cfg.websiteDir], (path) => {
    log("watch", "website change", { path });
    commitBatcher.add(path);
    restartBatcher.add("website");
  }),
);

watchers.push(
  watchPaths([cfg.discordbotDir], (path) => {
    log("watch", "discordbot change", { path });
    commitBatcher.add(path);
    restartBatcher.add("discordbot");
  }),
);

log("boot", "file watchers armed");

// Start children ----------------------------------------------------------

opencode?.start();
website.start();
discordbot.start();

// Health gating + last-good ref + auto-revert loop -----------------------

async function tick(): Promise<void> {
  // Advance the good ref if revertable processes have been healthy for the window.
  const now = Date.now();
  const allHealthy = revertable.every((p) => {
    const s = p.state();
    return (
      s.running &&
      !s.bricked &&
      s.startedAt !== null &&
      now - s.startedAt >= cfg.goodRefWindowMs
    );
  });
  if (allHealthy) {
    const head = await getHeadSha(cfg.workspaceDir);
    if (head) {
      const good = await getGoodRef(cfg.workspaceDir);
      if (good !== head) {
        await updateGoodRef(cfg.workspaceDir, head);
        lastGoodSha = head;
        log("git", "advanced good ref", { sha: head });
      } else if (lastGoodSha !== good) {
        lastGoodSha = good;
      }
    }
  }

  // Handle a bricked revertable process. We only revert once per tick even if
  // both are bricked — after the first revert+restart, both become unbricked
  // together, so looping would just thrash.
  if (recoveryHalted) return;
  const bricked = revertable.find((p) => p.state().bricked);
  if (!bricked) return;

  const good = await getGoodRef(cfg.workspaceDir);
  if (!good) {
    log("revert", "no good ref yet; cannot auto-revert", {
      target: bricked.state().name,
    });
    return;
  }
  log("revert", "bricked process detected; reverting", {
    target: bricked.state().name,
    to: good,
  });
  try {
    await hardResetTo(cfg.workspaceDir, good);
    // Record the revert event as an explicit supervisor commit so `git log`
    // clearly shows both the agent's bad change and the supervisor's response.
    // --allow-empty because the working tree now matches `good`.
    await commitAll(cfg.workspaceDir, {
      author: SUPERVISOR_AUTHOR,
      message: `supervisor: auto-revert to ${good.slice(0, 7)}`,
      allowEmpty: true,
    });
    lastRevertAt = Date.now();
    for (const p of revertable) {
      p.clearCrashes();
      await p.restart();
    }
    consecutiveFailedReverts = 0;
    log("revert", "revert complete", { to: good });
  } catch (err) {
    consecutiveFailedReverts += 1;
    log("revert", "revert attempt failed", {
      error: String(err),
      consecutiveFailedReverts,
    });
    if (consecutiveFailedReverts >= 3) {
      recoveryHalted = true;
      log("revert", "recovery halted after 3 failed reverts");
    }
  }
}

const tickHandle = setInterval(() => {
  void tick().catch((err) => log("tick", "unhandled error", { error: String(err) }));
}, 2000);

// Graceful shutdown -------------------------------------------------------

let shuttingDown = false;
async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", "received", { signal: sig });
  clearInterval(tickHandle);
  await commitBatcher.flush();
  commitBatcher.close();
  restartBatcher.close();
  await Promise.all(watchers.map((w) => w.close()));
  await Promise.all([
    opencode?.stop() ?? Promise.resolve(),
    website.stop(),
    discordbot.stop(),
  ]);
  healthSrv.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log("boot", "supervisor ready");
