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
import { tagChoices, tagSources } from "../src/lib/cardEdits.ts";

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

/*
 * AND WHERE THE LIST COMES FROM.
 *
 * The picker offered only what the loaded cards carried — seven tags on the
 * board this was reported from, against 571 defined in that space. Complete
 * enough to look right, and the missing 564 had to be typed from memory, which
 * is the same near miss the tests above exist to prevent, one level up.
 */
describe("where the picker's tags come from", () => {
  test("the board's tags come first, then the rest of the space", () => {
    // The board's are the ones somebody on this board reaches for; sorting all
    // 571 alphabetically would bury them and be complete and useless.
    expect(tagSources(["qa", "backend"], ["access request", "backend", "zebra"], []))
      .toEqual(["qa", "backend", "access request", "zebra"]);
  });

  test("a tag already on the card is not offered again", () => {
    expect(tagSources(["backend", "qa"], ["frontend"], ["qa"])).toEqual(["backend", "frontend"]);
  });

  test("the same tag in two cases is offered once, in the board's spelling", () => {
    // ClickUp keeps `Backend` and `backend` apart, and offering both invites
    // exactly the duplicate this list exists to prevent.
    expect(tagSources(["Backend"], ["backend", "BACKEND"], [])).toEqual(["Backend"]);
    expect(tagSources([], ["backend"], ["Backend"])).toEqual([]);
  });

  test("blank names never reach the list", () => {
    expect(tagSources(["", "  "], ["ok", ""], [])).toEqual(["ok"]);
  });

  test("with the space unread, the board's tags still work", () => {
    // The space is fetched when the picker opens, so the first frame has none —
    // and an empty list there would be a picker that flashes empty on every open.
    expect(tagSources(["backend", "qa"], [], [])).toEqual(["backend", "qa"]);
  });

  test("a space's tags are filtered by typing like any other", () => {
    const known = tagSources(["qa"], ["access request", "account request", "backend"], []);
    const { rows, newAt } = tagChoices(known, [], "request");
    // The two matches, and then the offer to create `request` itself — nothing
    // is called exactly that, and that offer is the picker's other half.
    expect(rows).toEqual(["access request", "account request", "request"]);
    expect(newAt).toBe(2);
  });
});
