/*
 * The width of a Miller column, as Strata decides it (src/ui/browser/columns.rs).
 *
 * Every column is 300 px (COLUMN_WIDTH) and never narrower: a drag or an autofit
 * is bounded below by those 300 px, and above by the room the strip has (its
 * visible width). More columns than fit scroll sideways instead of squeezing,
 * which is what an earlier "fit everything" rule did, cutting names to four
 * letters. Autofit, a double-click on the edge, is the one place a name's
 * length counts: the longest name plus what a row spends beside it, bounded the
 * same way.
 */

export const COL_DEFAULT = 300;
/** What a row spends beside the name: icon, gaps, the size or count, the padding. */
export const COL_CHROME = 92;
/** Without a known page, a column may not be wider than this. */
const DRAG_MAX = 800;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The k longest names, longest first: the only ones worth measuring. */
export function longestNames(names: readonly string[], k = 16): string[] {
  const top: string[] = [];
  let floor = 0;
  for (const n of names) {
    if (top.length === k && n.length <= floor) continue;
    let i = top.length;
    while (i > 0 && top[i - 1]!.length < n.length) i--;
    top.splice(i, 0, n);
    if (top.length > k) top.pop();
    floor = top.length === k ? top[k - 1]!.length : 0;
  }
  return top;
}

/** One column's pixels: 300, or what was dragged, never under 300 and never over the strip's visible width. */
export function columnWidth(dragged?: number, page = DRAG_MAX): number {
  return clamp(dragged ?? COL_DEFAULT, COL_DEFAULT, Math.max(COL_DEFAULT, Math.min(DRAG_MAX, page)));
}

/** Autofit: the longest name's width plus the row's chrome, bounded like a drag. */
export function fitWidth(names: readonly string[], measure: (text: string) => number, page = DRAG_MAX): number {
  let w = 0;
  for (const n of longestNames(names)) w = Math.max(w, measure(n));
  return columnWidth(Math.ceil(w) + COL_CHROME, page);
}

export const dragWidth = (start: number, dx: number): number => clamp(start + dx, COL_DEFAULT, DRAG_MAX);

/**
 * Where the strip of columns scrolls so the active one is whole in view and the
 * leftmost visible column is not cut. Strata reveals the active column with the
 * smallest move (ui/browser/columns/reveal.rs), which leaves whatever is at the
 * left edge sliced mid-row; here the window starts on a column's own left edge.
 * A column wider than the window is shown from its left edge.
 */
export function revealScroll(o: { widths: readonly number[]; active: number; page: number; current: number }): number {
  const { widths, active, page, current } = o;
  if (!widths.length || page <= 0) return 0;
  const a = Math.min(Math.max(0, active), widths.length - 1);
  const lefts: number[] = [];
  let at = 0;
  for (const w of widths) { lefts.push(at); at += w; }
  const left = lefts[a]!;
  void at;
  const right = left + widths[a]!;
  if (widths[a]! >= page) return left;
  const need = right - page;
  // Already a window that starts on a column edge and holds the active column: stay.
  if (current >= need - 0.5 && current <= left + 0.5 && lefts.some((l) => Math.abs(l - current) < 0.5)) return current;
  const edge = lefts.find((l) => l >= need - 0.5 && l <= left) ?? left;
  // Past the strip's own end when the last columns are short: the caller pads the strip so that edge can be reached.
  return Math.max(0, edge);
}

/** The room to add after the last column so a scroll to `target` can be reached: the window must still be filled. */
export const stripPad = (widths: readonly number[], target: number, page: number): number => target <= 0 ? 0 : Math.max(0, Math.ceil(target + page - widths.reduce((a, b) => a + b, 0)));

/**
 * The preview panel's width: a third of the finder, 300 to 460 px, unless it was
 * dragged, then wherever it was dragged to, from 240 px up to leaving the columns
 * 320 px of their own. Strata's panel has a grip the same way.
 */
export function previewWidth(boxW: number, dragged?: number): number {
  if (dragged === undefined) return Math.max(300, Math.min(460, Math.round(boxW * 0.36)));
  return clamp(dragged, 240, Math.max(240, boxW - 320));
}

/** Strata: the sidebar starts 201 px wide and never goes under 169. */
export const SIDE_DEFAULT = 201;
export const SIDE_MIN = 169;
export const SIDE_MAX = 360;
const RAIL_W = 34;

/** The sidebar's pixels: the rail is fixed, the full list is what was dragged, kept off the columns' last 320 px. */
export function sidebarWidth(mode: "full" | "rail", dragged: number, boxW: number): number {
  if (mode === "rail") return RAIL_W;
  return clamp(dragged, SIDE_MIN, Math.max(SIDE_MIN, Math.min(SIDE_MAX, boxW - 320)));
}

/** Strata's floor for the preview itself (MIN_SPLIT_PREVIEW_WIDTH). */
export const PREVIEW_MIN_W = 240;
const COLUMN_MIN_W = 300;
const GRIP_W = 6;

/**
 * Whether the preview can sit beside the browser. `room` is what the sidebar left over.
 * Columns want one standard column beside it, Icons and List 240.
 */
export function previewFits(room: number, view: "columns" | "icons" | "list"): boolean {
  return room - GRIP_W - (view === "columns" ? COLUMN_MIN_W : 240) >= PREVIEW_MIN_W;
}

/**
 * The strip's layout, as numbers and nothing else: how much room to leave after
 * the last column and where to scroll. It reads the scroll position the browser
 * clamped (`current`) and never its own previous answer, so asking again with
 * what the browser did gives the same pad: that is what ends the loop a pad
 * kept in React state fell into (pad grows, the browser clamps the scroll,
 * the target moves, the pad changes, and again until React gives up at 185).
 */
export function stripLayout(widths: readonly number[], active: number, page: number, current: number): { pad: number; scroll: number } {
  const scroll = revealScroll({ widths, active, page, current });
  return { pad: stripPad(widths, scroll, page), scroll };
}

/** A column narrower than this drops the size and the item count from its rows: the name is what is left. */
export const TIGHT_W = 170;
