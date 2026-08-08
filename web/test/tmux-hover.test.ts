// Which tmux pane the pointer is over.
//
// The numbers here are a real window: 277 columns by 66 rows, split down the
// middle, which is the layout this was built for. tmux reports inclusive
// bounds, so the two halves meet at 137/139 with the divider column between
// them — and that column belongs to neither, which is the case that decides
// whether crossing a split reads as one clean switch or as a flicker.
import { describe, expect, it } from "bun:test";
import { cellAt, paneAt } from "../src/lib/tmuxHover.ts";
import type { TmuxPane } from "../../shared/types.ts";

const COLS = 277, ROWS = 66;
/** The terminal as it is drawn: 1940×1030 CSS pixels at some offset. */
const RECT = { left: 50, top: 120, width: COLS * 7, height: ROWS * 15 };

const pane = (p: Partial<TmuxPane> & { id: string }): TmuxPane =>
  ({ left: 0, top: 0, right: COLS - 1, bottom: ROWS - 1, active: false, zoomed: false, ...p });

/** Left half active, right half not — the screenshot this came from. */
const SPLIT: TmuxPane[] = [
  pane({ id: "%1", left: 0, right: 137, active: true }),
  pane({ id: "%2", left: 139, right: 276 }),
];

describe("a pixel becomes a cell", () => {
  it("puts the top-left pixel in the top-left cell", () => {
    expect(cellAt(RECT, COLS, ROWS, RECT.left + 1, RECT.top + 1)).toEqual({ col: 0, row: 0 });
  });

  it("puts the last pixel in the last cell, not one past it", () => {
    // The pane container can be a few pixels taller than a whole number of
    // rows; the row that remainder produces is `rows`, which is not a cell.
    expect(cellAt(RECT, COLS, ROWS, RECT.left + RECT.width - 1, RECT.top + RECT.height - 1))
      .toEqual({ col: COLS - 1, row: ROWS - 1 });
  });

  it("says nothing about a point outside the grid", () => {
    expect(cellAt(RECT, COLS, ROWS, RECT.left - 1, RECT.top + 10)).toBe(null);
    expect(cellAt(RECT, COLS, ROWS, RECT.left + 10, RECT.top - 1)).toBe(null);
    expect(cellAt(RECT, COLS, ROWS, RECT.left + RECT.width + 1, RECT.top + 10)).toBe(null);
    expect(cellAt(RECT, COLS, ROWS, RECT.left + 10, RECT.top + RECT.height + 1)).toBe(null);
  });

  it("refuses to divide by a grid that has no size", () => {
    // A terminal that has not been measured yet. Answering would be answering
    // with Infinity, and Infinity lands in whichever pane is listed first.
    expect(cellAt(RECT, 0, ROWS, RECT.left + 10, RECT.top + 10)).toBe(null);
    expect(cellAt({ ...RECT, width: 0 }, COLS, ROWS, RECT.left, RECT.top)).toBe(null);
  });
});

describe("a cell becomes a pane", () => {
  it("finds the half the cell is in", () => {
    expect(paneAt(SPLIT, 10, 10)?.id).toBe("%1");
    expect(paneAt(SPLIT, 200, 10)?.id).toBe("%2");
  });

  it("treats the bounds as inclusive, the way tmux reports them", () => {
    expect(paneAt(SPLIT, 137, 0)?.id).toBe("%1");
    expect(paneAt(SPLIT, 139, 65)?.id).toBe("%2");
  });

  it("gives the divider to neither", () => {
    // Column 138 is the rule between the panes. Handing it to one of them would
    // make the switch happen a column early, which is a flicker when the
    // pointer travels along the divider.
    expect(paneAt(SPLIT, 138, 20)).toBe(null);
  });

  it("gives tmux's status row to no pane at all", () => {
    // The panes stop at row 65 of a 66-row window when tmux draws a status
    // line; hovering it is hovering the window, not a pane.
    const withStatus = SPLIT.map((p) => ({ ...p, bottom: 64 }));
    expect(paneAt(withStatus, 10, 65)).toBe(null);
  });

  it("refuses to answer while something is zoomed", () => {
    // A zoomed pane covers the window and its neighbours keep the bounds they
    // had, so two panes claim the same cell. Choosing between them would move
    // the keyboard into a pane that is not on screen.
    const zoomed = [
      pane({ id: "%1", left: 0, right: 276, active: true, zoomed: true }),
      pane({ id: "%2", left: 139, right: 276, zoomed: true }),
    ];
    expect(paneAt(zoomed, 200, 10)).toBe(null);
  });

  it("has nothing to say about an unsplit window", () => {
    expect(paneAt([], 10, 10)).toBe(null);
  });
});
