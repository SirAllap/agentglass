import { describe, expect, it } from "bun:test";
import { conflictBriefing, sidesOf, nameSide, bandLabels, stepLabel, CONFLICT_ASK } from "../src/lib/conflictBrief.ts";
import type { GitBranchInfo, GitRepoRef, MergeInfo, MergeSide } from "../../shared/types.ts";

/**
 * The briefing handed to Claude when git stops mid-merge.
 *
 * Its job is to name the situation the panel already knows: which branch, what
 * is coming in, whether this is a linked worktree, and above all which side is
 * "theirs". Get that last one wrong and the agent resolves every conflict
 * backwards, confidently.
 */
const branch = (over: Partial<GitBranchInfo> = {}): GitBranchInfo => ({
  name: "native/egui-shell",
  upstream: "origin/main",
  ahead: 3,
  behind: 0,
  detached: false,
  base: "main",
  ...over,
});

const repo = (over: Partial<GitRepoRef> = {}): GitRepoRef => ({
  root: "/home/me/code/app",
  name: "app",
  branch: "native/egui-shell",
  dirty: 2,
  ahead: 0,
  behind: 0,
  // Required on GitRepoRef, and 0 is its documented "could not be read" —
  // nothing here sorts on it, so a real timestamp would only look meaningful.
  touchedAt: 0,
  ...over,
});

const text = (...args: Parameters<typeof conflictBriefing>) => conflictBriefing(...args).join("\n");

describe("conflict briefing", () => {
  it("names the branch, the incoming ref and the files", () => {
    const s = text("/home/me/code/app", branch(), repo(), "merging", ["src/a.ts", "src/b.ts"]);
    expect(s).toContain("native/egui-shell");
    expect(s).toContain("bringing main in");
    expect(s).toContain("- src/a.ts");
    expect(s).toContain("2 file(s) conflicted");
  });

  it("says which side is theirs during a merge", () => {
    const s = text("/home/me/code/app", branch(), repo(), "merging", ["src/a.ts"]);
    expect(s).toContain('"theirs"/MERGE_HEAD is main');
  });

  it("warns that the sides are inverted during a rebase", () => {
    // The whole reason this exists: git replays YOUR commits onto the base, so
    // "theirs" is your own work. An agent told to prefer theirs, believing that
    // means the base, resolves the entire rebase the wrong way round.
    const s = text("/home/me/code/app", branch(), repo(), "rebasing", ["src/a.ts"]);
    expect(s).toContain("REBASE");
    expect(s).toContain("inverted");
    expect(s).toContain("my own commit being replayed");
    expect(s).not.toContain("MERGE_HEAD");
  });

  it("says a cherry-pick is a cherry-pick", () => {
    const s = text("/home/me/code/app", branch(), repo(), "cherry-picking", ["src/a.ts"]);
    expect(s).toContain("cherry-picked");
  });

  it("identifies a linked worktree, and the repo it belongs to", () => {
    // "I am in /some/path" is not enough when that path is one of a dozen
    // checkouts of the same repository.
    const wt = "/home/me/code/app/.claude/worktrees/native-egui";
    const s = text(wt, branch(), repo({ root: wt, worktreeOf: "/home/me/code/app" }), "merging", ["src/a.ts"]);
    expect(s).toContain("linked worktree");
    expect(s).toContain("/home/me/code/app");
  });

  it("does not claim a worktree for an ordinary checkout", () => {
    const s = text("/home/me/code/app", branch(), repo(), "merging", ["src/a.ts"]);
    expect(s).not.toContain("linked worktree");
  });

  it("stays honest when the base is unknown", () => {
    // Trunk itself has no base. Better to say nothing about incoming than to
    // name a ref that is not there.
    const s = text("/home/me/code/app", branch({ name: "main", base: null }), repo(), "merging", ["src/a.ts"]);
    expect(s).not.toContain("bringing null");
    expect(s).toContain("the other side");
  });

  it("survives a checkout it knows nothing about", () => {
    const s = text("/home/me/code/app", undefined, undefined, "merging", ["src/a.ts"]);
    expect(s).toContain("(unknown branch)");
    expect(s).toContain("- src/a.ts");
  });

  it("keeps the do-not-commit boundary in the ask", () => {
    // The agent resolves; the human reviews and runs `continue`. That line is
    // the whole safety story of this feature.
    expect(CONFLICT_ASK.join(" ")).toContain("Do not commit");
  });

  it("offers no sides for a clean tree", () => {
    expect(sidesOf("clean", "main", "main")).toBeNull();
  });
});

