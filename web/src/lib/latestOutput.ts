/*
 * The "Latest output" pill: when it shows, and where it sits.
 *
 * The distance is counted the way a person sees it, in pixels of scrollback
 * below the viewport. xterm reports rows (`baseY` is the last row of output,
 * `viewportY` the first row on screen), so rows times the cell height. It is
 * read off xterm's own onScroll, so a shell that is not scrolled costs nothing.
 *
 * Under tmux the pane is the alt screen and its scrollback is tmux's own, so
 * `baseY` is 0 and the pill never shows there; that is a limit of this, not a
 * decision.
 */
export const LATEST_SHOW_PX = 80;
/** Resting height above the pane's bottom edge, and the height when the blocked note is up. */
export const PILL_BOTTOM = 14;
export const PILL_BOTTOM_NOTE = 64;

export function pxBehind(baseY: number, viewportY: number, cellH: number): number {
  return Math.max(0, baseY - viewportY) * Math.max(0, cellH);
}

export const showLatest = (px: number): boolean => px >= LATEST_SHOW_PX;

export const pillBottom = (noteUp: boolean): number => (noteUp ? PILL_BOTTOM_NOTE : PILL_BOTTOM);

/** Smooth unless the person asked for less motion. */
export const scrollBehavior = (reduced: boolean): "auto" | "smooth" => (reduced ? "auto" : "smooth");
