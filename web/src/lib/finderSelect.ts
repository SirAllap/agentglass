/*
 * Choosing several rows of one column: Ctrl and Shift click, Shift+arrows,
 * Ctrl+Space and Ctrl+A, as Strata does. Pure, so the rules are tested here
 * and the finder only holds the result.
 *
 * A choice is by NAME — rows arrive in pages and are re-sorted, so an index
 * would point at another file a moment later. `cursor` is the row the preview
 * follows, `anchor` is where a Shift range starts.
 *
 * What it does not do: select across columns. One column has the keyboard and
 * one choice; picking in another column starts that column's own.
 */
import { formatSize, isFolder, type Row } from "./finderMiller.ts";

export interface Choice { names: Set<string>; anchor: string | null; cursor: string | null }

export const single = (name: string | null): Choice => ({ names: new Set(name === null ? [] : [name]), anchor: name, cursor: name });

const at = (rows: readonly Row[], name: string | null) => (name === null ? -1 : rows.findIndex((r) => r.name === name));
const span = (rows: readonly Row[], a: number, b: number): string[] => rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.name);
/** What was chosen that is still in the folder. */
const live = (rows: readonly Row[], c: Choice): Set<string> => { const here = new Set(rows.map((r) => r.name)); return new Set([...c.names].filter((n) => here.has(n))); };

export function clickSelect(rows: readonly Row[], from: Choice, name: string, mod: { ctrl: boolean; shift: boolean }): Choice {
  const to = at(rows, name);
  if (to < 0) return from;
  const base = live(rows, from);
  const a = at(rows, from.anchor);
  if (mod.shift && a >= 0) {
    const names = mod.ctrl ? new Set([...base, ...span(rows, a, to)]) : new Set(span(rows, a, to));
    return { names, anchor: from.anchor, cursor: name };
  }
  if (mod.ctrl) {
    const names = new Set(base);
    if (names.has(name)) names.delete(name); else names.add(name);
    return { names, anchor: name, cursor: name };
  }
  return single(name);
}

/** Shift+arrow or Shift+page: the cursor moves `by` rows and the range from the anchor follows it. */
export function extendSelect(rows: readonly Row[], from: Choice, by: number): Choice {
  if (!rows.length) return from;
  const c = Math.max(0, at(rows, from.cursor));
  const anchor = from.anchor !== null && at(rows, from.anchor) >= 0 ? from.anchor : rows[c]!.name;
  const to = Math.min(rows.length - 1, Math.max(0, c + by));
  return { names: new Set(span(rows, at(rows, anchor), to)), anchor, cursor: rows[to]!.name };
}

/** Ctrl+Space: the cursor row in or out of the set. */
export function toggleCursor(rows: readonly Row[], from: Choice): Choice {
  return from.cursor === null ? from : clickSelect(rows, from, from.cursor, { ctrl: true, shift: false });
}

/** Ctrl+A: every row shown. */
export function selectAll(rows: readonly Row[], from: Choice): Choice {
  if (!rows.length) return single(null);
  const cursor = from.cursor !== null && at(rows, from.cursor) >= 0 ? from.cursor : rows[0]!.name;
  return { names: new Set(rows.map((r) => r.name)), anchor: rows[0]!.name, cursor };
}

const DETAIL_MAX = 64;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The footer's words for more than one row chosen: "2 folders, 5 files selected (12 kB)". Strata stops itemising past 64. */
export function selectedFooter(rows: readonly Row[], c: Choice): string {
  const chosen = rows.filter((r) => c.names.has(r.name));
  const n = chosen.length;
  if (n > DETAIL_MAX) return `${n} items selected`;
  const dirs = chosen.filter((r) => isFolder(r)).length;
  const files = chosen.filter((r) => !isFolder(r));
  const parts = [dirs ? plural(dirs, "folder") : "", files.length ? plural(files.length, "file") : ""].filter(Boolean).join(", ");
  if (!files.length) return `${parts} selected`;
  const known = files.filter((r) => r.bytes !== null);
  const total = known.reduce((s, r) => s + (r.bytes ?? 0), 0);
  const size = known.length === 0 ? " (size unavailable)" : known.length < files.length ? ` (${formatSize(total)} known; size incomplete)` : ` (${formatSize(total)})`;
  return `${parts} selected${size}`;
}

/** How many rows Shift+arrow or Shift+page moves the cursor: a row (or a line of tiles), or a page; down is positive. */
export function extendBy(by: "up" | "down" | "pageUp" | "pageDown", page: number, perRow: number): number {
  const n = by === "pageUp" || by === "pageDown" ? Math.max(1, page) : Math.max(1, perRow);
  return by === "up" || by === "pageUp" ? -n : n;
}
