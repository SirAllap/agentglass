/*
 * The width of a Miller column, decided where it can be tested.
 *
 * Fixed at 232 px every column read "agentglass-fea…" for ten different names
 * while half the window was empty. A column is as wide as its longest name needs
 * (icon, size and padding included), between a floor and a ceiling; a column
 * somebody dragged keeps the width they gave it; and the free width goes to the
 * last column, so a name is cut only when there is genuinely no room.
 */

export const COL_MIN = 260;
export const COL_MAX = 420;
/** What a row spends beside the name: icon, gaps, the size or count, the padding. */
export const COL_CHROME = 92;
/** A dragged column may go narrower and wider than the automatic range. */
const DRAG_MIN = 120;
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

export function columnWidth(names: readonly string[], measure: (text: string) => number, dragged?: number): number {
  if (dragged !== undefined) return clamp(dragged, DRAG_MIN, DRAG_MAX);
  let w = 0;
  for (const n of longestNames(names)) w = Math.max(w, measure(n));
  return clamp(Math.ceil(w) + COL_CHROME, COL_MIN, COL_MAX);
}

export const dragWidth = (start: number, dx: number): number => clamp(start + dx, DRAG_MIN, DRAG_MAX);

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
 * A name cut in the middle, as Strata cuts it: the head gives way and the end
 * stays, because `agentglass-finder-v2.json` and `agentglass-finder-v3.json` differ
 * at the end and an ellipsis there would make them the same row. The split is
 * after the last dot when the extension is short, else eight characters from the end.
 */
export function splitName(name: string, keep = 8): [head: string, tail: string] {
  if (name.length <= keep * 2) return [name, ""];
  const dot = name.lastIndexOf(".");
  const cut = dot > 0 && name.length - dot <= keep ? Math.max(dot - 3, 1) : name.length - keep;
  return [name.slice(0, cut), name.slice(cut)];
}

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

/** The column header's actions, in the order they give up their place: the last of these goes into the menu first. */
export type HeaderAction = "options" | "filter" | "close" | "refresh" | "direction" | "sort";
export const HEADER_ORDER: readonly HeaderAction[] = ["options", "filter", "close", "refresh", "direction", "sort"];

/**
 * Which header actions stay as buttons in a column `width` px wide. The title
 * keeps 56 px, the count badge 34, and each button takes `hit` plus a 4 px gap;
 * whatever does not fit is reached from the options menu instead, as in
 * Strata, and the header never draws one control over another. The options
 * button itself always stays: it is where the rest went.
 */
export function headerInline(width: number, hit: number, closable: boolean, hasCount = true): Set<HeaderAction> {
  const room = width - 20 - 56 - (hasCount ? 38 : 0);
  let slots = Math.max(1, Math.floor(room / (hit + 4)));
  const out = new Set<HeaderAction>();
  for (const a of HEADER_ORDER) {
    if (a === "close" && !closable) continue;
    if (slots <= 0) break;
    out.add(a); slots--;
  }
  return out;
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
