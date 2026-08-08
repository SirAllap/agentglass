/*
 * Which tmux pane is the pointer over?
 *
 * The app's own splits are separate terminals — separate DOM, so the browser
 * answers this for free. tmux's splits are not: one terminal, one element, and
 * the "panes" are regions tmux painted into the same character grid. Nothing in
 * the DOM knows where the divider is.
 *
 * So the question is answered in tmux's own units. The pointer's pixel becomes
 * a CELL, and tmux already reports each pane's bounds in cells of the same
 * grid — the window's grid is the terminal's grid, which is why no scaling,
 * offset or device-pixel-ratio arithmetic appears anywhere here.
 *
 * Both halves are pure, and separately, because they fail for different
 * reasons: a pixel can land outside the terminal, and a cell can belong to no
 * pane at all (the status line tmux draws under them is exactly that).
 */
import type { TmuxPane } from "../../../shared/types.ts";

/** Just enough of a DOMRect to test without a DOM. */
export interface Box { left: number; top: number; width: number; height: number }

/**
 * The cell under a point, or null if the point is outside the grid.
 *
 * The rect has to be the one the grid is DRAWN in — xterm's screen element,
 * not the pane container, which can be a few pixels taller than a whole number
 * of rows. That remainder is what makes the bottom row report `rows`, one past
 * the end, and the check below is what keeps it from being treated as a cell.
 */
export function cellAt(rect: Box, cols: number, rows: number, x: number, y: number): { col: number; row: number } | null {
  if (cols <= 0 || rows <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const col = Math.floor((x - rect.left) / (rect.width / cols));
  const row = Math.floor((y - rect.top) / (rect.height / rows));
  if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
  return { col, row };
}

/**
 * The pane holding a cell, or null when no pane does.
 *
 * Null is a real answer and it happens twice: on the row tmux draws its status
 * line into, which belongs to the window rather than to any pane, and on a
 * window with something ZOOMED — where the zoomed pane covers everything while
 * its neighbours still report the bounds they had, so two panes claim the same
 * cell. Guessing between them would move the keyboard somewhere the user cannot
 * see, so nothing is guessed.
 *
 * Bounds are inclusive, as tmux reports them: a pane at `left 0, right 137` in
 * a 277-column window owns column 137 and not column 138, which is the divider.
 */
export function paneAt(panes: TmuxPane[], col: number, row: number): TmuxPane | null {
  if (panes.some((p) => p.zoomed)) return null;
  return panes.find((p) => col >= p.left && col <= p.right && row >= p.top && row <= p.bottom) ?? null;
}
