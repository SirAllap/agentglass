// What a repository allows is asked, not assumed — and the asking has to
// survive a repository node that came back without the answer.
//
// The panel used to decide all three of these on its own: squash as the
// method, auto-merge offered everywhere, and always "delete the branch". Each
// was wrong somewhere real. Squash is the method a repository is most likely
// to forbid; "Allow auto-merge" is off by default and its refusal arrives as
// the name of a GraphQL mutation; and a repository that deletes the head
// branch on merge turns `--delete-branch` into a second call whose only
// outcomes are "already gone" and a non-zero exit on a merge that landed.
//
// The fallback is the part worth pinning. When GitHub answers nothing — a
// partial response, an older host — the menu must widen to all three rather
// than empty, because an empty merge menu takes away methods that work.
import { describe, expect, test } from "bun:test";
import { mergePolicyOf } from "../src/prs.ts";

describe("the repository's merge policy", () => {
  test("is read straight from the repository's own flags", () => {
    expect(mergePolicyOf({
      mergeCommitAllowed: true,
      squashMergeAllowed: false,
      rebaseMergeAllowed: true,
      autoMergeAllowed: false,
      deleteBranchOnMerge: true,
    })).toEqual({ allowed: ["merge", "rebase"], auto: false, deletesBranch: true });
  });

  test("keeps GitHub's precedence, so the first is what its own button checks", () => {
    expect(mergePolicyOf({
      mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true,
    }).allowed).toEqual(["merge", "squash", "rebase"]);
  });

  test("widens rather than empties when nothing came back", () => {
    expect(mergePolicyOf(undefined).allowed).toEqual(["merge", "squash", "rebase"]);
    expect(mergePolicyOf({}).allowed).toEqual(["merge", "squash", "rebase"]);
  });

  test("treats a missing flag as off for the two that are permissions, not menus", () => {
    // Absent is not "allowed" here: offering auto-merge where it is off, or
    // skipping --delete-branch on a repository that does not delete, both fail
    // in ways the person pressing the button did not ask for.
    const p = mergePolicyOf({ mergeCommitAllowed: true });
    expect(p.auto).toBe(false);
    expect(p.deletesBranch).toBe(false);
  });
});
