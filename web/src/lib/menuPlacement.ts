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

/**
 * The height a list takes when no earlier placement's ceiling is on it: the
 * content's own height plus the border (the menu hides its scrollbar).
 */
export function naturalHeight(el: Pick<HTMLElement, "scrollHeight" | "offsetHeight" | "clientHeight">): number {
  return el.scrollHeight + (el.offsetHeight - el.clientHeight);
}

/**
 * A menu's box kept inside the window, for the second time.
 *
 * `placeMenu` answers where a list goes when it opens. A window that changes
 * size afterwards (a resize, and zoom is the same event) leaves that answer
 * stale: measured, a menu opened at 1440x900 and then shrunk to 640x360 had
 * its last 79px below the window, and at 427x240 190px. Clamping again with
 * the menu's own measured size is the whole fix, and it is the same arithmetic
 * at both moments so the two cannot disagree.
 */
export function clampToWindow(
  at: { left: number; top: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = MENU_MARGIN,
): { left: number; top: number } {
  return {
    left: Math.max(margin, Math.min(at.left, viewport.width - size.width - margin)),
    // A menu taller than the window cannot be clamped into it; 8 and not a
    // negative top, so its first row stays under the edge rather than above it.
    top: Math.max(margin, Math.min(at.top, viewport.height - size.height - margin)),
  };
}
