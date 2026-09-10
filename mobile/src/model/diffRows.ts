/*
 * A file's diff, flattened into the rows a list draws.
 *
 * ── why a list and not a column ──────────────────────────────────────────
 * The screen used to put every hunk of the open file inside one ScrollView,
 * which means React Native lays out and keeps mounted every row of it before
 * the first one is on screen. A four-hundred-line file is four hundred rows of
 * three text nodes each, measured up front, and the cost is paid again on
 * every repaint — a tap on a line, a thread opening, a comment being typed.
 *
 * A windowed list mounts what is near the viewport and drops the rest, which
 * it can only do if the content is a flat array of rows with stable keys. That
 * is the whole of what this file makes: the shape the renderer already draws,
 * as data instead of as nesting.
 *
 * ── it is deliberately dumb ──────────────────────────────────────────────
 * No decisions live here beyond the order of things. Which lines can carry a
 * comment is `commentableLine`, where the gaps are is `gapsIn`, what changed
 * inside a line is `tokens.ts`. This only says: the gap before hunk 0, then
 * hunk 0's header, then its lines, then the gap before hunk 1 — and the tail
 * gap after the last one, which belongs to no hunk and is numbered
 * `hunks.length` for exactly that reason.
 */
import type { DiffFile, DiffLine } from "./diffLines.ts";
import { gapsIn } from "./expand.ts";

export type DiffRow =
  /** The expander for the gap before hunk `before`, and whatever has been
   *  fetched into it. `before === hunks.length` is the tail of the file. */
  | { t: "gap"; key: string; before: number }
  | { t: "hunk"; key: string; at: number; header: string }
  | { t: "line"; key: string; h: number; i: number; line: DiffLine };

/**
 * The rows, in the order they are read.
 *
 * Keys are the position in the file rather than the content: two identical
 * lines are two rows, and a key made of text would make them one — which a
 * virtualised list expresses by drawing the same row twice and losing a
 * comment box that was open on one of them.
 *
 * A gap row is emitted only where there IS a gap, so the list has no rows that
 * draw nothing. A binary file has no hunks and gets no rows at all; the screen
 * says why in its place.
 */
export function rowsOf(file: Pick<DiffFile, "hunks" | "binary"> | undefined): DiffRow[] {
  if (!file || file.binary) return [];
  const gaps = new Set(gapsIn(file).map((g) => g.before));
  const rows: DiffRow[] = [];
  file.hunks.forEach((hunk, h) => {
    if (gaps.has(h)) rows.push({ t: "gap", key: `gap:${h}`, before: h });
    rows.push({ t: "hunk", key: `hunk:${h}`, at: h, header: hunk.header });
    hunk.lines.forEach((line, i) => {
      rows.push({ t: "line", key: `line:${h}:${i}`, h, i, line });
    });
  });
  if (gaps.has(file.hunks.length)) {
    rows.push({ t: "gap", key: `gap:${file.hunks.length}`, before: file.hunks.length });
  }
  return rows;
}

/**
 * How many rows to draw before the list is handed the rest.
 *
 * A phone is 393 by about 750 points of content, and a diff row is 22 — so a
 * screenful is 34. Rendering a screenful and a half up front means the first
 * paint is a full screen with something already below the fold to scroll into,
 * and everything past it arrives while the thumb is moving.
 */
export const FIRST_ROWS = 50;
