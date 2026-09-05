/*
 * One timeline for a card, and the two rules that make it readable.
 *
 * Asked for after using the Comments tab beside ClickUp's Activity pane: the card's
 * own history — who opened it, and how it moved through the board — was only
 * available on the website. Both rules below are ClickUp's own, and both were said
 * out loud when it was asked for:
 *
 *   "they must not be counted as comments"  the count stays comments.
 *   "so the scroll doesn't get too long"  a run of history folds.
 */
import { describe, expect, it } from "bun:test";
import type { CardEvent } from "../../shared/providers.ts";
import { FOLD_FROM, activityCount, activityRows, eventLine, foldLabel, folds } from "../src/lib/cardActivity.ts";

const c = (id: string, at: number) => ({ id, at });
const ev = (at: number, over: Partial<CardEvent> = {}): CardEvent => ({ at, kind: "status", status: "code review", ...over });

describe("the timeline", () => {
  it("is oldest first, whichever list a row came from", () => {
    const rows = activityRows([c("a", 300)], [ev(100), ev(500)]);
    expect(rows.map((r) => r.kind)).toEqual(["events", "comment", "events"]);
    expect(rows.map((r) => r.at)).toEqual([100, 300, 500]);
  });

  it("groups consecutive events into one row", () => {
    const rows = activityRows([c("a", 400)], [ev(100), ev(200), ev(300), ev(500)]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: "events" });
    expect((rows[0] as { events: CardEvent[] }).events).toHaveLength(3);
    expect(rows[1]!.kind).toBe("comment");
    expect((rows[2] as { events: CardEvent[] }).events).toHaveLength(1);
  });

  // A comment landing in the same second as a status change is almost always the
  // reason for it — "Triaged — P2 Normal" and the move to Ready for engineering —
  // and the sentence only makes sense after the move.
  it("puts an event before a comment that shares its timestamp", () => {
    const rows = activityRows([c("a", 100)], [ev(100)]);
    expect(rows.map((r) => r.kind)).toEqual(["events", "comment"]);
  });

  it("keeps a run's identity across a re-fetch", () => {
    const events = [ev(100), ev(200)];
    const first = activityRows([], events);
    const again = activityRows([c("new", 900)], events);
    // Same id, so a fold somebody opened does not close when a comment arrives.
    expect((first[0] as { id: string }).id).toBe((again[0] as { id: string }).id);
  });

  it("is empty for a card with nothing on it, rather than a row saying so", () => {
    expect(activityRows([], [])).toEqual([]);
  });
});

describe("what folds", () => {
  // ClickUp folds a run of two the same as a run of fifteen, and matching it is his
  // call: what the fold protects is the shape of the column, not the pixels.
  it("a run of two or more", () => {
    expect(folds(activityRows([], [ev(1), ev(2)])[0]!)).toBe(true);
    expect(folds(activityRows([], [ev(1), ev(2), ev(3)])[0]!)).toBe(true);
    expect(FOLD_FROM).toBe(2);
  });

  it("and never a single one — there is nothing to hide behind a toggle", () => {
    expect(folds(activityRows([], [ev(1)])[0]!)).toBe(false);
  });

  it("never a comment", () => {
    expect(folds(activityRows([c("a", 1)], [])[0]!)).toBe(false);
  });

  it("says how much it is hiding", () => {
    expect(foldLabel(1)).toBe("1 change");
    expect(foldLabel(12)).toBe("12 changes");
  });
});

describe("the count on the tab", () => {
  // The number is what a board is scanned with. A card with four comments and
  // thirty status changes is a card with four comments.
  it("is comments, and automation cannot inflate it", () => {
    expect(activityCount([c("a", 1), c("b", 2)])).toBe(2);
    expect(activityCount([])).toBe(0);
  });
});

describe("what an event says", () => {
  it("names who opened the card, because that is the one the API names", () => {
    expect(eventLine({ at: 1, kind: "created", who: "Karla V", status: "to do" }))
      .toBe("Karla V created this card in to do");
    expect(eventLine({ at: 1, kind: "created", who: "Karla V" })).toBe("Karla V created this card");
  });

  it("and never invents a person for a move", () => {
    const line = eventLine({ at: 1, kind: "status", from: "to do", status: "code review" });
    expect(line).toBe("Moved from to do to code review");
    expect(line).not.toContain("Karla");
  });

  it("survives a creation whose author the workspace did not give", () => {
    expect(eventLine({ at: 1, kind: "created" })).toBe("Somebody created this card");
  });
});
