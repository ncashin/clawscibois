import chokidar from "chokidar";

export type DebouncedBatcher<T> = {
  add(item: T): void;
  flush(): Promise<void>;
  close(): void;
};

export function createDebouncedBatcher<T>(
  onFlush: (batch: T[]) => Promise<void>,
  debounceMs: number,
  onError: (err: unknown) => void = (err) =>
    console.error("[batcher] onFlush failed:", err),
): DebouncedBatcher<T> {
  let pending: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let closed = false;

  async function fire(): Promise<void> {
    // Serialize: wait for any in-flight flush to complete before starting a new one.
    // This prevents concurrent onFlush invocations (critical for git commits which
    // hold an index lock).
    if (inFlight) await inFlight;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const p = (async () => {
      try {
        await onFlush(batch);
      } catch (err) {
        onError(err);
      } finally {
        if (inFlight === p) inFlight = null;
      }
    })();
    inFlight = p;
    await p;
  }

  return {
    add(item) {
      // Silently drop after close() — the orchestrator is expected to flush()
      // before close() if it wants pending items committed.
      if (closed) return;
      pending.push(item);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // Wrap in catch to keep any programmer error in fire() itself (not
        // inside onFlush) from becoming an unhandled rejection.
        void fire().catch(onError);
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
    // close() silences further add() calls, cancels the pending debounce timer,
    // and DROPS any pending items. Callers that want pending items persisted
    // must call flush() before close().
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
