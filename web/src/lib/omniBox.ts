/*
 * Where the address box sits over the page, as numbers: centred on the page
 * part of the browser pane (the pane minus the side column when it is open),
 * no wider than OMNI_MAX, and never closer than OMNI_GUTTER to either edge.
 * The suggestions live inside the same box, so they share its width.
 * Pure, so the three pane widths that matter can be tested without a renderer.
 */

/** The widest the box gets — the house's 620 (the dialogs and the old edit box use it). */
export const OMNI_MAX = 620;
/** The gap kept to each side of the page at narrow widths. */
export const OMNI_GUTTER = 16;

export function omniBox(paneW: number, sideW: number): { left: number; width: number } {
  const pageW = Math.max(0, paneW - Math.max(0, sideW));
  const width = Math.max(0, Math.min(OMNI_MAX, pageW - 2 * OMNI_GUTTER));
  return { left: Math.round((pageW - width) / 2), width };
}
