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
    expect(cfg.minUptimeMs).toBe(5_000);
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

  test("treats empty-string env values as unset", () => {
    const cfg = loadConfig({ WEBSITE_PORT: "", WORKSPACE: "" });
    expect(cfg.websitePort).toBe(3000);
    expect(cfg.workspaceDir).toBe("/workspace");
  });

  test("WORKSPACE override cascades to derived dirs", () => {
    const cfg = loadConfig({ WORKSPACE: "/ws" });
    expect(cfg.websiteDir).toBe("/ws/src/website");
    expect(cfg.discordbotDir).toBe("/ws/src/discordbot");
  });

  test("error message names the offending key", () => {
    expect(() => loadConfig({ WEBSITE_PORT: "banana" })).toThrow(/WEBSITE_PORT/);
  });

  test("rejects float values for integer fields", () => {
    expect(() => loadConfig({ WEBSITE_PORT: "3.5" })).toThrow(/WEBSITE_PORT/);
  });

  test("rejects whitespace-only values", () => {
    expect(() => loadConfig({ WEBSITE_PORT: "   " })).toThrow(/WEBSITE_PORT/);
  });
});
