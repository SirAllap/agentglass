/*
 * Where the Notify popover goes: the room under its button, minus a 12px margin
 * to the window edge, or the room above when that is bigger. Only the body of
 * the popover scrolls, so the ceiling is all this decides.
 */
export const POP_GAP = 6;
export const POP_MARGIN = 12;
/** Below this the cards drop their explanation line and keep the live one. */
export const TIGHT_BELOW = 520;
/** A popover shorter than this cannot show a card and a square; past it the window is simply too small. */
export const POP_MIN = 180;

/** A box the popover must not sit on: the floating bench button, `data-floating-furniture`. */
type Box = { left: number; top: number; right: number; bottom: number };

/* `furniture` that overlaps the popover's columns and lies on its side of the button caps the room there: the bench
   button floats over the corner the popover opens into, and covered its footer. Ceiling: only boxes wholly below
   (or above) the button count, one that sits beside it is not in the way. */
export function placePop(btn: { top: number; bottom: number; right?: number }, viewportH: number, furniture: Box[] = [], width = 420): { up: boolean; maxHeight: number; tight: boolean } {
  const right = btn.right ?? 0, left = right - width;
  const hit = furniture.filter((f) => f.right > left && f.left < right);
  const floor = Math.min(viewportH, ...hit.filter((f) => f.top >= btn.bottom).map((f) => f.top));
  const ceil = Math.max(0, ...hit.filter((f) => f.bottom <= btn.top).map((f) => f.bottom));
  const below = floor - btn.bottom - POP_GAP - POP_MARGIN;
  const above = btn.top - ceil - POP_GAP - POP_MARGIN;
  const up = above > below;
  const maxHeight = Math.max(POP_MIN, Math.floor(up ? above : below));
  return { up, maxHeight, tight: maxHeight < TIGHT_BELOW };
}
