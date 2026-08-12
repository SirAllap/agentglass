/*
 * Which branches get marked as litter, and — mostly — which do not.
 *
 * A branch list is where people decide what to delete, so the cost of the two
 * mistakes is not symmetric: missing a scratch branch leaves the list untidy,
 * marking a real one costs somebody a day. Nearly every test here is about the
 * second kind.
 *
 * The brief was "generic, and only what we know 100%". That ruled out most of
 * what was found in a real repo — `_x_probe`, `qbase`, `simprb`, `backup/…`
 * are obviously scratch to whoever made them and unrecognisable to us.
 */
import { describe, expect, it } from "bun:test";
import { isScratchBranch, scratchPr, scratchNote } from "../src/lib/scratchBranch.ts";

describe("branches cut only to read a pull request", () => {
  it("recognises the shape, with or without the separator", () => {
    // Both spellings turn up in one repo — different tools, different days.
    for (const b of ["pr-1042-review", "pr1042-review", "pr_1042_review", "pr/1042-review"]) {
      expect(scratchPr(b), b).toBe(1042);
    }
  });

  it("recognises the local counterpart the same way", () => {
    expect(scratchPr("pr-1039-local")).toBe(1039);
  });

  it("ignores case, because branch names are typed by hand", () => {
    expect(isScratchBranch("PR-1042-Review")).toBe(true);
  });

  it("marks a bare pr-<n> too, because the number is the whole name", () => {
    /* The suffix was never what made the name safe to classify. A name made of
       a pull request number and nothing else says WHICH pull request and
       nothing about the work — the same argument, with the suffix removed. */
    expect(scratchPr("pr-1057")).toBe(1057);
    expect(scratchPr("pr1058")).toBe(1058);
  });

  it("says it about the name, not about what is on the branch", () => {
    /* Measured before widening the rule: two bare ones in a working repository
       carried 2 and 4 commits of their own. A note claiming there is nothing on
       them would be a lie the row cannot back up. */
    expect(scratchNote("pr-1057")).not.toContain("not work");
    expect(scratchNote("pr-1057")).toContain("Named after");
  });

  it("needs a number, so a word that merely starts with pr is safe", () => {
    for (const b of ["pr-review", "print-local", "preview", "prod-local", "pr--review", "prod"]) {
      expect(isScratchBranch(b), b).toBe(false);
    }
  });

  it("does not match a real branch that happens to end in -local or -review", () => {
    // `release-2024-local` is not a pull request, and neither is a feature
    // branch somebody suffixed while testing.
    for (const b of ["release-2024-local", "ORBIT-1042-review", "checkout-v2-local", "feat/search-review"]) {
      expect(isScratchBranch(b), b).toBe(false);
    }
  });

  it("says nothing about scratch branches we cannot classify", () => {
    /* All of these were found in a real repo and all of them are litter — to
       the person who made them. A branch nobody can classify gets no mark. */
    for (const b of ["_x_probe", "qbase", "simprb", "backup/ORBIT-1042", "tmp", "wip"]) {
      expect(isScratchBranch(b), b).toBe(false);
    }
  });

  it("never marks a trunk, whatever else changes", () => {
    for (const b of ["main", "master", "develop", "trunk"]) expect(isScratchBranch(b), b).toBe(false);
  });

  it("survives surrounding whitespace, which a ref list can carry", () => {
    expect(scratchPr("  pr-1042-review  ")).toBe(1042);
  });

  it("refuses a number nobody would issue rather than printing #0", () => {
    expect(scratchPr("pr-0-review")).toBeNull();
  });

  it("names the pull request in the note, so the mark can be checked", () => {
    // Checked against GitHub, not trusted: the note carries the number.
    expect(scratchNote("pr-1042-review")).toContain("#1042");
    expect(scratchNote("ORBIT-1042")).toBe("");
  });
});
