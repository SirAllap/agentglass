/*
 * Where a picker opened from the pull-request sidebar goes.
 *
 * The people picker was placed against the window alone: right edge on the
 * pencil, left edge wherever 440px put it, and only the viewport to stop it. In
 * a 248px sidebar that is a box hanging left over the Reviewers block, and at
 * 91% zoom its right edge sat past the panel's own edge. The panel is the box
 * it belongs to, so that is the box it is placed in.
 *
 * `placeMenu` (menuPlacement.ts) does the same arithmetic against the window;
 * this is the same rule against a box that is not the window, and it takes the
 * gap and margin from there so a picker and a menu cannot disagree about how
 * far from its trigger they sit. The width is clamped to the box as well: a
 * picker narrower than its content scrolls, where one wider than the panel
 * would hang over the diff.
 */
import type { Box } from "./menuPlacement.ts";
import { MENU_GAP, MENU_MARGIN } from "./menuPlacement.ts";

export type PickerPlacement = {
  left: number;
  top: number;
  /** The width drawn. Clamped to the box when the wanted one does not fit. */
  width: number;
  /** The height drawn: the natural one, capped by the room on the chosen side. */
  height: number;
  /** The room on the chosen side, for a list that scrolls inside itself. */
  maxHeight: number;
  side: "below" | "above";
};

export function placeInBox(
  anchor: Box,
  size: { width: number; height: number },
  box: Box,
  gap = MENU_GAP,
  pad = MENU_MARGIN,
  /** The side to open on when it fits there. Above is for a picker whose trigger sits over something that must stay visible. */
  prefer: "below" | "above" = "below",
): PickerPlacement {
  const width = Math.max(0, Math.min(size.width, box.right - box.left - pad * 2));
  // Edge to edge with the pencil on the right, the way a menu hangs off its
  // trigger, then shifted back inside the box if the panel is too narrow.
  const wanted = anchor.right - width;
  const left = Math.max(box.left + pad, Math.min(wanted, box.right - width - pad));
  const below = box.bottom - pad - (anchor.bottom + gap);
  const above = anchor.top - gap - (box.top + pad);
  // A side that fits wins, and so does the one asked for while it can still draw half the picker: a box
  // cut down to one row is not a list. Otherwise the roomier one — a flip that gains a few pixels moves
  // the box somewhere the eye is not.
  const room = { below, above };
  const other = prefer === "below" ? "above" : "below";
  const side = room[prefer] >= size.height || (prefer === "above" && above >= size.height / 2)
    ? prefer
    : room[prefer] >= room[other] ? prefer : other;
  const space = Math.max(0, room[side]);
  const height = Math.min(size.height, space);
  const top = side === "below" ? anchor.bottom + gap : anchor.top - gap - height;
  return { left, top, width, height, maxHeight: space, side };
}
