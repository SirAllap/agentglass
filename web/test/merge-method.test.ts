/*
 * Which way a pull request lands, and who decides.
 *
 * The panel opened on "Squash & merge" everywhere, because a constant said so.
 * On a repository whose convention is the merge commit — where the whole team
 * presses the blue button and changes nothing — that made the default the one
 * thing nobody wanted, on the one control that cannot be undone. And it was
 * component state, so a choice made in the menu was thrown away by a trip to
 * the Files tab.
 *
 * What is pinned here is the rule, not today's wording: the repository decides
 * what is on offer, the remembered choice wins while it is still on offer, and
 * the subject that lands on the base branch reads like the method that wrote
 * it. Plus one rule over the panel itself, because the failure was a hard-coded
 * string and a comment cannot stop the next one.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { allowedMethods, mergeBody, mergeSubject, pickMergeMethod } from "../src/lib/mergeMethod.ts";
import type { PrMergePolicy } from "../../shared/types.ts";

const policy = (allowed: PrMergePolicy["allowed"], rest: Partial<PrMergePolicy> = {}): PrMergePolicy =>
  ({ allowed, auto: false, deletesBranch: false, ...rest });

describe("what the repository allows", () => {
  it("offers all three when it has not said", () => {
    // A repository that answers nothing must not end up with an empty menu:
    // the methods do work, we simply do not know which. Narrowing is only ever
    // done on evidence.
    expect(allowedMethods(undefined)).toEqual(["merge", "squash", "rebase"]);
    expect(allowedMethods(policy([]))).toEqual(["merge", "squash", "rebase"]);
  });

  it("offers only what it permits", () => {
    expect(allowedMethods(policy(["squash"]))).toEqual(["squash"]);
  });
});

describe("the method the panel opens on", () => {
  it("is the one GitHub's own button opens on", () => {
    // The whole point. GitHub checks the merge commit where it is allowed, so
    // opening the pull request and pressing merge does the same thing in both
    // places.
    expect(pickMergeMethod(undefined, policy(["merge", "squash", "rebase"]))).toBe("merge");
    expect(pickMergeMethod(undefined, undefined)).toBe("merge");
  });

  it("is your last choice on this repository, when it is still allowed", () => {
    expect(pickMergeMethod("squash", policy(["merge", "squash", "rebase"]))).toBe("squash");
  });

  it("falls back rather than offering something the repository forbids", () => {
    // Squash turned off after somebody had chosen it. The button must not go
    // on saying "Squash & merge" until it is pressed and gh refuses.
    expect(pickMergeMethod("squash", policy(["merge", "rebase"]))).toBe("merge");
  });
});

describe("the subject that lands on the base branch", () => {
  const pr = { title: "Give a conflicted pull request somewhere to go", number: 7, headRefName: "fix/thing", headRepoOwner: "someone" };

  it("reads like a merge commit when it is one", () => {
    expect(mergeSubject("merge", pr)).toBe("Merge pull request #7 from someone/fix/thing");
  });

  it("keeps the squash convention for a squash", () => {
    expect(mergeSubject("squash", pr)).toBe(`${pr.title} (#7)`);
  });

  it("names nothing for a rebase, which writes no commit of its own", () => {
    expect(mergeSubject("rebase", pr)).toBeUndefined();
  });

  it("still says something useful with no owner or branch to name", () => {
    expect(mergeSubject("merge", { title: "x", number: 7 })).toBe("Merge pull request #7");
  });
});

describe("the extended description", () => {
  // The dialog asked for a subject and nothing else, so everything a merge
  // could have SAID landed empty — and a squash took twenty commit messages
  // down with the branch. GitHub prefills this field, differently per method.
  const pr = { title: "Round prices at the cart boundary" };
  const c = (message: string, body?: string, isMerge = false) => ({ message, body, isMerge });

  it("gives a merge commit the pull request's title", () => {
    // The subject is `Merge pull request #7 from …`, which names a branch and
    // not the work. The title under it is what makes the log readable.
    expect(mergeBody("merge", pr, [c("whatever")])).toBe(pr.title);
  });

  it("writes nothing for a rebase", () => {
    expect(mergeBody("rebase", pr, [c("whatever")])).toBeUndefined();
  });

  it("gives a one-commit squash that commit's own body, not its subject", () => {
    // The subject line is already in the subject field as `Title (#7)`;
    // repeating it under itself is the shape nobody wants.
    expect(mergeBody("squash", pr, [c("Round at the boundary", "Rounding ran per line\nand again on the subtotal.")]))
      .toBe("Rounding ran per line\nand again on the subtotal.");
  });

  it("lists the commits a squash is about to destroy", () => {
    expect(mergeBody("squash", pr, [c("First"), c("Second"), c("Third")]))
      .toBe("* First\n\n* Second\n\n* Third");
  });

  it("indents a commit's body under its own bullet", () => {
    // Otherwise the third commit's paragraph reads as a fourth list item.
    expect(mergeBody("squash", pr, [c("First", "why it was needed"), c("Second")]))
      .toBe("* First\n\n  why it was needed\n\n* Second");
  });

  it("leaves the branch's own merge commits out of a squash", () => {
    // "Merge branch 'main' into feature" is plumbing the squash is in the
    // middle of erasing. It is never part of what the change did.
    expect(mergeBody("squash", pr, [c("First"), c("Merge branch 'main' into feature", undefined, true), c("Second")]))
      .toBe("* First\n\n* Second");
  });

  it("says nothing rather than guessing when there are no commits to quote", () => {
    expect(mergeBody("squash", pr, [])).toBe("");
    expect(mergeBody("squash", pr, [c("Merge branch 'main'", undefined, true)])).toBe("");
  });
});

describe("the panel", () => {
  const PANEL = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url).pathname, "utf8");

  it("never picks the method for you", () => {
    // Every one of these was a literal in a call: the merge itself, and — the
    // one that actually contradicted the screen — auto-merge, which armed a
    // squash while the button in front of you said merge commit.
    expect(PANEL).not.toMatch(/prMerge\([^)]*["']squash["']/);
    expect(PANEL).not.toMatch(/prMerge\([^)]*["']merge["']/);
    expect(PANEL).not.toMatch(/prMerge\([^)]*["']rebase["']/);
  });

  it("asks the repository what to offer", () => {
    // The rule above passes trivially on a file that no longer merges at all.
    expect(PANEL).toContain("allowedMethods(d.mergePolicy)");
    expect(PANEL).toContain("pickMergeMethod(");
  });

  it("sends what the merge form was filled in with, not just a subject", () => {
    // The body was accepted by the API and the server all along and the panel
    // never sent one, so every merge from here landed with an empty extended
    // description. And the head branch was deleted from a value the dialog
    // never showed.
    expect(PANEL).toContain("askMerge({");
    expect(PANEL).toContain("subject: choice.subject");
    expect(PANEL).toContain("body: choice.body");
    expect(PANEL).toContain("deleteBranch: choice.deleteBranch");
  });
});
