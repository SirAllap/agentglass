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

/** Hand whatever width is left to the last column. */
export function fillLast(widths: readonly number[], available: number): number[] {
  if (!widths.length) return [];
  const used = widths.reduce((a, b) => a + b, 0);
  const out = [...widths];
  if (available > used) out[out.length - 1] = out[out.length - 1]! + (available - used);
  return out;
}

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
