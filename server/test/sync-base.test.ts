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
  it("falls back to the trunk when nothing is configured", async () => {
    expect((await gw.baseOf(repo, "CARD-1"))).toBe("main");
  });

  it("gives the trunk itself no base", async () => {
    // Otherwise the trunk offers to merge itself into itself.
    expect((await gw.baseOf(repo, "main"))).toBe(null);
  });

  it("honours an explicit override, because not every branch is cut from trunk", async () => {
    run(repo, "branch", "release-9");
    gw.setBase(repo, "CARD-1", "release-9");
    expect((await gw.baseOf(repo, "CARD-1"))).toBe("release-9");
    gw.setBase(repo, "CARD-1", null); // back to inferred
    expect((await gw.baseOf(repo, "CARD-1"))).toBe("main");
  });

  /*
   * A branch stacked on another feature branch, which is most of them here.
   *
   * Reported with three screenshots: the base picker offered "origin/master —
   * current base" on a worktree cut from another card's branch, while the
   * header two centimetres away read "tracking origin/<that branch>". Both were
   * reading the same repository; only one of them was asking git what the
   * branch says about itself.
   *
   * Inference cannot answer this. `for-each-ref --merged <branch>` only matches
   * a base the branch still contains, so the moment the base picks up a commit
   * of its own it stops being an ancestor, drops out of the candidates, and the
   * ladder falls through to the trunk. Tracking is written down at checkout
   * time and stays true.
   */
  it("takes what the branch tracks over a guess at the shape of history", async () => {
    run(repo, "branch", "feature-lane");
    run(repo, "worktree", "add", "-q", "-b", "CARD-2", `${repo}-CARD-2`, "feature-lane");
    run(`${repo}-CARD-2`, "branch", "--set-upstream-to=feature-lane", "CARD-2");
    // The base moves on, which is what puts it out of reach of inference.
    run(repo, "checkout", "-q", "feature-lane");
    writeFileSync(join(repo, "lane.txt"), "lane\n");
    run(repo, "add", "-A"); run(repo, "commit", "-qm", "on the lane");
    run(repo, "checkout", "-q", "main");
    expect(await gw.baseOf(repo, "CARD-2")).toBe("feature-lane");
    rmSync(`${repo}-CARD-2`, { recursive: true, force: true });
    run(repo, "worktree", "prune");
  });

  it("does not call a branch its own base when tracking is just where it pushes", async () => {
    /* Every pushed branch tracks a copy of ITSELF. Read as a base that would
       measure a branch against itself and report zero for ever — and zero is
       exactly what a wrong base usually reports. */
    run(repo, "branch", "CARD-3", "main");
    run(repo, "branch", "--set-upstream-to=CARD-3", "CARD-3");
    expect(await gw.baseOf(repo, "CARD-3")).not.toBe("CARD-3");
  });

  it("treats clearing an override that was never set as done, not as an error", async () => {
    // `git config --unset` exits 5 on a missing key. Taken literally, the
    // picker's "work it out for me" would fail on every branch that never had
    // an override — which is most of them — and report it as a broken action.
    expect(gw.setBase(repo, "CARD-1", null).ok).toBe(true);
    expect(gw.setBase(repo, "CARD-1", "").ok).toBe(true);
    expect((await gw.baseOf(repo, "CARD-1"))).toBe("main");
  });

  it("counts what the base has and the branch does not", async () => {
    expect(await gw.behindBase(repo, "CARD-1", "main")).toBe(2);
    expect(await gw.behindBase(repo, "main", "main")).toBe(0);
  });
});

/**
 * A stack with a real remote, because the failure this covers only exists once
 * there are two copies of the base: the one on the server that has moved on,
 * and the one on this disk that has not.
 *
 * Nothing here was reachable by the fixture above — it has no remote at all, so
 * every base it can name is one this checkout is already level with, and
 * "behind" is zero by construction. That is exactly why the panel showed
 * nothing for months while a pull request page said "126 commits behind".
 */
