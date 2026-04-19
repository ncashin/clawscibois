import { describe, expect, test } from "bun:test";
import { createDebouncedBatcher } from "./watcher.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createDebouncedBatcher", () => {
  test("coalesces calls within the debounce window", async () => {
    const calls: string[][] = [];
    const batcher = createDebouncedBatcher<string>(async (batch) => {
      calls.push([...batch]);
    }, 50);
    batcher.add("a");
    batcher.add("b");
    batcher.add("c");
    await sleep(150);
    expect(calls).toEqual([["a", "b", "c"]]);
  });

  test("separate windows produce separate batches", async () => {
    const calls: string[][] = [];
    const batcher = createDebouncedBatcher<string>(async (batch) => {
      calls.push([...batch]);
    }, 30);
    batcher.add("a");
    await sleep(80);
    batcher.add("b");
    await sleep(80);
    expect(calls).toEqual([["a"], ["b"]]);
  });

  test("flush triggers immediately", async () => {
    const calls: string[][] = [];
    const batcher = createDebouncedBatcher<string>(async (batch) => {
      calls.push([...batch]);
    }, 10_000);
    batcher.add("a");
    await batcher.flush();
    expect(calls).toEqual([["a"]]);
  });

  test("serializes overlapping flushes", async () => {
    const order: string[] = [];
    const batcher = createDebouncedBatcher<string>(async (batch) => {
      order.push(`start:${batch.join(",")}`);
      await sleep(60);
      order.push(`end:${batch.join(",")}`);
    }, 20);
    batcher.add("a");
    await sleep(30); // first timer fires, onFlush P1 starts
    batcher.add("b");
    await sleep(30); // second timer fires while P1 still running
    await sleep(200); // let everything settle
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  test("onFlush errors are routed to onError and don't crash", async () => {
    const errors: unknown[] = [];
    const batcher = createDebouncedBatcher<string>(
      async () => {
        throw new Error("boom");
      },
      20,
      (err) => errors.push(err),
    );
    batcher.add("a");
    await sleep(100);
    expect(errors.length).toBe(1);
    expect(String(errors[0])).toContain("boom");
    // Subsequent adds should still work (batcher not poisoned).
    const okCalls: string[][] = [];
    const ok = createDebouncedBatcher<string>(
      async (b) => { okCalls.push([...b]); },
      20,
      () => {},
    );
    ok.add("x");
    await sleep(100);
    expect(okCalls).toEqual([["x"]]);
  });
});
