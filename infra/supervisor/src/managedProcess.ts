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
    this.proc = null;
    this.lastExitCode = code;
    this.lastExitAt = Date.now();
    this.startedAt = null;

    if (this.stopped) return;

    if (this.expectedExit) {
      // Deliberate kill from stop() or restart(); don't count as a crash.
      this.expectedExit = false;
      return;
    }

    if (code !== 0) {
      this.crashTimestamps.push(Date.now());
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
