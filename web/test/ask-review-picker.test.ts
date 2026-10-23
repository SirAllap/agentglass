/*
 * "Ask someone to review" opens the people picker, never a box of logins.
 *
 * Nobody knows a colleague's login by heart, and a comma list gives no way to
 * see who has already been asked. Every way into a review request (the merge
 * box, the masthead menu, the sidebar pencil) now ends in the one FieldPicker.
 * There is no renderer in the tests, so the rule is asserted against source.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const merge = await Bun.file(new URL("../src/components/MergeBox.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

describe("one way to ask for a review", () => {
  test("the comma-separated reviewers dialog is gone", () => {
    expect(code(src)).not.toContain("Comma-separated logins");
    expect(code(src)).not.toContain("Reviewers on #");
    expect(code(src)).not.toContain("doReviewers");
  });

  test("the merge-box hero action opens the reviewers picker at the pressed button", () => {
    expect(code(src)).toMatch(/case "ask-review": onAskReview\(from\)/);
    expect(code(merge)).toContain("onAction(a, e.currentTarget.getBoundingClientRect())");
    expect(code(src)).toMatch(/askReviewers = [^\n]*openAt\("reviewers"/);
  });

  test("the masthead menu item hands over where it was pressed", () => {
    expect(code(src)).not.toMatch(/onClick=\{\(\) => \{ close\(\); onReviewers\(\); \}\}/);
    expect(code(src)).toMatch(/getBoundingClientRect\(\); close\(\); onReviewers\(/);
  });

  test("the picker pins who is already asked, from the open state, and marks the ticked rows", () => {
    expect(code(src)).toContain('heldLabel="Already asked"');
    expect(code(src)).toMatch(/options\.filter\(\(o\) => selected\.includes\(o\.value\)\)/);
    expect(code(src)).toContain("aria-pressed={on}");
  });
});
