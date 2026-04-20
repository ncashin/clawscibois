import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { QueueEntry } from "chat";
import {
  BunSqliteStateAdapter,
  createSqliteState,
} from "./stateSqlite.ts";

// Each test gets a fresh in-memory DB. The cleanup sweep is disabled so
// timers don't keep the test runner alive between suites.
let state: BunSqliteStateAdapter;

beforeEach(async () => {
  state = createSqliteState({ path: ":memory:", cleanupIntervalMs: 0 });
  await state.connect();
});

afterEach(async () => {
  await state.disconnect();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEntry(
  expiresInMs: number,
  overrides: Partial<QueueEntry> = {},
): QueueEntry {
  return {
    enqueuedAt: Date.now(),
    expiresAt: Date.now() + expiresInMs,
    // Chat's Message type is structural; the adapter only JSON-serialises it.
    message: { id: Math.random().toString() } as QueueEntry["message"],
    ...overrides,
  };
}

describe("subscriptions", () => {
  test("subscribe + isSubscribed + unsubscribe round-trip", async () => {
    expect(await state.isSubscribed("t1")).toBe(false);
    await state.subscribe("t1");
    expect(await state.isSubscribed("t1")).toBe(true);
    await state.unsubscribe("t1");
    expect(await state.isSubscribed("t1")).toBe(false);
  });

  test("subscribe is idempotent", async () => {
    await state.subscribe("t1");
    await state.subscribe("t1");
    await state.subscribe("t1");
    expect(await state.isSubscribed("t1")).toBe(true);
  });

  test("unsubscribe on a non-existent thread is a no-op", async () => {
    await expect(state.unsubscribe("never-subscribed")).resolves.toBeUndefined();
  });
});

describe("locks", () => {
  test("acquireLock returns a Lock for a free thread", async () => {
    const lock = await state.acquireLock("t1", 5_000);
    expect(lock).not.toBeNull();
    expect(lock!.threadId).toBe("t1");
    expect(lock!.token).toMatch(/^sqlt_/);
    expect(lock!.expiresAt).toBeGreaterThan(Date.now());
  });

  test("acquireLock returns null when held", async () => {
    await state.acquireLock("t1", 5_000);
    const second = await state.acquireLock("t1", 5_000);
    expect(second).toBeNull();
  });

  test("acquireLock succeeds after previous lock expires", async () => {
    const first = await state.acquireLock("t1", 50);
    expect(first).not.toBeNull();
    await sleep(80);
    const second = await state.acquireLock("t1", 5_000);
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first!.token);
  });

  test("releaseLock unlocks when token matches", async () => {
    const lock = (await state.acquireLock("t1", 5_000))!;
    await state.releaseLock(lock);
    const second = await state.acquireLock("t1", 5_000);
    expect(second).not.toBeNull();
  });

  test("releaseLock with wrong token is a no-op", async () => {
    const lock = (await state.acquireLock("t1", 5_000))!;
    await state.releaseLock({
      threadId: "t1",
      token: "some-other-token",
      expiresAt: lock.expiresAt,
    });
    // Real lock still held.
    expect(await state.acquireLock("t1", 5_000)).toBeNull();
  });

  test("forceReleaseLock always releases", async () => {
    await state.acquireLock("t1", 5_000);
    await state.forceReleaseLock("t1");
    expect(await state.acquireLock("t1", 5_000)).not.toBeNull();
  });

  test("extendLock succeeds with matching token", async () => {
    const lock = (await state.acquireLock("t1", 100))!;
    const extended = await state.extendLock(lock, 5_000);
    expect(extended).toBe(true);
    // Wait past the original TTL; lock should still be held.
    await sleep(150);
    expect(await state.acquireLock("t1", 5_000)).toBeNull();
  });

  test("extendLock fails with wrong token", async () => {
    const lock = (await state.acquireLock("t1", 5_000))!;
    const extended = await state.extendLock(
      { ...lock, token: "wrong" },
      5_000,
    );
    expect(extended).toBe(false);
  });

  test("extendLock fails if lock already expired", async () => {
    const lock = (await state.acquireLock("t1", 50))!;
    await sleep(80);
    const extended = await state.extendLock(lock, 5_000);
    expect(extended).toBe(false);
  });
});

describe("kv cache", () => {
  test("set / get round-trip with arbitrary JSON", async () => {
    await state.set("k", { nested: { arr: [1, 2, 3] } });
    expect(await state.get("k")).toEqual({ nested: { arr: [1, 2, 3] } });
  });

  test("get returns null for unset key", async () => {
    expect(await state.get("missing")).toBeNull();
  });

  test("set overwrites existing values", async () => {
    await state.set("k", "first");
    await state.set("k", "second");
    expect(await state.get("k")).toBe("second");
  });

  test("get respects TTL", async () => {
    await state.set("k", "v", 50);
    expect(await state.get("k")).toBe("v");
    await sleep(80);
    expect(await state.get("k")).toBeNull();
  });

  test("setIfNotExists inserts when missing, rejects when present", async () => {
    expect(await state.setIfNotExists("k", "first")).toBe(true);
    expect(await state.setIfNotExists("k", "second")).toBe(false);
    expect(await state.get("k")).toBe("first");
  });

  test("setIfNotExists replaces expired entries", async () => {
    await state.set("k", "expired", 20);
    await sleep(50);
    expect(await state.setIfNotExists("k", "fresh")).toBe(true);
    expect(await state.get("k")).toBe("fresh");
  });

  test("delete removes the key", async () => {
    await state.set("k", "v");
    await state.delete("k");
    expect(await state.get("k")).toBeNull();
  });

  test("delete also clears any list at the same key", async () => {
    await state.appendToList("k", "a");
    await state.appendToList("k", "b");
    expect((await state.getList("k")).length).toBe(2);
    await state.delete("k");
    expect(await state.getList("k")).toEqual([]);
  });
});

describe("lists", () => {
  test("append + getList preserves insertion order", async () => {
    await state.appendToList("k", "a");
    await state.appendToList("k", "b");
    await state.appendToList("k", "c");
    expect(await state.getList<string>("k")).toEqual(["a", "b", "c"]);
  });

  test("getList returns [] for an empty key", async () => {
    expect(await state.getList("nope")).toEqual([]);
  });

  test("maxLength trims oldest entries", async () => {
    for (let i = 0; i < 5; i++) {
      await state.appendToList("k", i, { maxLength: 3 });
    }
    expect(await state.getList<number>("k")).toEqual([2, 3, 4]);
  });

  test("TTL expires the whole list", async () => {
    await state.appendToList("k", "a", { ttlMs: 40 });
    await state.appendToList("k", "b", { ttlMs: 40 });
    expect((await state.getList("k")).length).toBe(2);
    await sleep(80);
    expect(await state.getList("k")).toEqual([]);
  });

  test("append after expiry starts a fresh list", async () => {
    await state.appendToList("k", "old", { ttlMs: 30 });
    await sleep(60);
    await state.appendToList("k", "new");
    expect(await state.getList<string>("k")).toEqual(["new"]);
  });
});

describe("queues", () => {
  test("enqueue returns new depth, dequeue FIFO order", async () => {
    const a = makeEntry(60_000);
    const b = makeEntry(60_000);
    const c = makeEntry(60_000);
    expect(await state.enqueue("t1", a, 10)).toBe(1);
    expect(await state.enqueue("t1", b, 10)).toBe(2);
    expect(await state.enqueue("t1", c, 10)).toBe(3);
    expect(await state.queueDepth("t1")).toBe(3);

    const first = await state.dequeue("t1");
    expect(first?.message).toEqual(a.message);
    const second = await state.dequeue("t1");
    expect(second?.message).toEqual(b.message);
    const third = await state.dequeue("t1");
    expect(third?.message).toEqual(c.message);
    expect(await state.dequeue("t1")).toBeNull();
  });

  test("enqueue caps at maxSize by dropping oldest", async () => {
    for (let i = 0; i < 5; i++) {
      await state.enqueue(
        "t1",
        makeEntry(60_000, { enqueuedAt: i }),
        3,
      );
    }
    expect(await state.queueDepth("t1")).toBe(3);

    // Dequeue all; should be the three most recent, in order.
    const out: number[] = [];
    while (true) {
      const e = await state.dequeue("t1");
      if (!e) break;
      out.push(e.enqueuedAt);
    }
    expect(out).toEqual([2, 3, 4]);
  });

  test("dequeue skips expired entries", async () => {
    // Old-style entry: expired as of enqueue time
    const expired: QueueEntry = {
      enqueuedAt: Date.now() - 10_000,
      expiresAt: Date.now() - 1_000,
      message: { id: "expired" } as QueueEntry["message"],
    };
    const fresh = makeEntry(60_000);
    await state.enqueue("t1", expired, 10);
    await state.enqueue("t1", fresh, 10);

    const got = await state.dequeue("t1");
    expect(got?.message).toEqual(fresh.message);
    expect(await state.dequeue("t1")).toBeNull();
  });

  test("queueDepth returns 0 for untouched thread", async () => {
    expect(await state.queueDepth("nope")).toBe(0);
  });

  test("queues are isolated per thread", async () => {
    await state.enqueue("a", makeEntry(60_000), 10);
    await state.enqueue("b", makeEntry(60_000), 10);
    expect(await state.queueDepth("a")).toBe(1);
    expect(await state.queueDepth("b")).toBe(1);
    await state.dequeue("a");
    expect(await state.queueDepth("a")).toBe(0);
    expect(await state.queueDepth("b")).toBe(1);
  });
});

describe("persistence across reconnects", () => {
  test("subscriptions survive disconnect/reconnect when using a file", async () => {
    // Replace the :memory: DB for this test with a real temp file.
    await state.disconnect();
    const path = `/tmp/state-sqlite-test-${Date.now()}-${Math.random()}.db`;
    const fresh = createSqliteState({ path, cleanupIntervalMs: 0 });
    await fresh.connect();
    await fresh.subscribe("persisted");
    await fresh.set("k", "v");
    await fresh.disconnect();

    const reopened = createSqliteState({ path, cleanupIntervalMs: 0 });
    await reopened.connect();
    expect(await reopened.isSubscribed("persisted")).toBe(true);
    expect(await reopened.get("k")).toBe("v");
    await reopened.disconnect();
  });
});

describe("ensureConnected", () => {
  test("throws when used before connect()", async () => {
    const unconnected = createSqliteState({
      path: ":memory:",
      cleanupIntervalMs: 0,
    });
    await expect(unconnected.isSubscribed("x")).rejects.toThrow(
      /not connected/,
    );
  });
});
