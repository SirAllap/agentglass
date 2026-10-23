// The arithmetic behind "expand the hidden lines": which lines a gap hides,
// where the revealed ones are spliced in, and what the gutters then say.
//
// The file is built so that line N reads "line N": a number in the gutter that
// disagrees with the text beside it is visible in one assertion.
import { test, expect } from "bun:test";
import type { DiffHunk } from "../../shared/types.ts";
import { expandHunks, reveal, splitFileLines, EXPAND_STEP } from "../../shared/diffGaps.ts";
import { unifiedRows } from "../src/components/diff/DiffLines.tsx";

const file = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const ctx = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => ` line ${a + i}`);

// One line replaced at line `at` (three lines of context each side), the shape
// GitHub sends: -at,7 +at,7 starting three lines early.
const change = (at: number, shift = 0): DiffHunk => ({
  oldStart: at - 3, oldLines: 7, newStart: at - 3 + shift, newLines: 7,
  lines: [...ctx(at - 3, at - 1), `-line ${at}`, `+edited ${at}`, ...ctx(at + 1, at + 3)],
});
// Rows as "oldN/newN text" so one assertion reads gutters and text together.
const rowsOf = (h: DiffHunk) => unifiedRows(h).map((r) => `${r.oldN ?? "-"}/${r.newN ?? "-"} ${r.text}`);

test("splitFileLines: a final newline is not a line", () => {
  expect(splitFileLines("a\nb\n")).toEqual(["a", "b"]);
  expect(splitFileLines("a\nb")).toEqual(["a", "b"]);
  expect(splitFileLines("")).toEqual([]);
  expect(splitFileLines("\n")).toEqual([""]);
});

test("above the first hunk: only an up expander, and 20 lines come off the bottom of the gap", () => {
  const { hunks, open } = expandHunks([change(40)], file(100));
  expect(open).toEqual([
    { key: 0, at: 0, hidden: 36, up: true, down: false },
    { key: 1, at: 1, hidden: 57, up: false, down: true },
  ]);
  expect(hunks).toHaveLength(1);

  const up = expandHunks([change(40)], file(100), reveal({}, 0, "up"));
  expect(up.hunks[0]!.newStart).toBe(17);
  expect(up.hunks[0]!.newLines).toBe(27);
  expect(rowsOf(up.hunks[0]!)[0]).toBe("17/17 line 17");
  expect(rowsOf(up.hunks[0]!)[19]).toBe("36/36 line 36");
  expect(up.open.find((o) => o.key === 0)).toEqual({ key: 0, at: 0, hidden: 16, up: true, down: false });
});

test("a gap smaller than the step opens in one click and the first hunk then starts at line 1", () => {
  const out = expandHunks([change(10)], file(100), reveal({}, 0, "up"));
  expect(out.hunks[0]!.newStart).toBe(1);
  expect(rowsOf(out.hunks[0]!)[0]).toBe("1/1 line 1");
  expect(out.open.map((o) => o.key)).toEqual([1]);
});

test("between hunks: down grows the hunk above, up grows the one below, and the numbers follow each side", () => {
  // The first change adds a line (+1), so new numbers run one ahead of old below it.
  const a: DiffHunk = { oldStart: 7, oldLines: 7, newStart: 7, newLines: 8, lines: [...ctx(7, 9), " line 10", "+inserted", ...ctx(11, 13)] };
  const b = change(60, 1);
  const base = expandHunks([a, b], file(100));
  expect(base.open.find((o) => o.key === 1)).toEqual({ key: 1, at: 1, hidden: 43, up: true, down: true });

  const down = expandHunks([a, b], file(100), reveal({}, 1, "down", 3));
  // New lines 15..17 follow the hunk; their old numbers are one lower.
  expect(rowsOf(down.hunks[0]!).slice(-3)).toEqual(["14/15 line 15", "15/16 line 16", "16/17 line 17"]);
  expect(down.hunks[1]).toEqual(b);

  const up = expandHunks([a, b], file(100), reveal({}, 1, "up", 3));
  expect(rowsOf(up.hunks[1]!).slice(0, 3)).toEqual(["54/55 line 55", "55/56 line 56", "56/57 line 57"]);
  expect(up.hunks[0]).toEqual(a);
});

test("revealing a whole gap merges the two hunks and leaves no seam", () => {
  const a = change(10);
  const b = change(30);
  const out = expandHunks([a, b], file(60), reveal({}, 1, "all"));
  expect(out.hunks).toHaveLength(1);
  const rows = rowsOf(out.hunks[0]!);
  // Every file line once, in order, edit rows in place.
  expect(rows.filter((r) => /line \d+$/.test(r) && !r.includes("-/") && !r.includes("/-")).length).toBeGreaterThan(0);
  const newNs = unifiedRows(out.hunks[0]!).map((r) => r.newN).filter((x): x is number => x != null);
  expect(newNs).toEqual(Array.from({ length: newNs.length }, (_, i) => 7 + i));
  expect(out.hunks[0]!.newLines).toBe(a.newLines + 13 + b.newLines);
  expect(out.open.map((o) => o.key)).toEqual([0, 2]);
});

test("below the last hunk: down to the end of a file that ends with a newline", () => {
  const text = file(50).join("\n") + "\n";
  const f = splitFileLines(text);
  const base = expandHunks([change(40)], f);
  expect(base.open.find((o) => o.key === 1)).toEqual({ key: 1, at: 1, hidden: 7, up: false, down: true });
  const out = expandHunks([change(40)], f, reveal({}, 1, "down"));
  expect(rowsOf(out.hunks[0]!).at(-1)).toBe("50/50 line 50");
  expect(out.open.map((o) => o.key)).toEqual([0]);
});

test("below the last hunk: a file WITHOUT a final newline ends on the same line", () => {
  const f = splitFileLines(file(50).join("\n"));
  const out = expandHunks([change(40)], f, reveal({}, 1, "all"));
  expect(rowsOf(out.hunks[0]!).at(-1)).toBe("50/50 line 50");
  expect(out.hunks[0]!.newLines).toBe(7 + 7);
});

test("a hunk that stops short of a full context has reached the end: no expander below it", () => {
  const short: DiffHunk = { oldStart: 47, oldLines: 4, newStart: 47, newLines: 4, lines: [...ctx(47, 48), "-line 49", "+edited 49", " line 50"] };
  expect(expandHunks([short], file(50)).open.map((o) => o.key)).toEqual([0]);
  // And before the file is loaded the same is known from the hunk alone.
  expect(expandHunks([short], null).open.map((o) => o.key)).toEqual([0]);
});

test("before the file is loaded the gap below the last hunk is offered with no size, and nothing is spliced", () => {
  const h = [change(40)];
  const out = expandHunks(h, null, reveal({}, 1, "down"));
  expect(out.hunks).toEqual(h);
  expect(out.open.find((o) => o.key === 1)).toEqual({ key: 1, at: 1, hidden: null, up: false, down: true });
});

test("a file shorter than the diff says (stale pair) is left alone", () => {
  const h = [change(40)];
  expect(expandHunks(h, file(30), reveal({}, 0, "up"))).toEqual({ hunks: h, open: [] });
});

test("the step is 20, and clicks add up", () => {
  expect(EXPAND_STEP).toBe(20);
  expect(reveal(reveal({}, 2, "down"), 2, "down")[2]).toEqual({ top: 40, bottom: 0 });
  expect(reveal(reveal({}, 2, "down"), 2, "up")[2]).toEqual({ top: 20, bottom: 20 });
});