/**
 * The same sentence, built from what git actually has in `.git` instead of
 * from the checkout's derived base branch.
 *
 * The deduction is wrong whenever the thing being merged is not your own base
 * — a hotfix branch, a colleague's branch, a cherry-pick — and it is wrong
 * about WHICH COMMIT during a rebase, because it names the branch tip while
 * git is three commits behind it.
 */
const side = (over: Partial<MergeSide> = {}): MergeSide =>
  ({ ref: null, sha: "9f2c1ab4de5678", subject: "teach the rail to fold", ...over });

const info = (over: Partial<MergeInfo> = {}): MergeInfo =>
  ({ ok: true, state: "merging", ours: side({ ref: "main" }), theirs: side({ ref: "feat" }), ...over });

describe("naming a side", () => {
  it("prefers the branch name when the commit is a branch tip", () => {
    expect(nameSide(side({ ref: "origin/main" }), "x")).toBe("origin/main");
  });

  it("falls back to the commit itself, not to a branch it is not", () => {
    // The commit a rebase is replaying is a commit in the middle of a series.
    // Calling it by the branch name says the tip, which is somewhere else.
    expect(nameSide(side(), "x")).toBe("teach the rail to fold (9f2c1ab)");
  });

  it("uses the short hash when there is no subject either", () => {
    expect(nameSide(side({ subject: "" }), "x")).toBe("9f2c1ab");
  });

  it("falls back when there is no side at all", () => {
    expect(nameSide(null, "the other side")).toBe("the other side");
  });
});

describe("the read beats the deduction", () => {
  it("names the ref git is actually merging, not the checkout's base", () => {
    // branch().base is "main"; git is merging a hotfix. The old sentence said
    // main, confidently, and it was somebody else's branch.
    const s = text("/r", branch(), repo(), "merging", ["a.ts"], info({ theirs: side({ ref: "hotfix/token-expiry" }) }));
    expect(s).toContain("hotfix/token-expiry");
    expect(s).not.toContain('"theirs"/MERGE_HEAD is main');
  });

  it("names both sides of a rebase from the read, and says which commit", () => {
    const s = text("/r", branch(), repo(), "rebasing", ["a.ts"],
      info({ state: "rebasing", ours: side({ ref: "main" }), theirs: side(), step: 2, total: 5 }));
    expect(s).toContain("inverted");
    expect(s).toContain('"ours" is main');
    expect(s).toContain("commit 2 of 5");
  });

  it("still works for a caller that has not read the operation", () => {
    // PrPanel builds this before any merge is running. The old deduction is
    // the fallback, not a second source of truth.
    const s = text("/r", branch(), repo(), "merging", ["a.ts"]);
    expect(s).toContain('"theirs"/MERGE_HEAD is main');
  });
});

describe("saying that a rebase repeats", () => {
  it("counts the commits when there is a series", () => {
    expect(stepLabel(info({ step: 3, total: 9 }))).toBe("commit 3 of 9");
  });

  it("says nothing for a merge, which happens once", () => {
    expect(stepLabel(info())).toBeNull();
  });

  it("says nothing for a one-commit rebase — there is no series to count", () => {
    expect(stepLabel(info({ step: 1, total: 1 }))).toBeNull();
  });
});

describe("the band labels", () => {
  it("are the real refs, so the two colours mean something", () => {
    expect(bandLabels(info(), "whatever")).toEqual({ ours: "main", theirs: "feat" });
  });

  it("fall back to the branch on screen when nothing is stopped", () => {
    expect(bandLabels(null, "feat/rail-layout").ours).toBe("feat/rail-layout");
  });
});
