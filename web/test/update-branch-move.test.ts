/*
 * "Update branch" says what it is going to do to this machine.
 *
 * The button merges the base into the head on GitHub, and that is all it has
 * ever done — so every press left the copy of that branch on disk one commit
 * staler, silently. You find out later, from a rejected push or a diff that
 * disagrees with the pull request you just read.
 *
 * What is pinned here is the split: exactly one state asks the server to touch
 * anything local (a branch that can be fast-forwarded), and every other state
 * has to produce a sentence instead. A machine with a dozen worktrees and an
 * agent in each is not somewhere to move a HEAD to save somebody a `git pull`.
 */
import { describe, expect, it } from "bun:test";
import { updateBranchMove } from "../src/lib/updateBranch.ts";
import type { PrLocalHead } from "../../shared/types.ts";

const head = (over: Partial<PrLocalHead> = {}): PrLocalHead =>
  ({ branch: "feat/thing", exists: true, ahead: 0, behind: 1, dirty: false, sync: "ff", ...over });

describe("when there is nothing local to bring along", () => {
  it("behaves exactly as it did before if the server said nothing", () => {
    const m = updateBranchMove(56, "main", undefined);
    expect(m.label).toBe("↻ Update branch · 56 behind");
    expect(m.syncLocal).toBe(false);
    expect(m.note).toBeUndefined();
  });

  it("says nothing extra when this branch has no local copy", () => {
    const m = updateBranchMove(3, "main", head({ exists: false, sync: "absent" }));
    expect(m.label).toBe("↻ Update branch · 3 behind");
    expect(m.syncLocal).toBe(false);
    expect(m.note).toBeUndefined();
  });
});

describe("when the local copy can come along", () => {
  it("says so on the button, and asks for it", () => {
    const m = updateBranchMove(56, "main", head({ worktree: "/home/x/code/thing" }));
    expect(m.label).toBe("↻ Update branch & pull · 56 behind");
    expect(m.syncLocal).toBe(true);
    expect(m.note).toBeUndefined();
    expect(m.title).toContain("/home/x/code/thing");
  });

  it("still says so for a branch nobody has checked out — the easiest case of all", () => {
    // No working tree is involved: the ref moves, git enforces the
    // fast-forward, and nobody's editor sees anything change.
    const m = updateBranchMove(1, "main", head({ worktree: undefined }));
    expect(m.syncLocal).toBe(true);
    expect(m.title).toContain("local feat/thing");
  });
});

describe("when it cannot", () => {
  it("does not ask for a sync, and says why — uncommitted changes", () => {
    const m = updateBranchMove(56, "main", head({ sync: "dirty", dirty: true, worktree: "/home/x/code/agentglass-work" }));
    expect(m.syncLocal).toBe(false);
    expect(m.label).toBe("↻ Update branch · 56 behind");
    expect(m.note).toContain("uncommitted changes in agentglass-work");
    expect(m.note).toContain("stays put");
  });

  it("does not ask for a sync, and says why — local commits GitHub has not got", () => {
    const m = updateBranchMove(4, "main", head({ sync: "diverged", ahead: 2 }));
    expect(m.syncLocal).toBe(false);
    expect(m.note).toContain("2 commits GitHub does not have");
  });

  it("does not ask for a sync, and says why — that checkout is mid-merge", () => {
    const m = updateBranchMove(4, "main", head({ sync: "busy", worktree: "/home/x/code/wt" }));
    expect(m.syncLocal).toBe(false);
    expect(m.note).toContain("mid-merge");
  });

  it("counts in singular where it should", () => {
    const m = updateBranchMove(1, "main", head({ sync: "diverged", ahead: 1 }));
    expect(m.note).toContain("1 commit GitHub");
    expect(updateBranchMove(1, "main", undefined).title).toContain("1 commit behind");
  });
});
