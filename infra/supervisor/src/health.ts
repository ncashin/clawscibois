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
