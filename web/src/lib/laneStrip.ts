/**
 * The narrow board's lane strip: text chips while they fit, icon + count when they do not.
 *
 * Decided here from the strip's width and the labels, not by measuring the strip's own overflow: a strip that
 * switches when it overflows overflows again as soon as it switches back. The width of a text chip is
 * estimated from its characters (uppercase 10.5px with tracking: CHAR_PX each); the estimate is checked against the
 * real strip in test/lane-strip.test.ts's measured fixture. The ceiling: a label in a font this does not
 * know (a wider interface font size) can still overflow by a few px, and the strip scrolls as it always did.
 */
export const CHIP_CHAR_PX = 7.4;
/** Padding both sides (px-2), the gap between label and count (gap-1.5), one digit. */
export const CHIP_BASE_PX = 16 + 6 + 7;
/** The gap between chips (gap-1) and the strip's own side padding (px-4). */
export const CHIP_GAP_PX = 4;
export const STRIP_PAD_PX = 32;

export type StripMode = "text" | "icon";

export function stripMode(labels: readonly string[], boardPx: number): StripMode {
  if (!(boardPx > 0)) return "text"; // not measured yet: the first paint is the wide one
  const chips = labels.reduce((n, l) => n + CHIP_BASE_PX + CHIP_CHAR_PX * l.length, 0);
  const need = chips + CHIP_GAP_PX * Math.max(0, labels.length - 1) + STRIP_PAD_PX;
  return need <= boardPx ? "text" : "icon";
}
