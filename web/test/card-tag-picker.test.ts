/*
 * THE TAG PICKER'S LIST.
 *
 * "the ones already created don't show up for me to pick properly… it just opens an
 * input" — it did: an empty box, and whatever you typed became a tag. The
 * failure that costs real time is not the typing, it is the near miss. A
 * `bug intake` typed from memory beside an existing `bug-intake` makes a
 * second tag that looks like the first and filters like neither, on a board
 * somebody else set up.
 */
import { describe, expect, test } from "bun:test";
import { tagChoices } from "../src/lib/cardEdits.ts";

describe("which tags the picker offers", () => {
  const board = ["bug-intake", "ai-triaged", "2026q3", "Access Request"];

  test("everything the board uses, minus what this card already has", () => {
    expect(tagChoices(board, ["ai-triaged"], "").rows).toEqual(["bug-intake", "2026q3", "Access Request"]);
  });

  test("typing filters, ignoring case, because the names do not agree on it", () => {
    expect(tagChoices(board, [], "ACCESS").rows[0]).toBe("Access Request");
    expect(tagChoices(board, [], "2026q3").rows).toEqual(["2026q3"]);
  });

  test("a name nobody uses is offered as a NEW tag, after the matches", () => {
    const r = tagChoices(board, [], "needs-design");
    expect(r.creating).toBe(true);
    expect(r.rows).toEqual(["needs-design"]);
    expect(r.newAt).toBe(0);
  });

  /* The one that made this rule: while you are typing, the row under the
     cursor is the one Enter takes. It must be the tag that already exists. */
  test("a partial match keeps the existing tag first and the new one last", () => {
    const r = tagChoices(board, [], "ACCESS");
    expect(r.rows).toEqual(["Access Request", "ACCESS"]);
    expect(r.newAt).toBe(1);
  });

  test("but never one that already exists in another case — that is the duplicate", () => {
    const r = tagChoices(board, [], "Bug-Intake");
    expect(r.creating, "offering to create a tag that is already there is how the second one gets made").toBe(false);
    expect(r.rows).toEqual(["bug-intake"]);
  });

  test("nor one the card already carries", () => {
    expect(tagChoices(board, ["needs-design"], "needs-design").creating).toBe(false);
  });

  test("an empty board still lets a first tag be typed", () => {
    const r = tagChoices([], [], "first-one");
    expect(r.creating).toBe(true);
    expect(r.rows).toEqual(["first-one"]);
    expect(r.newAt).toBe(0);
  });
});
