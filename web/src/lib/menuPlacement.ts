/*
 * Where a dropdown goes, decided once, with numbers and not with CSS.
 *
 * The PR panel's `Menu` used to hang its list off the trigger with
 * `position: absolute`, inside whatever contained the trigger. For a comment
 * that is a card with `overflow: hidden`, so the last row of a four-row menu
 * was cut off at the card's edge, measured on a fixture: a 4-row menu opened
 * from a card 60px above the bottom of its scroller lost its last 38px.
 * Portalling fixes the clipping; this fixes the other half, which is that the
 * list also has to stay on the screen.
 *
 * The rule is the one Select and BasePicker already follow (open downward,
 * flip up when down does not fit and up is roomier), except that a menu knows
 * its own height by the time this runs, so "does not fit" is a comparison with
 * the real size instead of a 220px guess. What it cannot do: it does not
 * follow the trigger if the page scrolls under an open menu. The menu lays a
 * catcher over the page, so nothing scrolls under it.
 */
export type Box = { left: number; top: number; right: number; bottom: number };

export type Placement = {
  left: number;
  top: number;
  /** The room on the chosen side. A list taller than that scrolls inside itself. */
  maxHeight: number;
  side: "below" | "above";
};

/** Gap between the trigger and the list, and the margin the list keeps from the window. */
export const MENU_GAP = 6;
export const MENU_MARGIN = 8;

export function placeMenu(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  align: "left" | "right" = "right",
): Placement {
  const below = viewport.height - anchor.bottom - MENU_GAP - MENU_MARGIN;
  const above = anchor.top - MENU_GAP - MENU_MARGIN;
  // Flip only when down does not fit AND up is roomier: a flip that gains a
  // few pixels moves the list somewhere the eye is not.
  const side = size.height > below && above > below ? "above" : "below";
  const room = Math.max(0, side === "below" ? below : above);
  const height = Math.min(size.height, room);
  const top = side === "below" ? anchor.bottom + MENU_GAP : anchor.top - MENU_GAP - height;
  // Edge to edge with the trigger on the side it names, then shifted back
  // inside the window if that pushes it out.
  const wanted = align === "right" ? anchor.right - size.width : anchor.left;
  const left = Math.max(MENU_MARGIN, Math.min(wanted, viewport.width - size.width - MENU_MARGIN));
  return { left, top, maxHeight: room, side };
}