let stack: string, originDir: string, stackWt: string;

describe("a base that has moved on", () => {
  beforeAll(() => {
    originDir = mkdtempSync(join(tmpdir(), "agx-origin-"));
    run(originDir, "init", "-q", "--bare", "-b", "master");

    stack = mkdtempSync(join(tmpdir(), "agx-stack-"));
    run(stack, "init", "-q", "-b", "master");
    run(stack, "config", "user.email", "t@example.com");
    run(stack, "config", "user.name", "t");
    run(stack, "remote", "add", "origin", originDir);
    const c = (f: string, msg: string) => {
      writeFileSync(join(stack, f), `${msg}\n`);
      run(stack, "add", "-A");
      run(stack, "commit", "-qm", msg);
    };
    c("m1.txt", "trunk one");
    run(stack, "push", "-q", "-u", "origin", "master");

    // The branch a stack is built on — a release train, an epic branch.
    run(stack, "checkout", "-q", "-b", "feature-base");
    c("f1.txt", "base one");
    c("f2.txt", "base two");
    run(stack, "push", "-q", "-u", "origin", "feature-base");
    const cutFrom = run(stack, "rev-parse", "HEAD").stdout.trim();

    // A card cut from it, with its own work on top.
    run(stack, "checkout", "-q", "-b", "card");
    c("k1.txt", "card one");
    c("k2.txt", "card two");
    run(stack, "push", "-q", "-u", "origin", "card");

    // The base moves on: three commits the card has never seen. This is the
    // whole point of the chip, and the case nothing used to cover.
    run(stack, "checkout", "-q", "feature-base");
    c("f3.txt", "base three");
    c("f4.txt", "base four");
    c("f5.txt", "base five");
    run(stack, "push", "-q", "origin", "feature-base");

    // ...and this checkout has not pulled since, so its *local* copy of the
    // base is three behind the copy the pull request is measured against.
    // Rewound off HEAD, or the working tree would disagree with the branch.
    run(stack, "checkout", "-q", "master");
    run(stack, "update-ref", "refs/heads/feature-base", cutFrom);

    stackWt = `${stack}-card`;
    run(stack, "worktree", "add", "-q", stackWt, "card");
  });

  afterAll(() => {
    gw.setPrBaseHook(null);
    for (const d of [stackWt, stack, originDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* fine */ } }
  });

  it("measures the base as it is on the remote, not the stale copy on this disk", async () => {
    // The regression this whole change exists for. Inference can only ever name
    // a copy of the base the branch is already level with, so measuring the ref
    // it returns reported zero and the panel drew nothing.
    gw.invalidateMerged();
    const base = await gw.baseOf(stack, "card");
    expect(base).toBe("origin/feature-base");
    expect(await gw.behindBase(stack, "card", base!)).toBe(3);
    // And the local copy is genuinely the one that would have lied.
    expect(await gw.behindBase(stack, "card", "feature-base")).toBe(0);
  });

  it("does not mistake a leftover review ref for the branch's base", async () => {
    // `--merged` matches any ref that happens to be an ancestor, and a working
    // repo is full of them: the pr1042-review someone left after reading a
    // diff sits a commit back, wins the fewest-commits test, and becomes a
    // "base" the branch was never cut from.
    run(stack, "branch", "pr9-review", "card~1");
    gw.invalidateMerged();
    expect(await gw.baseOf(stack, "card")).toBe("origin/feature-base");
    run(stack, "branch", "-qD", "pr9-review");
  });

  it("takes the base a pull request declares over anything read off history", async () => {
    gw.setPrBaseHook(async () => "master");
    gw.invalidateMerged();
    expect(await gw.baseOf(stack, "card")).toBe("origin/master");
    gw.setPrBaseHook(null);
  });

  it("ignores a declared base the remote does not have", async () => {
    // A stale row naming a deleted branch must not leave the panel measuring
    // against nothing; it falls back to what history can still show.
    gw.setPrBaseHook(async () => "branch-that-was-deleted");
    gw.invalidateMerged();
    expect(await gw.baseOf(stack, "card")).toBe("origin/feature-base");
    gw.setPrBaseHook(null);
  });

  it("lets a written-down override outrank even the pull request", async () => {
    run(stack, "config", "branch.card.agentglassbase", "master");
    gw.setPrBaseHook(async () => "feature-base");
    gw.invalidateMerged();
    // `master`, not `origin/master`: the local copy is level with the remote, so
    // there is no fresher one to prefer and the ref is left as written.
    expect(await gw.baseOf(stack, "card")).toBe("master");
    gw.setPrBaseHook(null);
    run(stack, "config", "--unset", "branch.card.agentglassbase");
  });
});

