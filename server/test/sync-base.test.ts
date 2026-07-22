import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Against a real repository with a real worktree, because the whole point of
 * this feature is that the merge runs in the checkout that has the branch out —
 * a property no mock would have.
 */
let repo: string, wt: string, gw: typeof import("../src/gitwork.ts");

/**
 * These are write operations, so they meet the scope guard — which reads the
 * running machine's real config. Point the scope at the fixture instead, via
 * the env override that workspaceRoot() keys its cache on for exactly this
 * reason. Set before gitwork is imported.
 */

const run = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "agx-base-"));
  process.env.AGENTGLASS_ROOT = repo;
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.email", "t@example.com");
  run(repo, "config", "user.name", "t");
  const commit = (f: string, body: string, msg: string) => {
    writeFileSync(join(repo, f), body);
    run(repo, "add", "-A");
    run(repo, "commit", "-qm", msg);
  };
  commit("a.txt", "one\n", "first");

  // A card branch, checked out in its own worktree — David's actual shape.
  wt = `${repo}-CARD-1`;
  run(repo, "worktree", "add", "-q", "-b", "CARD-1", wt);

  // main moves on twice after the branch was cut.
  commit("b.txt", "two\n", "second");
  commit("c.txt", "three\n", "third");

  gw = await import("../src/gitwork.ts");
});

afterAll(() => {
  for (const d of [wt, repo]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* fine */ } }
});

describe("base branch", () => {
  it("falls back to the trunk when nothing is configured", () => {
    expect(gw.baseOf(repo, "CARD-1")).toBe("main");
  });

  it("gives the trunk itself no base", () => {
    // Otherwise the trunk offers to merge itself into itself.
    expect(gw.baseOf(repo, "main")).toBe(null);
  });

  it("honours an explicit override, because not every branch is cut from trunk", () => {
    run(repo, "branch", "release-9");
    gw.setBase(repo, "CARD-1", "release-9");
    expect(gw.baseOf(repo, "CARD-1")).toBe("release-9");
    gw.setBase(repo, "CARD-1", null); // back to inferred
    expect(gw.baseOf(repo, "CARD-1")).toBe("main");
  });

  it("counts what the base has and the branch does not", async () => {
    expect(await gw.behindBase(repo, "CARD-1", "main")).toBe(2);
    expect(await gw.behindBase(repo, "main", "main")).toBe(0);
  });
});

describe("undo merge", () => {
  it("offers nothing when the tip is an ordinary commit", () => {
    // Not a merge: there is no single "before" to return to.
    expect(gw.undoableMerge(repo, 1, null)).toBe(false);
  });

  it("offers nothing for work that has been pushed", () => {
    // ahead === 0 means the remote already has it, and rewriting published
    // history is a different, worse problem than undoing a local mistake.
    // Upstream present and nothing ahead of it: the remote already has this.
    expect(gw.undoableMerge(repo, 0, "origin/main")).toBe(false);
  });

  it("undoes an unpushed merge exactly, and refuses once there is nothing to undo", async () => {
    // Two branches that genuinely diverge, or the merge is a no-op and there
    // is nothing to undo.
    run(repo, "checkout", "-q", "-b", "undo-side");
    writeFileSync(join(repo, "side.txt"), "from the side\n");
    run(repo, "add", "-A"); run(repo, "commit", "-qm", "side work");
    run(repo, "checkout", "-q", "main");
    run(repo, "checkout", "-q", "-b", "undo-me");
    writeFileSync(join(repo, "mine.txt"), "from mine\n");
    run(repo, "add", "-A"); run(repo, "commit", "-qm", "my work");

    const before = run(repo, "rev-parse", "HEAD").stdout.trim();
    run(repo, "merge", "--no-edit", "undo-side");
    const merged = run(repo, "rev-parse", "HEAD").stdout.trim();
    expect(merged).not.toBe(before);
    expect(gw.undoableMerge(repo, 1, null)).toBe(true);

    expect((await gw.undoMerge(repo)).ok).toBe(true);
    expect(run(repo, "rev-parse", "HEAD").stdout.trim()).toBe(before);

    // And now there is nothing to undo, which it says rather than resetting
    // another commit off the branch.
    const second = await gw.undoMerge(repo);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/nothing to undo/i);
    run(repo, "checkout", "-q", "main");
  });

  it("refuses while the tree is dirty, since the undo is a hard reset", async () => {
    run(repo, "checkout", "-q", "-b", "undo-dirty");
    run(repo, "merge", "--no-edit", "undo-side");
    writeFileSync(join(repo, "scratch.txt"), "work in progress\n");
    expect(gw.undoableMerge(repo, 1, null)).toBe(false);
    expect((await gw.undoMerge(repo)).ok).toBe(false);
    rmSync(join(repo, "scratch.txt"));
    run(repo, "checkout", "-q", "main");
  });
});

describe("syncFromBase", () => {
  it("refuses when the checkout has uncommitted work", () => {
    writeFileSync(join(wt, "scratch.txt"), "wip\n");
    const r = gw.syncFromBase(wt);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/commit or stash/i);
    rmSync(join(wt, "scratch.txt"));
  });

  it("merges the base into the worktree's branch and clears the gap", async () => {
    expect(await gw.behindBase(repo, "CARD-1", "main")).toBe(2);
    const r = gw.syncFromBase(wt);
    expect(r.ok).toBe(true);
    // The cache is keyed per branch+base and has a TTL, so read past it.
    const after = spawnSync("git", ["-C", repo, "rev-list", "--count", "CARD-1..main"], { encoding: "utf8" });
    expect(Number(after.stdout.trim())).toBe(0);
  });

  it("refuses a checkout with no base rather than guessing one", () => {
    const r = gw.syncFromBase(repo); // repo is on main, which has no base
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no base/i);
  });
});
