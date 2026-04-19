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

  test("clearCrashes resets bricked state", async () => {
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

  test("restart() does not count as a crash", async () => {
    const mp = new ManagedProcess({
      name: "sleeper",
      cmd: ["sleep", "10"],
      cwd: "/tmp",
      env: {},
      crashWindowMs: 60_000,
      crashThreshold: 2,
      restartDelayMs: 10,
    });
    mp.start();
    await sleep(50);
    await mp.restart();
    await sleep(50);
    await mp.restart();
    await sleep(50);
    expect(mp.state().crashesInWindow).toBe(0);
    expect(mp.state().bricked).toBe(false);
    expect(mp.state().running).toBe(true);
    await mp.stop();
  });

  // Regression: when restart() was called while the process was already
  // dead (e.g., in the supervisor's revert path after a crash loop had
  // bricked the process), the stale `expectedExit = true` flag leaked
  // into the next spawn's handleExit and suppressed its crash count.
  // Symptom in production: website shows { running: false, bricked: false,
  // crashesInWindow: 0 } forever — the supervisor is blind to the ongoing
  // failures and never reschedules.
  test("restart() on a dead process still counts subsequent crashes", async () => {
    const mp = new ManagedProcess({
      name: "exit1",
      cmd: ["sh", "-c", "exit 1"],
      cwd: "/tmp",
      env: {},
      crashWindowMs: 60_000,
      crashThreshold: 10, // high so we can count growth without bricking
      restartDelayMs: 10,
    });
    mp.start();
    // Wait long enough for several crash+restart cycles.
    await sleep(300);
    const baseline = mp.state().crashesInWindow;
    expect(baseline).toBeGreaterThan(0);

    // Now simulate what the supervisor's revert does: wait for a quiet
    // moment when the process happens to be between attempts, then call
    // restart(). Under the bug, this silently neutralises the next crash.
    mp.clearCrashes();
    await mp.restart();
    // The restart schedules a new spawn; give it time to crash again.
    await sleep(300);
    const afterRestart = mp.state().crashesInWindow;
    expect(afterRestart).toBeGreaterThan(0);
    await mp.stop();
  });
});
