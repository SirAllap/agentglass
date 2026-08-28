/*
 * The lines a diff is NOT showing you, and which of them to ask for.
 *
 * A hunk header says `@@ -12,7 +12,9 @@` and the three lines of context around
 * a change are all you get. On a desk that is usually enough, because the file
 * is open in an editor two inches away. On a phone it is not: the question you
 * actually have about a changed line — what calls this, what the branch above
 * it tests — is answered by the twenty lines the hunk cut off, and today the
 * only way to see them is to leave for GitHub.
 *
 * `/prs/file-slice` already serves them, by line range, from either side of the
 * pull request. This module is the arithmetic: given the hunks that were
 * parsed, where are the gaps, and what range does each expander ask for.
 *
 * ── it is arithmetic, so it is testable, so it is here ───────────────────
 * The screen renders; this decides. Off-by-one in a diff is not a cosmetic
 * bug — it is a comment anchored to the wrong line, which is a remark about
 * code the author did not write. `diffLines.ts` makes the same argument for
 * the same reason, and this is its neighbour.
 */
import type { DiffFile, DiffHunk } from "./diffLines.ts";

/** How many lines one press asks for. Twenty is about a screen of code at the
 *  10.5pt the diff draws at, and a whole screen is the unit somebody means when
 *  they press "show more" — a smaller step turns reading into pressing. */
export const STEP = 20;

/** One place the file continues, between what two hunks show. */
export interface Gap {
  /** The hunk this expander sits ABOVE, by index. `hunks.length` means the
   *  expander below the last hunk — the tail of the file. */
  before: number;
  /** First and last line NOT shown, on the new side, inclusive. `to` is null
   *  at the tail, where how far the file goes is the server's to know. */
  from: number;
  to: number | null;
}

/** The new-side line numbers a hunk covers, or null when it carries none —
 *  a pure deletion has no new side to speak of. */
export function newSpan(hunk: DiffHunk): { first: number; last: number } | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const line of hunk.lines) {
    if (line.newNo == null) continue;
    if (first === null) first = line.newNo;
    last = line.newNo;
  }
  return first === null || last === null ? null : { first, last };
}

/**
 * Every gap in a file's diff, in file order.
 *
 * Includes the head of the file (above the first hunk) and its tail (below the
 * last), because "what is at the top of this file" is one of the two questions
 * a reviewer asks most and the diff never shows it.
 *
 * A file with no hunks gets nothing: there is no diff to expand around, and an
 * expander on an empty screen offers to show a file the pull request did not
 * change.
 */
export function gapsIn(file: Pick<DiffFile, "hunks">): Gap[] {
  const spans = file.hunks.map(newSpan);
  const out: Gap[] = [];
  let prevLast = 0;
  for (let i = 0; i < file.hunks.length; i++) {
    const span = spans[i];
    /* A hunk with no new side cannot bound a gap on the new side. Skipped
       rather than treated as zero-length: `prevLast` stays where the last real
       hunk left it, so the gap after a pure deletion is measured from the code
       that is actually still there. */
    if (!span) continue;
    if (span.first > prevLast + 1) out.push({ before: i, from: prevLast + 1, to: span.first - 1 });
    prevLast = Math.max(prevLast, span.last);
  }
  if (file.hunks.length) out.push({ before: file.hunks.length, from: prevLast + 1, to: null });
  return out;
}

/**
 * What one press on an expander should ask the server for.
 *
 * Two rules, and both of them are about not making somebody press twice for
 * nothing:
 *
 *   A gap SMALLER than a step is asked for whole. Fetching 20 of the 6 lines
 *   between two hunks and leaving a 0-line expander behind is the shape that
 *   makes a control look broken.
 *
 *   Otherwise it grows from the end nearest the code you are reading —
 *   downward from the top of a gap, upward from its bottom — because the lines
 *   just past the edge of a hunk are the ones the question is about.
 *
 * `at` is the last line already shown from this gap, if the expander has been
 * pressed before; null on the first press.
 */
export function nextSlice(gap: Gap, dir: "up" | "down", at: number | null): { from: number; to: number } | null {
  if (gap.to !== null && gap.from > gap.to) return null;
  if (dir === "down") {
    const from = at === null ? gap.from : at + 1;
    if (gap.to !== null && from > gap.to) return null;
    const want = from + STEP - 1;
    return { from, to: gap.to === null ? want : Math.min(want, gap.to) };
  }
  // Upward only has an end to count back from when the gap has one; the tail
  // of a file is unbounded and is only ever read downward.
  if (gap.to === null) return null;
  const to = at === null ? gap.to : at - 1;
  if (to < gap.from) return null;
  return { from: Math.max(gap.from, to - STEP + 1), to };
}

/**
 * How the expander reads.
 *
 * Says the size when it is known, because "37 lines" and "more lines" are
 * different offers and only one of them is a decision. The tail of a file has
 * no size until the server answers with one, so it says what it can.
 */
export function gapLabel(gap: Gap, slice: { from: number; to: number } | null): string {
  if (!slice) return "";
  const n = slice.to - slice.from + 1;
  if (gap.to === null) return "Show more of the file";
  return n === 1 ? "Show 1 more line" : `Show ${n} more lines`;
}
