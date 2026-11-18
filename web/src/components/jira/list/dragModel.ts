/*
 * The board's pointer drag, pulled out of JiraBoard.tsx so the slot a card lands in, how far a press has to move
 * before it counts as a drag rather than a click, the edge the board auto-scrolls toward, and the confirm-then-commit
 * state machine for a drop can all be tested without a renderer.
 */

/** A press must move this far, on either axis, before it counts as a drag; short of it, the click that follows still
 *  opens the card. */
export const DRAG_THRESHOLD_PX = 4;
/** How long a drop with no answer waits before it reverts on its own: never moved without a yes. */
export const CONFIRM_TIMEOUT_MS = 6000;
/** The lifted card's tilt, in degrees, while it follows the pointer. */
export const LIFT_TILT_DEG = 2;
/** How close to the scroller's edge the pointer has to be before it auto-scrolls. */
export const EDGE_ZONE_PX = 48;
/** The fastest the board auto-scrolls, right at the edge itself, in px per tick. */
export const EDGE_MAX_PX_PER_TICK = 14;

/** Whether a press at `(dx, dy)` from where it started has gone far enough to be a drag. */
export const pastThreshold = (dx: number, dy: number): boolean => Math.abs(dx) >= DRAG_THRESHOLD_PX || Math.abs(dy) >= DRAG_THRESHOLD_PX;

export interface CardTop { id: string; top: number; height: number }

/** Where in a column (top to bottom) a card dropped at `pointerY` lands: the count of `rects` whose own midpoint sits
 *  above the pointer. `rects` is the column's cards, in the order they are drawn. */
export function slotIndex(pointerY: number, rects: readonly CardTop[]): number {
  let i = 0;
  for (const r of rects) {
    if (pointerY < r.top + r.height / 2) break;
    i++;
  }
  return i;
}

export interface EdgeScroll { dir: -1 | 0 | 1; px: number }

/** Whether, and how fast, the board should auto-scroll because the pointer sits inside `EDGE_ZONE_PX` of the
 *  scroller's left or right edge. Speed rises the closer the pointer gets to the edge itself. */
export function edgeScroll(pointerX: number, bounds: { left: number; right: number }): EdgeScroll {
  const fromLeft = pointerX - bounds.left;
  const fromRight = bounds.right - pointerX;
  if (fromLeft >= 0 && fromLeft < EDGE_ZONE_PX) return { dir: -1, px: Math.ceil(EDGE_MAX_PX_PER_TICK * (1 - fromLeft / EDGE_ZONE_PX)) };
  if (fromRight >= 0 && fromRight < EDGE_ZONE_PX) return { dir: 1, px: Math.ceil(EDGE_MAX_PX_PER_TICK * (1 - fromRight / EDGE_ZONE_PX)) };
  return { dir: 0, px: 0 };
}

/** A drop sitting in its new column, waiting for a yes. */
export interface PendingMove { cardId: string; from: string; to: string; expiresAt: number }

export const startPending = (cardId: string, from: string, to: string, now: number): PendingMove =>
  ({ cardId, from, to, expiresAt: now + CONFIRM_TIMEOUT_MS });

/** Whether a pending move's silent window is up: it goes back on its own, the same as an explicit no. */
export const pendingExpired = (p: PendingMove, now: number): boolean => now >= p.expiresAt;