describe("a stack with no remote at all", () => {
  // The published-only filter must not leave a purely local repo with no base
  // to name: there, every branch is local and the distinction does not exist.
  let solo: string;
  beforeAll(() => {
    solo = mkdtempSync(join(tmpdir(), "agx-solo-"));
    run(solo, "init", "-q", "-b", "main");
    run(solo, "config", "user.email", "t@example.com");
    run(solo, "config", "user.name", "t");
    const c = (f: string, msg: string) => {
      writeFileSync(join(solo, f), `${msg}\n`);
      run(solo, "add", "-A");
      run(solo, "commit", "-qm", msg);
    };
    c("m.txt", "trunk");
    run(solo, "checkout", "-q", "-b", "epic");
    c("e.txt", "epic work");
    run(solo, "checkout", "-q", "-b", "card");
    c("c.txt", "card work");
  });
  afterAll(() => { try { rmSync(solo, { recursive: true, force: true }); } catch { /* fine */ } });

  it("still infers the branch it was stacked on", async () => {
    gw.invalidateMerged();
    expect(await gw.baseOf(solo, "card")).toBe("epic");
  });
});

describe("undo merge", () => {
  it("offers nothing when the tip is an ordinary commit", async () => {
    // Not a merge: there is no single "before" to return to.
    expect(await gw.undoableMerge(repo, 1, null)).toBe(false);
  });

  it("offers nothing for work that has been pushed", async () => {
    // ahead === 0 means the remote already has it, and rewriting published
    // history is a different, worse problem than undoing a local mistake.
    // Upstream present and nothing ahead of it: the remote already has this.
    expect(await gw.undoableMerge(repo, 0, "origin/main")).toBe(false);
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
    expect(await gw.undoableMerge(repo, 1, null)).toBe(true);

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
    expect(await gw.undoableMerge(repo, 1, null)).toBe(false);
    expect((await gw.undoMerge(repo)).ok).toBe(false);
    rmSync(join(repo, "scratch.txt"));
    run(repo, "checkout", "-q", "main");
  });
});

describe("syncFromBase", () => {
  it("refuses when the checkout has uncommitted work", async () => {
    writeFileSync(join(wt, "scratch.txt"), "wip\n");
    const r = await gw.syncFromBase(wt);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/commit or stash/i);
    rmSync(join(wt, "scratch.txt"));
  });

  it("merges the base into the worktree's branch and clears the gap", async () => {
    expect(await gw.behindBase(repo, "CARD-1", "main")).toBe(2);
    const r = await gw.syncFromBase(wt);
    expect(r.ok).toBe(true);
    // The cache is keyed per branch+base and has a TTL, so read past it.
    const after = spawnSync("git", ["-C", repo, "rev-list", "--count", "CARD-1..main"], { encoding: "utf8" });
    expect(Number(after.stdout.trim())).toBe(0);
  });

  it("refuses a checkout with no base rather than guessing one", async () => {
    const r = await gw.syncFromBase(repo); // repo is on main, which has no base
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no base/i);
  });
});
