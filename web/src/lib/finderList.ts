/*
 * The columns of the List view, as Strata sets them (ui/browser_modes.rs LIST_COLUMN_WIDTHS and LIST_COLUMN_MIN_WIDTHS):
 * Name, Size, Type, Modified at 160 / 90 / 120 / 150 px and never under 160 / 70 / 80 / 110. Name takes what the others
 * leave until somebody drags its edge. Strata's Mode column (permissions) is not here: the listing the server sends has
 * no mode, and that is server work.
 */
export const LIST_COLS = ["name", "size", "type", "modified"] as const;
export type ListCol = (typeof LIST_COLS)[number];
export const LIST_MIN: readonly number[] = [160, 70, 80, 110];
export const LIST_DEFAULT: readonly number[] = [0, 90, 120, 150];
const LIST_MAX = 800;

/** Stored widths: 0 for Name means "take the rest". A value that is missing or not a number is its default; one under its minimum is its minimum. */
export function readListW(v: unknown): number[] {
  const a = Array.isArray(v) ? v : [];
  return LIST_DEFAULT.map((d, i) => {
    const n = a[i];
    if (typeof n !== "number" || !Number.isFinite(n)) return d;
    if (i === 0 && n === 0) return 0;
    return Math.min(LIST_MAX, Math.max(LIST_MIN[i]!, Math.round(n)));
  });
}

/** The grid both the headings and every row use, so a column is one width all the way down. */
export const listTemplate = (w: readonly number[]): string =>
  [w[0] ? `${w[0]}px` : `minmax(${LIST_MIN[0]}px, 1fr)`, ...w.slice(1).map((n) => `${n}px`)].join(" ");

/** One column resized: dragged from `from` by `dx`, kept inside its bounds. */
export function resizeList(w: readonly number[], col: number, from: number, dx: number): number[] {
  const out = [...w];
  out[col] = Math.min(LIST_MAX, Math.max(LIST_MIN[col]!, Math.round(from + dx)));
  return out;
}

/** A double-click on the edge: the widest content of the column, plus the cell's padding, inside the bounds. */
export function fitList(w: readonly number[], col: number, widest: number): number[] {
  return resizeList(w, col, Math.ceil(widest) + 24, 0);
}

/** The table is never narrower than its columns (Name at its own width or its minimum, the rest at theirs, the 8 px of row margin): under that it scrolls sideways. */
export const listMinWidth = (w: readonly number[]): number => (w[0] || LIST_MIN[0]!) + w.slice(1).reduce((a, b) => a + b, 0) + 8;
