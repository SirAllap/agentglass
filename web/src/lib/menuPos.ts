/*
 * Where a menu goes when it hangs under something.
 *
 * Two separate reports, one arithmetic. In the card view a 260px box anchored
 * `absolute right-0` inside a cell that sits well to the left ran off the LEFT
 * of the pane and took its filter box with it — "ilter people…", cut down the
 * middle. Beside the pull request the same kind of list opened at the bottom
 * right of the sidebar and ran off the window: "that selection modal goes
 * off-screen".
 *
 * So it is measured against the viewport and clamped into it, and the clamp is
 * here rather than inline because both callers need exactly the same one and
 * the awkward cases — a trigger near the bottom, a window narrower than the
 * menu — are worth checking without a browser.
 */

/** The size the people picker is drawn at. Shared so the clamp and the box
 *  cannot disagree about how much room it needs. */
export const PICK_W = 260;
export const PICK_H = 320;

const PAD = 8;
/** Enough of a gap that the menu reads as belonging to the control rather than
 *  growing out of it. */
const GAP = 6;

export function menuUnder(
  anchor: { top: number; bottom: number; left: number },
  viewportWidth: number,
  viewportHeight: number,
  size: { width: number; height: number } = { width: PICK_W, height: PICK_H },
): { top: number; left: number } {
  /* Above the trigger when there is not room below it AND there is room above:
     a menu pinned to the bottom edge of the window under a control near the
     bottom covers the control it belongs to. */
  const below = viewportHeight - anchor.bottom - GAP - PAD;
  const above = anchor.top - GAP - PAD;
  const top = below >= size.height || below >= above
    ? Math.max(PAD, Math.min(anchor.bottom + GAP, viewportHeight - size.height - PAD))
    : Math.max(PAD, anchor.top - GAP - size.height);
  return {
    top: Math.round(top),
    left: Math.round(Math.max(PAD, Math.min(anchor.left, viewportWidth - size.width - PAD))),
  };
}
