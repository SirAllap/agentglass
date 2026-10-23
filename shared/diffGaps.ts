// The lines a diff leaves out, and how to put them back.
//
// A pull request's diff carries each change with three lines of context and
// nothing else, so the rest of the file is "hidden": above the first hunk,
// between two hunks, and below the last. Showing it is a matter of taking the
// head-side file (the unchanged lines are the same on both sides, so one file
// is enough) and splicing the revealed lines into the neighbouring hunks as
// context. Both diff views already know how to paint, number and colour a
// hunk, so they get the expanded lines for free; only the expander row between
// hunks is new.
//
// Pure, no DOM: the gap and line-number arithmetic is what a screenshot cannot
// check.
import type { DiffHunk } from "./types.ts";

/** Lines revealed per click, as on github.com. */
export const EXPAND_STEP = 20;
/** Context lines git puts around a change. A hunk that ends with fewer than
 *  this has reached the end of the file. */
export const CONTEXT = 3;

/** How much of one gap is showing: `top` lines hang off the hunk above it,
 *  `bottom` lines hang off the hunk below it. */
export type Reveal = { top: number; bottom: number };
export type Reveals = Record<number, Reveal>;

/** A gap that still hides something, and so still needs an expander row. */
export type OpenGap = {
  /** Which gap: 0 is above the first hunk, n is below the last. Stable while
   *  hunks merge, so it keys the reveal state. */
  key: number;
  /** Where the row goes in the returned hunks: before `hunks[at]`, or after
   *  the last one when `at === hunks.length`. */
  at: number;
  /** Lines still hidden; null below the last hunk before the file is known. */
  hidden: number | null;
  up: boolean;
  down: boolean;
};

/** A file's text as a viewer numbers it: no phantom line after the final
 *  newline (`"a\nb\n"` is two lines, not three). */
export function splitFileLines(text: string): string[] {
  if (text === "") return [];
  const all = text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  return all;
}

// A range of `0` lines is written with the start BEFORE it ("-5,0" sits after
// line 5), so the first line it covers is start + 1.
const first = (start: number, lines: number) => (lines === 0 ? start + 1 : start);

function trailingContext(h: DiffHunk): number {
  let n = 0;
  for (let i = h.lines.length - 1; i >= 0; i--) {
    const l = h.lines[i]!;
    if (l.startsWith("\\")) continue; // "\ No newline at end of file" is not a line
    if (l[0] !== " ") break;
    n++;
  }
  return n;
}

const grow = (h: DiffHunk, ls: string[], atEnd: boolean): DiffHunk => {
  const ctx = ls.map((l) => " " + l);
  return {
    oldStart: atEnd ? h.oldStart : h.oldStart - ls.length,
    newStart: atEnd ? h.newStart : h.newStart - ls.length,
    oldLines: h.oldLines + ls.length,
    newLines: h.newLines + ls.length,
    lines: atEnd ? [...h.lines, ...ctx] : [...ctx, ...h.lines],
  };
};

/**
 * `hunks` with the revealed lines spliced in as context, plus the gaps that
 * still hide something.
 *
 * `file` is the head side of the file split into lines, or null before it is
 * loaded (then nothing is revealed, and the gap below the last hunk is of
 * unknown size). A gap revealed to the last line merges the two hunks around
 * it into one, as github.com does.
 *
 * Ceiling: a hunk whose old or new side is empty (a file created or deleted
 * outright) is not expandable and the caller does not offer it; and `file` is
 * trusted to be the file the diff was made from. A file shorter than the last
 * hunk's end is a stale pair and is left alone rather than spliced wrongly.
 */
export function expandHunks(
  hunks: DiffHunk[], file: string[] | null, reveals: Reveals = {},
): { hunks: DiffHunk[]; open: OpenGap[] } {
  const n = hunks.length;
  if (!n) return { hunks, open: [] };
  const last = hunks[n - 1]!;
  const lastEnd = first(last.newStart, last.newLines) + last.newLines;
  const usable = file && file.length >= lastEnd - 1 ? file : null;
  if (file && !usable) return { hunks, open: [] };

  const res: DiffHunk[] = [];
  const open: OpenGap[] = [];
  let cur: DiffHunk | null = null;
  for (let i = 0; i <= n; i++) {
    const next: DiffHunk | null = i < n ? hunks[i]! : null;
    const prev = i > 0 ? hunks[i - 1]! : null;
    const newFrom = prev ? first(prev.newStart, prev.newLines) + prev.newLines : 1;
    // Below the last hunk: its size is the rest of the file, and a hunk that
    // ends short of a full context has no rest at all.
    const count: number | null = next
      ? first(next.newStart, next.newLines) - newFrom
      : trailingContext(last) < CONTEXT ? 0 : usable ? usable.length - newFrom + 1 : null;
    const c = count == null ? null : Math.max(0, count);
    const r = reveals[i] ?? { top: 0, bottom: 0 };
    let t = !cur || !usable ? 0 : Math.min(r.top, c ?? 0);
    let b = !next || !usable ? 0 : Math.min(r.bottom, (c ?? 0) - t);
    const whole = cur && next && c != null && c > 0 && t + b >= c;
    if (whole) { t = c; b = 0; }
    const lines = (from: number, len: number) => (usable ? usable.slice(from - 1, from - 1 + len) : []);
    let head: DiffHunk | null = cur;
    if (head && t) head = grow(head, lines(newFrom, t), true);
    let tail: DiffHunk | null = next;
    if (tail && b) tail = grow(tail, lines(newFrom + (c ?? 0) - b, b), false);

    if (whole && head && tail) {
      // Nothing left hidden between them: one hunk, as github.com draws it.
      cur = { ...head, oldLines: head.oldLines + tail.oldLines, newLines: head.newLines + tail.newLines, lines: [...head.lines, ...tail.lines] };
      continue;
    }
    const hidden = c == null ? null : c - t - b;
    if (head) res.push(head);
    if (hidden == null || hidden > 0) open.push({ key: i, at: res.length, hidden, up: !!next, down: !!prev });
    cur = tail;
  }
  return { hunks: res, open };
}

/** The reveal state after one click: `down` shows more of the gap below the
 *  hunk above it, `up` more of the gap above the hunk below it. */
export function reveal(rs: Reveals, key: number, dir: "up" | "down" | "all", step = EXPAND_STEP): Reveals {
  const r = rs[key] ?? { top: 0, bottom: 0 };
  return {
    ...rs,
    // Both ends: which one applies depends on whether a hunk sits above/below.
    [key]: dir === "all" ? { top: Number.MAX_SAFE_INTEGER, bottom: Number.MAX_SAFE_INTEGER }
      : dir === "down" ? { ...r, top: r.top + step } : { ...r, bottom: r.bottom + step },
  };
}

/** Is this line part of the diff as GitHub sent it? A line an expander revealed
 *  is not, and a review comment on it is refused. `side` is the gutter: the new
 *  numbers are the head's, the old ones the base's. */
export function inDiff(hunks: DiffHunk[], line: number, side: "LEFT" | "RIGHT"): boolean {
  return hunks.some((h) => {
    const [s, n] = side === "LEFT" ? [h.oldStart, h.oldLines] : [h.newStart, h.newLines];
    return line >= first(s, n) && line < first(s, n) + n;
  });
}
