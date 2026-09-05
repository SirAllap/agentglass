/*
 * The four strings ClickUp's GitHub panel hands you.
 *
 * The FORM is the contract, not a preference: the id inside the branch name is
 * what ClickUp looks for later and what this app's own search looks for, so a
 * branch named any other way stops being found by either side. Checked against
 * what ClickUp itself printed for that card.
 */
import { describe, expect, test } from "bun:test";
import { branchName, checkoutCommand, commitCommand, titleSlug, worktreeCommand } from "../src/lib/cardBranch.ts";

const ID = "ORBIT-1565";
const TITLE = "Alarm | Caller number not found in global search";

describe("the branch name", () => {
  test("the id, then the title with every separator as one hyphen", () => {
    expect(branchName(ID, TITLE)).toBe("ORBIT-1565-Alarm-Caller-number-not-found-in-global-search");
  });

  /* The detail everybody re-implementing this gets wrong: ClickUp keeps the
     case of the words. A lowercased branch is a branch its own scanner and ours
     both still find, but it is not the string it printed, and the point of this
     panel is that the two agree. */
  test("the case of the words is kept", () => {
    expect(titleSlug("Alarm | Caller Number")).toBe("Alarm-Caller-Number");
  });

  test("punctuation, runs of it, and the ends", () => {
    expect(titleSlug("  a — b: c!!  ")).toBe("a-b-c");
    expect(titleSlug("...leading and trailing...")).toBe("leading-and-trailing");
  });

  test("an accent keeps its letter", () => {
    // "Menú" is Menu, not Men — the mark goes, the letter stays.
    expect(titleSlug("Menú de opciones")).toBe("Menu-de-opciones");
  });

  test("a card with no title, and a title with no card", () => {
    expect(branchName(ID, "")).toBe("ORBIT-1565");
    expect(branchName("", TITLE)).toBe("Alarm-Caller-number-not-found-in-global-search");
  });
});

describe("the commands", () => {
  test("checkout quotes the branch", () => {
    expect(checkoutCommand(ID, TITLE)).toBe('git checkout -b "ORBIT-1565-Alarm-Caller-number-not-found-in-global-search"');
  });

  /* The commit line carries the title AS IT READS, not slugged: that is what
     ClickUp shows and what its commit scanner matches. */
  test("the commit line is the id, a dash and the real title", () => {
    expect(commitCommand(ID, TITLE)).toBe('git commit -m "ORBIT-1565 - Alarm | Caller number not found in global search"');
  });

  test("a quote in the title cannot break out of the command", () => {
    expect(commitCommand(ID, 'He said "no"')).toBe(`git commit -m "ORBIT-1565 - He said 'no'"`);
  });

  test("the worktree goes beside the checkout, named for the card", () => {
    expect(worktreeCommand("/home/dev/code/orbit", ID, TITLE))
      .toBe('git -C "/home/dev/code/orbit" worktree add -b "ORBIT-1565-Alarm-Caller-number-not-found-in-global-search" "../orbit-ORBIT-1565"');
  });
});
