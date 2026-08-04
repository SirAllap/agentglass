// The names an issue turns into.
//
// Worth pinning because they are permanent in a way the rest of this feature is
// not: a branch is pushed, reviewed and merged under whatever this function
// produced, and a worktree path is where somebody's uncommitted work lives.
// Both are also the kind of thing that only breaks on the awkward title nobody
// tested — a colon, an emoji, a title that is one long word.
import { describe, expect, test } from "bun:test";
import { branchNameFor, worktreePathFor } from "../src/issues.ts";

describe("branchNameFor", () => {
  test("number first, then enough title to recognise it", () => {
    expect(branchNameFor(455, "Theme sync repaints the user's own tmux"))
      .toBe("issue-455-theme-sync-repaints-the-users-own-tmux");
  });

  test("the number leads, because that is what sorts and greps", () => {
    expect(branchNameFor(7, "Anything")).toStartWith("issue-7-");
  });

  test("everything git would refuse is dropped, not escaped", () => {
    // A branch name is not a place to be clever, and gh hands back whatever the
    // author typed — slashes, colons, brackets, emoji.
    const b = branchNameFor(12, "[feat]: run agents/other than Claude ✨ (chat pane)");
    expect(b).toMatch(/^[a-z0-9-]+$/);
    expect(b).toStartWith("issue-12-feat-run-agents");
  });

  test("truncated on a word boundary, never mid-word", () => {
    const b = branchNameFor(99, "Composable workspace move resize drop individual panels not just global zoom");
    expect(b.length).toBeLessThan(56);
    // Whatever it ends with must be a whole word from the title.
    const last = b.split("-").pop()!;
    expect("composable workspace move resize drop individual panels not just global zoom".split(" ")).toContain(last);
  });

  test("a title that survives nothing still gives a usable branch", () => {
    expect(branchNameFor(3, "🎉🎉🎉")).toBe("issue-3");
    expect(branchNameFor(3, "")).toBe("issue-3");
  });

  test("one enormous word does not produce an empty tail", () => {
    // The first word is kept even when it blows the budget on its own —
    // `issue-5` alone would be indistinguishable from the empty-title case.
    const b = branchNameFor(5, "supercalifragilisticexpialidociousandthensome");
    expect(b).toStartWith("issue-5-supercalifragilistic");
  });

  test("no leading or trailing dashes, which git rejects", () => {
    for (const t of ["  spaces  ", "---dashes---", "!!!", "a"]) {
      const b = branchNameFor(1, t);
      expect(b).not.toContain("--");
      expect(b.endsWith("-")).toBe(false);
    }
  });
});

describe("worktreePathFor", () => {
  test("beside the repository, not inside it", () => {
    // Inside would put the copy in the repo's own ignore rules, watchers and
    // ripgrep results — every tool in the app would see the codebase twice.
    const p = worktreePathFor("/home/u/code/orbit", 455, "Theme sync repaints");
    expect(p).toBe("/home/u/code/orbit-issue-455-theme-sync-repaints");
    expect(p.startsWith("/home/u/code/orbit/")).toBe(false);
  });

  test("named after the repo, so a directory listing is readable", () => {
    const p = worktreePathFor("/home/u/code/orbit", 7, "Fix the thing");
    expect(p.split("/").pop()).toBe("orbit-issue-7-fix-the-thing");
  });

  test("two issues never collide", () => {
    const a = worktreePathFor("/r/p", 1, "Same title");
    const b = worktreePathFor("/r/p", 2, "Same title");
    expect(a).not.toBe(b);
  });

  test("the same issue always resolves to the same place", () => {
    // Restarting work must find the existing worktree rather than cut a second.
    expect(worktreePathFor("/r/p", 9, "A title")).toBe(worktreePathFor("/r/p", 9, "A title"));
  });
});
