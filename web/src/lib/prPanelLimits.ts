/**
 * The pull request panel's limits, named once. The panel is laid out with CSS
 * container queries on its own box (the same CSS is the side panel and the full
 * page), and a container query cannot read `var()`, so the numbers are repeated
 * as literals in index.css (`.prx`). test/pr-panel-limits.test.ts reads that CSS
 * and fails when a literal drifts from the constant here.
 */

/** The narrowest panel. One pixel under it the tab strip is not scrollable-with-mask, the dock's verdict plus split Merge no longer fit, and a diff gutter gets under 24 characters. */
export const PANEL_MIN = 320;
/** The panel's default width beside the board. */
export const PANEL_DEFAULT = 620;
/** The rail's width beside the main column, which takes the rest. Nothing caps the panel or its prose: it fills the window. */
export const RAIL_W = 320;
export const RAIL_W_XL = 360;

/** Container breakpoints (px of the panel, not the window). */
export const BP_TIGHT = 440; // under: tight
export const BP_SIDE = 440; // 440..719: side
export const BP_WIDE = 720; // 2x2 gates become 1x4, the actions grow a word
export const BP_PAGE = 960; // a rail beside the reading column
export const BP_XL = 1280;
/** Where the dock's Merge takes its full width and Update branch its word. */
export const BP_SUB = 560;

export type PanelBand = "tight" | "side" | "wide" | "page" | "xl";

/** Which band a panel this wide is in. */
export function panelBand(px: number): PanelBand {
  if (px >= BP_XL) return "xl";
  if (px >= BP_PAGE) return "page";
  if (px >= BP_WIDE) return "wide";
  if (px >= BP_SIDE) return "side";
  return "tight";
}

/** Scroll depth (px) past which the header folds to one row, and the depth under which it opens again. The gap is the hysteresis. */
export const COLLAPSE_AT = 56;
export const EXPAND_AT = 8;

/**
 * Whether the header is folded, from the body's scroll. Folding gives the body
 * the folded height back, so the body must still be able to scroll after it:
 * otherwise the browser clamps the scroll to 0, the header opens, and it
 * flickers. `slack` is scrollHeight - clientHeight; `chrome` is the height the
 * fold gives back.
 */
export function headerFolded(i: { y: number; folded: boolean; slack: number; chrome: number }): boolean {
  if (i.folded) return i.y > EXPAND_AT;
  return i.y > COLLAPSE_AT && i.slack > i.chrome + COLLAPSE_AT;
}

/** The rail sits beside the main column from BP_PAGE; below it flows under the story. */
export function railBeside(width: number): boolean {
  return width >= BP_PAGE;
}

export function railWidth(width: number): number {
  return width >= BP_XL ? RAIL_W_XL : RAIL_W;
}
