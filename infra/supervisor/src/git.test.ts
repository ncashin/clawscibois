import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitAll,
  ensureWorkspaceRepo,
  getHeadSha,
  hardResetTo,
  updateGoodRef,
  getGoodRef,
  untrackPath,
} from "./git.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supervisor-git-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureWorkspaceRepo", () => {
  test("initializes a new repo with a seed commit", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "hello.txt"), "hi");
    await ensureWorkspaceRepo(dir);
    const sha = await getHeadSha(dir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("is idempotent when repo already exists", async () => {
    await ensureWorkspaceRepo(dir);
    const sha1 = await getHeadSha(dir);
    await ensureWorkspaceRepo(dir);
    const sha2 = await getHeadSha(dir);
    expect(sha2).toBe(sha1);
  });
});

describe("commitAll", () => {
  test("commits pending changes as agent author", async () => {
    await ensureWorkspaceRepo(dir);
    writeFileSync(join(dir, "new.txt"), "content");
    const sha = await commitAll(dir, {
      author: { name: "agent", email: "agent@clawscibois.local" },
      message: "agent: write new.txt",
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const head = await getHeadSha(dir);
    expect(head).toBe(sha);
  });

  test("returns null when there is nothing to commit", async () => {
    await ensureWorkspaceRepo(dir);
    const sha = await commitAll(dir, {
      author: { name: "agent", email: "agent@clawscibois.local" },
      message: "empty",
    });
    expect(sha).toBeNull();
  });
});

describe("hardResetTo", () => {
  test("resets working tree to the given sha", async () => {
    await ensureWorkspaceRepo(dir);
    const initial = await getHeadSha(dir);
    writeFileSync(join(dir, "broken.txt"), "oops");
    await commitAll(dir, {
      author: { name: "agent", email: "agent@clawscibois.local" },
      message: "bad",
    });
    await hardResetTo(dir, initial!);
    const head = await getHeadSha(dir);
    expect(head).toBe(initial);
  });
});

describe("good ref", () => {
  test("update + get round-trips", async () => {
    await ensureWorkspaceRepo(dir);
    const sha = await getHeadSha(dir);
    await updateGoodRef(dir, sha!);
    const got = await getGoodRef(dir);
    expect(got).toBe(sha);
  });

  test("getGoodRef returns null when unset", async () => {
    await ensureWorkspaceRepo(dir);
    const got = await getGoodRef(dir);
    expect(got).toBeNull();
  });
});

describe("untrackPath", () => {
  const supervisorAuthor = {
    name: "supervisor",
    email: "supervisor@clawscibois.local",
  };

  test("removes a tracked path from the index and commits", async () => {
    await ensureWorkspaceRepo(dir);
    mkdirSync(join(dir, "infra"));
    writeFileSync(join(dir, "infra", "rules.md"), "DO NOT TOUCH");
    await commitAll(dir, {
      author: { name: "agent", email: "agent@clawscibois.local" },
      message: "adds infra",
    });

    const pruned = await untrackPath(dir, "infra", supervisorAuthor);
    expect(pruned).toBe(true);

    // Working tree file should still exist; just untracked now.
    expect(
      await Bun.file(join(dir, "infra", "rules.md")).exists(),
    ).toBe(true);

    // And a new commit records the removal.
    const lsAfter = await Bun.spawn(["git", "-C", dir, "ls-files", "infra"], {
      stdout: "pipe",
    });
    const lsText = await new Response(lsAfter.stdout).text();
    expect(lsText.trim()).toBe("");
  });

  test("is a no-op when the path isn't tracked", async () => {
    await ensureWorkspaceRepo(dir);
    const headBefore = await getHeadSha(dir);
    const pruned = await untrackPath(dir, "infra", supervisorAuthor);
    expect(pruned).toBe(false);
    const headAfter = await getHeadSha(dir);
    expect(headAfter).toBe(headBefore);
  });
});
