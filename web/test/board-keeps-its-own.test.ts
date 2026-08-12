/*
 * A board keeps what you did to it, and nothing else's.
 *
 * Reported as the important one: rolling up "In development" on one list rolled
 * it up on every other list too. The fold rode on the status NAME alone with
 * nothing saying which board — and the statuses come from one workspace, so
 * every list uses the same words. Folding anything folded it everywhere.
 *
 * The filters had this fixed already, by remembering them per board on the way
 * out and putting them back on the way in. The fold now travels in the same
 * record, which is the point of this test: not that the fold works, but that it
 * is carried by the mechanism that already knows a board is a place.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("what a board remembers", () => {
  it("keeps the rolled-up statuses with the rest of its state", () => {
    // In the record, not beside it: a second per-board store is a second thing
    // to remember to save, and it is the one that gets forgotten.
    expect(src).toContain("folded: Record<string, boolean>;");
    expect(src).toContain("filtersByBoard.current[leaving] = { q, tag, mineOnly, statusPick, readyOnly, folded };");
  });

  it("puts them back when you return to that board", () => {
    expect(src).toContain("setFolded(kept?.folded ?? {});");
  });

  it("opens a board you have never opened fully expanded", () => {
    /* `?? {}` and not `?? folded`: inheriting the last board's folds is exactly
       the bug, and it would come back the moment somebody "simplified" the
       fallback to keep what was on screen. */
    expect(src).not.toMatch(/setFolded\(kept\?\.folded \?\? folded\)/);
  });

  it("saves on the way OUT, so leaving a board is what records it", () => {
    // The same shape the filters use: the effect fires on the board id
    // changing, and `leaving` is the board that just lost the screen.
    expect(src).toContain("const leaving = landedOn.current;");
  });
});
