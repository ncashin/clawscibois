type Options = {
  name: string;
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  crashWindowMs: number;
  crashThreshold: number;
  restartDelayMs?: number;
  // Any exit within this many ms of the last start counts as a crash,
  // even exit code 0. Catches clean-exit loops (e.g. the agent rewrites
  // index.ts to just `console.log(...)`) that a non-zero check misses.
  // ~5s is a reasonable default for Bun services.
  minUptimeMs?: number;
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
  private expectedExit = false;
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
        // uid/gid require root to set; harmless when undefined.
        ...(this.options.runAsUid !== undefined ? { uid: this.options.runAsUid } : {}),
        ...(this.options.runAsGid !== undefined ? { gid: this.options.runAsGid } : {}),
      });
    } catch {
      this.handleExit(1);
      return;
    }
    this.startedAt = Date.now();
    this.proc.exited.then(
      (code) => this.handleExit(code ?? 1),
      () => this.handleExit(1),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartHandle) {
      clearTimeout(this.restartHandle);
      this.restartHandle = null;
    }
    // Only flag expectedExit when there's actually a process to kill,
    // otherwise the flag leaks into a future spawn's handleExit and
    // silently suppresses its crash. Caused a zombie state in prod:
    // running:false, bricked:false, crashesInWindow:0, forever.
    if (this.proc) this.expectedExit = true;
    await this.killRunningProc();
  }

  async restart(): Promise<void> {
    if (this.stopped) return;
    // Same rule as stop(): don't set the flag unless a kill will happen.
    if (this.proc) this.expectedExit = true;
    await this.killRunningProc();
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

  private async killRunningProc(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    p.kill("SIGTERM");
    try {
      await Promise.race([
        p.exited,
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } finally {
      try { p.kill("SIGKILL"); } catch {}
      if (this.proc === p) this.proc = null;
    }
  }

  private pruneAndCount(): number {
    const cutoff = Date.now() - this.options.crashWindowMs;
    this.crashTimestamps = this.crashTimestamps.filter((t) => t >= cutoff);
    return this.crashTimestamps.length;
  }

  private handleExit(code: number): void {
    // Capture uptime before clearing startedAt so the guard below can use it.
    const exitedAt = Date.now();
    const startedAt = this.startedAt;
    const uptimeMs =
      startedAt !== null ? exitedAt - startedAt : null;

    this.proc = null;
    this.lastExitCode = code;
    this.lastExitAt = exitedAt;
    this.startedAt = null;

    if (this.stopped) return;

    if (this.expectedExit) {
      // Kill from stop()/restart() - not a crash.
      this.expectedExit = false;
      return;
    }

    // Crash if non-zero, or (when configured) if the process failed to
    // stay up past minUptimeMs. The latter catches clean-exit loops.
    const minUptime = this.options.minUptimeMs ?? 0;
    const tooShort =
      minUptime > 0 && uptimeMs !== null && uptimeMs < minUptime;
    if (code !== 0 || tooShort) {
      this.crashTimestamps.push(exitedAt);
      if (this.pruneAndCount() >= this.options.crashThreshold) {
        this.bricked = true;
        return;
      }
    }

    const delay = this.options.restartDelayMs ?? 500;
    this.restartHandle = setTimeout(() => {
      this.restartHandle = null;
      this.start();
    }, delay);
  }
}
