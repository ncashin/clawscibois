type Options = {
  name: string;
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  crashWindowMs: number;
  crashThreshold: number;
  restartDelayMs?: number;
  // If set (>0), any exit — even a clean exit code 0 — within this many
  // milliseconds of the most recent start is counted as a crash. This
  // catches pathological states that look like "a long-running service
  // that has decided to exit promptly": for example, if the agent
  // replaces the bot's entry point with `console.log("hi")`, the process
  // exits 0 after ~200ms forever. Without an uptime guard the supervisor
  // never counts these as crashes and never triggers auto-revert.
  //
  // Pick a value longer than the service's normal startup time but short
  // enough that a healthy service clearly crosses it. ~5s is a good
  // default for Bun-based services.
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
        // uid/gid require root to set; harmless when unset.
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
    // Only flag the exit as expected if there's actually a process to kill.
    // Otherwise the flag would leak into a future spawn's handleExit and
    // suppress its crash count (causing the supervisor to zombie the
    // process: running: false, bricked: false, crashesInWindow: 0, forever).
    if (this.proc) this.expectedExit = true;
    await this.killRunningProc();
  }

  async restart(): Promise<void> {
    if (this.stopped) return;
    // See the note in stop(): never set expectedExit unless a kill is
    // actually going to happen.
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
    // Capture uptime before nulling startedAt so the min-uptime guard
    // below can tell whether the process crossed its uptime threshold.
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
      // Deliberate kill from stop() or restart(); don't count as a crash.
      this.expectedExit = false;
      return;
    }

    // Count as a crash if either (a) the process exited non-zero, or
    // (b) a minUptimeMs is configured and the process didn't stay up
    // long enough. The second branch catches "clean exit in a loop"
    // cases the simple non-zero check would miss.
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
