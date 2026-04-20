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
  minUptimeMs: number;
};

function parseIntEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const trimmed = raw.trim();
  if (trimmed === "" || !/^-?\d+$/.test(trimmed)) {
    throw new Error(
      `Environment variable ${key} must be an integer, got: ${JSON.stringify(raw)}`,
    );
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `Environment variable ${key} is out of safe integer range: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): SupervisorConfig {
  const workspaceDir =
    env.WORKSPACE === undefined || env.WORKSPACE === ""
      ? "/workspace"
      : env.WORKSPACE;
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
    commitDebounceMs: parseIntEnv(env, "COMMIT_DEBOUNCE_MS", 3000),
    restartDebounceMs: parseIntEnv(env, "RESTART_DEBOUNCE_MS", 2500),
    crashWindowMs: parseIntEnv(env, "CRASH_WINDOW_MS", 60_000),
    crashThreshold: parseIntEnv(env, "CRASH_THRESHOLD", 5),
    goodRefWindowMs: parseIntEnv(env, "GOOD_REF_WINDOW_MS", 60_000),
    minUptimeMs: parseIntEnv(env, "MIN_UPTIME_MS", 5_000),
  };
}
