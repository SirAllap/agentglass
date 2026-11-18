/**
 * Where the loose bench button goes when a bar that must stay readable (the pull
 * request dock) is under it. The button is dragged anywhere and its saved place
 * is never rewritten; this only lifts how it is DRAWN, so it rests on top of the
 * bar instead of on the bar's buttons. Pure: the DOM is read elsewhere.
 */
export type FabBox = { left: number; right: number; top: number; bottom: number };

/**
 * Pixels to raise a button drawn at `fab` so it clears every `avoid` box it
 * touches (a box it only borders does not count). 0 when nothing is under it.
 * Several bars stacked under it: the highest one wins.
 */
export function fabLift(fab: FabBox, avoid: readonly FabBox[], gap = 8): number {
  let lift = 0;
  for (const a of avoid) {
    const over = fab.right > a.left && fab.left < a.right && fab.bottom > a.top && fab.top < a.bottom;
    if (over) lift = Math.max(lift, fab.bottom - a.top + gap);
  }
  return lift;
}
