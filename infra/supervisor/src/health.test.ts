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
    const body = (await res.json()) as SupervisorSnapshot;
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
