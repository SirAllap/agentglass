/*
 * Where the diff stops and what one press asks for.
 *
 * The arithmetic, not the screen. A gap computed one line out shows context
 * that overlaps the hunk above it — or worse, hides the line the reader was
 * looking for and offers to fetch it again.
 */
import { describe, expect, test } from "bun:test";
import { gapsIn, gapLabel, newSpan, nextSlice, STEP, type Gap } from "../src/model/expand.ts";
import type { DiffHunk, DiffLine } from "../src/model/diffLines.ts";

/** A hunk covering new-side lines [first, last], as a diff of context rows. */
function hunk(first: number, last: number): DiffHunk {
  const lines: DiffLine[] = [];
  for (let n = first; n <= last; n++) lines.push({ kind: "ctx", text: `line ${n}`, oldNo: n, newNo: n });
  return { header: `@@ -${first},${last - first + 1} +${first},${last - first + 1} @@`, lines };
}

/** A hunk that only removes: it has old-side numbers and no new-side ones. */
function deletion(oldFrom: number, oldTo: number): DiffHunk {
  const lines: DiffLine[] = [];
  for (let n = oldFrom; n <= oldTo; n++) lines.push({ kind: "del", text: `gone ${n}`, oldNo: n, newNo: null });
  return { header: "@@ -1,2 +0,0 @@", lines };
}

describe("newSpan", () => {
  test("is the first and last new-side number in the hunk", () => {
    expect(newSpan(hunk(12, 18))).toEqual({ first: 12, last: 18 });
  });

  test("is null when the hunk has no new side", () => {
    expect(newSpan(deletion(4, 6))).toBe(null);
  });
});

describe("gapsIn", () => {
  test("a file with no hunks offers nothing to expand", () => {
    expect(gapsIn({ hunks: [] })).toEqual([]);
  });

  test("the head of the file is a gap", () => {
    const gaps = gapsIn({ hunks: [hunk(10, 14)] });
    expect(gaps[0]).toEqual({ before: 0, from: 1, to: 9 });
  });

  test("a hunk starting at line 1 has no head gap", () => {
    const gaps = gapsIn({ hunks: [hunk(1, 6)] });
    expect(gaps.map((g) => g.before)).toEqual([1]); // the tail only
  });

  test("the space between two hunks is a gap", () => {
    const gaps = gapsIn({ hunks: [hunk(1, 6), hunk(30, 36)] });
    expect(gaps).toEqual([
      { before: 1, from: 7, to: 29 },
      { before: 2, from: 37, to: null },
    ]);
  });

  test("touching hunks leave no gap between them", () => {
    const gaps = gapsIn({ hunks: [hunk(1, 6), hunk(7, 9)] });
    expect(gaps.map((g) => g.before)).toEqual([2]);
  });

  test("the tail is unbounded — only the server knows where the file ends", () => {
    const gaps = gapsIn({ hunks: [hunk(1, 6)] });
    expect(gaps.at(-1)).toEqual({ before: 1, from: 7, to: null });
  });

  test("a pure deletion does not move the boundary it cannot see", () => {
    // The deletion has no new side. Measuring the next gap from it would start
    // the gap at line 1 and offer to show code that is already on screen.
    const gaps = gapsIn({ hunks: [hunk(1, 6), deletion(20, 22), hunk(40, 44)] });
    expect(gaps[0]).toEqual({ before: 2, from: 7, to: 39 });
  });
});

describe("nextSlice", () => {
  const between: Gap = { before: 1, from: 7, to: 29 };
  const head: Gap = { before: 0, from: 1, to: 9 };
  const tail: Gap = { before: 2, from: 37, to: null };

  test("downward starts at the top of the gap", () => {
    expect(nextSlice(between, "down", null)).toEqual({ from: 7, to: 7 + STEP - 1 });
  });

  test("downward continues from where it left off", () => {
    expect(nextSlice(between, "down", 26)).toEqual({ from: 27, to: 29 });
  });

  test("downward stops at the end of a bounded gap", () => {
    expect(nextSlice(between, "down", 29)).toBe(null);
  });

  test("a gap smaller than a step is asked for whole", () => {
    // Six lines, one press. Fetching twenty and leaving an expander showing
    // nothing is what makes a control look broken.
    expect(nextSlice({ before: 1, from: 7, to: 12 }, "down", null)).toEqual({ from: 7, to: 12 });
  });

  test("upward counts back from the bottom of the gap", () => {
    expect(nextSlice(head, "up", null)).toEqual({ from: 1, to: 9 });
    expect(nextSlice({ before: 1, from: 1, to: 100 }, "up", null)).toEqual({ from: 100 - STEP + 1, to: 100 });
  });

  test("upward continues above what it already showed", () => {
    expect(nextSlice({ before: 1, from: 1, to: 100 }, "up", 81)).toEqual({ from: 80 - STEP + 1, to: 80 });
  });

  test("upward never runs off the top of the gap", () => {
    expect(nextSlice(head, "up", 1)).toBe(null);
  });

  test("the tail of a file is only ever read downward", () => {
    // There is no bottom to count back from: how far the file goes is the
    // server's to know, and guessing it would ask for lines past the end.
    expect(nextSlice(tail, "up", null)).toBe(null);
    expect(nextSlice(tail, "down", null)).toEqual({ from: 37, to: 37 + STEP - 1 });
  });

  test("an empty gap offers nothing", () => {
    expect(nextSlice({ before: 1, from: 10, to: 9 }, "down", null)).toBe(null);
  });
});

describe("gapLabel", () => {
  test("says how many when the count is known", () => {
    const gap: Gap = { before: 1, from: 7, to: 12 };
    expect(gapLabel(gap, nextSlice(gap, "down", null))).toBe("Show 6 more lines");
  });

  test("counts one line in the singular", () => {
    const gap: Gap = { before: 1, from: 7, to: 7 };
    expect(gapLabel(gap, nextSlice(gap, "down", null))).toBe("Show 1 more line");
  });

  test("the tail says what it can, because its size is not known yet", () => {
    const gap: Gap = { before: 2, from: 37, to: null };
    expect(gapLabel(gap, nextSlice(gap, "down", null))).toBe("Show more of the file");
  });

  test("nothing left to show is no label at all", () => {
    const gap: Gap = { before: 1, from: 7, to: 12 };
    expect(gapLabel(gap, nextSlice(gap, "down", 12))).toBe("");
  });
});
