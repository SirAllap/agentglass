/*
 * Which two sides git has stopped between — read, never deduced.
 *
 * The panel used to build "ours is X, theirs is Y" from the checkout's derived
 * base branch. That is a guess, and it is wrong in three of the four cases
 * below: a merge of something that is not your base names the wrong ref, and a
 * rebase names the sides the wrong way round entirely — which is how a whole
 * rebase gets resolved backwards by somebody who was told to "prefer theirs".
 *
 * So every case here drives a REAL stopped operation and asks what came back.
 * The facts they pin were measured first, not assumed:
 *
 *   - a rebase has no MERGE_HEAD at all; it keeps everything in rebase-merge/
 *   - a rebase's msgnum/end is "commit 1 of 3", which is the only place the
 *     "this repeats" fact exists
 *   - in a linked worktree `.git` is a FILE, so anything reading <root>/.git
 *     directly comes back empty — and a linked worktree is where this app
 *     spends its whole life
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-mergeinfo-")));
process.env.AGENTGLASS_ROOT = dir;
const { mergeInfo } = await import("../src/gitwork.ts");

let repo = "";
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd });

/**
 * main and feat, three commits apart, arranged so a rebase conflicts on EVERY
 * one of them.
 *
 * That arrangement is the point and it took a failing test to find: with all
 * three commits editing one file, resolving the first in favour of feat leaves
 * the second applying cleanly on top of it, the rebase runs to the end, and
 * "commit 2 of 3" is a state you cannot reach. Each commit gets its own file,
 * and main has touched all of them.
 */
function build(): string {
  const root = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", root]);
  git(root, "init", "-q", "-b", "main", ".");
  for (const f of ["f.txt", "a.txt", "b.txt", "c.txt"]) writeFileSync(join(root, f), "base\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "seed");

  git(root, "checkout", "-q", "-b", "feat");
  const owned = { 1: "a.txt", 2: "b.txt", 3: "c.txt" } as const;
  for (const n of [1, 2, 3] as const) {
    writeFileSync(join(root, owned[n]), `feat ${n}\n`);
    if (n === 1) writeFileSync(join(root, "f.txt"), "feat 1\n");
    git(root, "commit", "-qam", `feat commit ${n}`);
  }

  git(root, "checkout", "-q", "main");
  for (const f of ["f.txt", "a.txt", "b.txt", "c.txt"]) writeFileSync(join(root, f), "main side\n");
  git(root, "commit", "-qam", "main side");
  return root;
}

/** Take the incoming side of everything still conflicted, and stage it. */
function takeTheirs(root: string): void {
  const left = git(root, "diff", "--name-only", "--diff-filter=U").stdout.toString().split("\n").filter(Boolean);
  if (!left.length) return;
  git(root, "checkout", "--theirs", "--", ...left);
  git(root, "add", "--", ...left);
}

const sha = (root: string, rev: string) => git(root, "rev-parse", rev).stdout.toString().trim();

beforeEach(() => { repo = build(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("nothing is stopped", () => {
  it("says clean and offers no sides to choose between", () => {
    const i = mergeInfo(repo);
    expect(i.ok).toBe(true);
    expect(i.state).toBe("clean");
    expect(i.ours).toBeNull();
    expect(i.theirs).toBeNull();
  });

  it("a bisect is a state, but not one with two sides", () => {
    git(repo, "bisect", "start");
    const i = mergeInfo(repo);
    expect(i.state).toBe("bisecting");
    expect(i.theirs).toBeNull();
    git(repo, "bisect", "reset");
  });
});

describe("a merge", () => {
  beforeEach(() => { git(repo, "merge", "feat"); });

  it("names the branch you are on and the branch coming in", () => {
    const i = mergeInfo(repo);
    expect(i.state).toBe("merging");
    expect(i.ours?.ref).toBe("main");
    expect(i.theirs?.ref).toBe("feat");
  });

  it("carries the shas, not only the names", () => {
    const i = mergeInfo(repo);
    expect(i.theirs?.sha).toBe(sha(repo, "feat"));
    expect(i.theirs?.subject).toBe("feat commit 3");
  });

  it("does not invent a step count — a merge happens once", () => {
    const i = mergeInfo(repo);
    expect(i.step).toBeUndefined();
    expect(i.total).toBeUndefined();
  });
});

describe("a rebase", () => {
  beforeEach(() => {
    git(repo, "checkout", "-q", "feat");
    git(repo, "rebase", "main");
  });

  it("puts the sides the way git actually has them, which is inverted", () => {
    // "ours" is the branch being replayed ONTO. Getting this backwards is the
    // failure the whole function exists to prevent.
    const i = mergeInfo(repo);
    expect(i.state).toBe("rebasing");
    expect(i.ours?.ref).toBe("main");
    expect(i.ours?.sha).toBe(sha(repo, "main"));
  });

  it("names theirs as the commit being replayed, not as a branch", () => {
    // It is a commit in the middle of a series. Calling it "feat" would be a
    // lie: feat's tip is two commits further on.
    const i = mergeInfo(repo);
    expect(i.theirs?.subject).toBe("feat commit 1");
    expect(i.theirs?.ref).toBeNull();
  });

  it("says which commit of how many, because a rebase repeats", () => {
    const i = mergeInfo(repo);
    expect(i.step).toBe(1);
    expect(i.total).toBe(3);
  });

  it("counts up as the rebase advances", () => {
    // The second stop is a different commit and a different number — a screen
    // that says "done" after the first one is lying.
    takeTheirs(repo);
    git(repo, "-c", "core.editor=true", "rebase", "--continue");
    const i = mergeInfo(repo);
    expect(i.state).toBe("rebasing");
    expect(i.step).toBe(2);
    expect(i.total).toBe(3);
    expect(i.theirs?.subject).toBe("feat commit 2");
  });
});

describe("a cherry-pick", () => {
  it("names the commit being picked, and the branch it lands on", () => {
    git(repo, "cherry-pick", sha(repo, "feat"));
    const i = mergeInfo(repo);
    expect(i.state).toBe("cherry-picking");
    expect(i.ours?.ref).toBe("main");
    expect(i.theirs?.subject).toBe("feat commit 3");
  });
});

describe("a revert", () => {
  it("names the commit being undone", () => {
    // Two commits on main so there is an earlier one to revert into a conflict.
    writeFileSync(join(repo, "f.txt"), "later\n");
    git(repo, "commit", "-qam", "later still");
    git(repo, "revert", "--no-edit", "HEAD~1");
    const i = mergeInfo(repo);
    expect(i.state).toBe("reverting");
    expect(i.theirs?.subject).toBe("main side");
  });
});

describe("in a linked worktree", () => {
  it("reads the state at all, where <root>/.git is a file and not a directory", () => {
    // The trap this test exists for: `join(root, ".git", "MERGE_HEAD")` finds
    // nothing here, silently, and every side comes back null. agentglass runs
    // in linked worktrees essentially always.
    const held = join(dir, `wt-${Math.random().toString(36).slice(2)}`);
    git(repo, "worktree", "add", "-q", held, "feat");
    git(held, "merge", "main");
    const i = mergeInfo(held);
    expect(i.state).toBe("merging");
    expect(i.ours?.ref).toBe("feat");
    expect(i.theirs?.ref).toBe("main");
  });
});
