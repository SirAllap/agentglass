// What "Update branch" says when GitHub refuses it, and whether the refusal is
// one the panel can act on.
//
// The merge runs on GitHub's side, so a conflict is not a half-merged tree to
// clean up — it is gh exiting non-zero with a sentence. The panel used to show
// that sentence and stop. A conflict is the one refusal with somewhere to go
// (merge it in a worktree, resolve it there), so it comes back marked, and the
// panel keys the resolve actions on the mark rather than on the wording.
//
// The raw strings are the shapes gh prints: the GraphQL error the API returns,
// and gh's own summary line in front of it.
import { describe, expect, test } from "bun:test";
import { updateBranchRefusal } from "../src/prs.ts";

describe("a conflict", () => {
  for (const raw of [
    "GraphQL: merge conflict between base and head (updatePullRequestBranch)",
    "X Cannot update PR branch due to conflicts",
  ]) {
    test(`is marked as one: ${raw}`, () => {
      const r = updateBranchRefusal(raw);
      expect(r).not.toBeNull();
      expect(r!.ok).toBe(false);
      expect(r!.conflict).toBe(true);
      // The sentence says what to do, and names no button: API callers read
      // it as well as the panel.
      expect(r!.error).toMatch(/resolve the conflict, then push/);
    });
  }
});

describe("a refusal that is not a conflict", () => {
  test("\"not mergeable\" is reworded but not marked — it does not say why", () => {
    const r = updateBranchRefusal("failed to update branch: Pull Request is not mergeable");
    expect(r).not.toBeNull();
    expect(r!.conflict).toBeUndefined();
    expect(r!.error).toMatch(/conflicts with its base/);
  });

  test("a locked branch is explained but not marked", () => {
    const r = updateBranchRefusal("GraphQL: Can not update a locked branch (updatePullRequestBranch)");
    expect(r).not.toBeNull();
    expect(r!.conflict).toBeUndefined();
    expect(r!.error).toMatch(/locked or protected/);
  });

  test("anything else is left to the caller as gh said it", () => {
    expect(updateBranchRefusal("could not resolve to a PullRequest with the number of 1042")).toBeNull();
    expect(updateBranchRefusal("")).toBeNull();
  });
});
