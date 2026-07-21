import { describe, expect, it } from "bun:test";
import { conflictBriefing, sidesOf, CONFLICT_ASK } from "../src/lib/conflictBrief.ts";
import type { GitBranchInfo, GitRepoRef } from "../../shared/types.ts";

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
