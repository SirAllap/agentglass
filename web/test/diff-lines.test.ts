// The row builders behind every diff surface (unified and split).
//
// These are the parts of the renderer a screenshot cannot check. A gutter that
// counts one too high, a removal that never gets a row because the addition
// opposite it ran out, a carriage return that reaches the DOM — each of those
// is a handful of pixels in a 400-row diff, and each of them has shipped.
//
// Pure functions only: no DOM, no React. The components are thin wrappers over
// what is tested here.
import { test, expect } from "bun:test";
import type { DiffHunk } from "../../shared/types.ts";
import { unifiedRows, splitRows, tokenDiff, attachTokenDiff, type URow } from "../src/components/diff/DiffLines.tsx";

const hunk = (over: Partial<DiffHunk> & Pick<DiffHunk, "lines">): DiffHunk =>
  ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, ...over });

// --- context only ------------------------------------------------------------

test("a hunk of nothing but context numbers both gutters in step", () => {
  const rows = unifiedRows(hunk({ oldStart: 12, newStart: 20, lines: [" a", " b", " c"] }));
  expect(rows.map((r) => r.kind)).toEqual(["ctx", "ctx", "ctx"]);
  expect(rows.map((r) => r.oldN)).toEqual([12, 13, 14]);
  expect(rows.map((r) => r.newN)).toEqual([20, 21, 22]);
  // Nothing changed, so nothing may be painted as changed.
  expect(rows.every((r) => !r.segs)).toBe(true);
});

test("context-only split rows put the same line on both sides", () => {
  const rows = splitRows(hunk({ oldStart: 12, newStart: 20, lines: [" a", " b"] }));
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => [r.l?.num, r.r?.num])).toEqual([[12, 20], [13, 21]]);
  expect(rows.every((r) => r.l?.text === r.r?.text)).toBe(true);
});

// --- no trailing newline -----------------------------------------------------

// Upstream strips the "\ No newline at end of file" marker, so what arrives is
// simply a hunk that stops. It must read exactly like the same change in a file
// that does end in a newline — the two cases are indistinguishable to a reader.
const ENDS_ABRUPTLY = hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" one", "-two", "+two!"] });
const CARRIES_MARKER = hunk({
  oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
  lines: [" one", "-two", "\\ No newline at end of file", "+two!", "\\ No newline at end of file"],
});

test("a hunk that just ends renders as an ordinary change", () => {
  const rows = unifiedRows(ENDS_ABRUPTLY);
  expect(rows.map((r) => r.text)).toEqual(["one", "two", "two!"]);
  expect(rows.map((r) => r.oldN)).toEqual([1, 2, null]);
  expect(rows.map((r) => r.newN)).toEqual([1, null, 2]);
});

test("the no-newline marker changes nothing if it survives to the renderer", () => {
  // Same rows either way: the marker is metadata, and counting it as context
  // painted a phantom line AND pushed every number below it up by one.
  expect(unifiedRows(CARRIES_MARKER)).toEqual(unifiedRows(ENDS_ABRUPTLY));
  expect(splitRows(CARRIES_MARKER)).toEqual(splitRows(ENDS_ABRUPTLY));
});

test("a dropped marker does not split the pair it sits between", () => {
  const rows = splitRows(CARRIES_MARKER);
  expect(rows).toHaveLength(2);
  expect([rows[1]!.l!.text, rows[1]!.r!.text]).toEqual(["two", "two!"]);
  expect(rows[1]!.r!.num).toBe(2); // not 3
});

// --- CRLF --------------------------------------------------------------------

// A CRLF file reaches the renderer as " foo\r". The prefix is still at index 0,
// so the +/- reading is safe — but the CR used to ride into the row text, where
// `white-space: pre` treats it as a segment break (a blank half-row under every
// line) and it follows the code into the clipboard on copy.
const CRLF = hunk({
  oldStart: 5, oldLines: 3, newStart: 5, newLines: 3,
  lines: [" const a = 1;\r", "-const b = 2;\r", "+const b = 3;\r", " const c = 4;\r"],
});

test("a carriage return never reaches the rendered text", () => {
  const rows = unifiedRows(CRLF);
  expect(rows.map((r) => r.text)).toEqual(["const a = 1;", "const b = 2;", "const b = 3;", "const c = 4;"]);
  expect(rows.some((r) => r.text.includes("\r"))).toBe(false);
});

test("the CR does not shift the +/- reading or the gutters", () => {
  const rows = unifiedRows(CRLF);
  expect(rows.map((r) => r.kind)).toEqual(["ctx", "del", "add", "ctx"]);
  expect(rows.map((r) => r.oldN)).toEqual([5, 6, null, 7]);
  expect(rows.map((r) => r.newN)).toEqual([5, null, 6, 7]);
});

test("split rows strip the CR on both sides", () => {
  const rows = splitRows(CRLF);
  expect(rows.map((r) => r.l?.text)).toEqual(["const a = 1;", "const b = 2;", "const c = 4;"]);
  expect(rows.map((r) => r.r?.text)).toEqual(["const a = 1;", "const b = 3;", "const c = 4;"]);
});

test("the token diff runs on the stripped text, not on the CR", () => {
  const rows = unifiedRows(CRLF);
  const del = rows[1]!, add = rows[2]!;
  // A trailing CR on both sides is a token both lines share; leaving it in made
  // it a silent partner in the similarity score and in every segment length.
  expect(del.segs!.map((s) => s.text).join("")).toBe("const b = 2;");
  expect(add.segs!.map((s) => s.text).join("")).toBe("const b = 3;");
  expect(del.segs!.filter((s) => s.hi).map((s) => s.text)).toEqual(["2"]);
  expect(add.segs!.filter((s) => s.hi).map((s) => s.text)).toEqual(["3"]);
});

// --- a one-line file ---------------------------------------------------------

test("a one-line file that only has context", () => {
  const h = hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [" only line"] });
  expect(unifiedRows(h)).toEqual([{ oldN: 1, newN: 1, text: "only line", kind: "ctx" }]);
  expect(splitRows(h)).toEqual([{ l: { num: 1, text: "only line", kind: "ctx" }, r: { num: 1, text: "only line", kind: "ctx" } }]);
});

test("a one-line file rewritten is one unified pair and one split row", () => {
  const h = hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-hello", "+goodbye"] });
  expect(unifiedRows(h).map((r) => [r.oldN, r.newN, r.text])).toEqual([[1, null, "hello"], [null, 1, "goodbye"]]);
  const rows = splitRows(h);
  expect(rows).toHaveLength(1);
  expect([rows[0]!.l!.text, rows[0]!.r!.text]).toEqual(["hello", "goodbye"]);
  // Two words with nothing in common: no intra-line highlight, or the reader is
  // told to compare characters that were never related.
  expect(rows[0]!.l!.segs).toBeUndefined();
});

// --- one-sided hunks ---------------------------------------------------------

test("an added-only hunk leaves the old gutter empty throughout", () => {
  // git writes `@@ -0,0 +1,3 @@` for a new file: oldStart is 0 and must not
  // leak into a gutter as a line "0".
  const h = hunk({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ["+a", "+b", "+c"] });
  const rows = unifiedRows(h);
  expect(rows.map((r) => r.oldN)).toEqual([null, null, null]);
  expect(rows.map((r) => r.newN)).toEqual([1, 2, 3]);
  const split = splitRows(h);
  expect(split.map((r) => r.l)).toEqual([null, null, null]);
  expect(split.map((r) => r.r?.num)).toEqual([1, 2, 3]);
});

test("a deleted-only hunk leaves the new gutter empty throughout", () => {
  const h = hunk({ oldStart: 1, oldLines: 3, newStart: 0, newLines: 0, lines: ["-a", "-b", "-c"] });
  const rows = unifiedRows(h);
  expect(rows.map((r) => r.oldN)).toEqual([1, 2, 3]);
  expect(rows.map((r) => r.newN)).toEqual([null, null, null]);
  const split = splitRows(h);
  expect(split.map((r) => r.l?.num)).toEqual([1, 2, 3]);
  expect(split.map((r) => r.r)).toEqual([null, null, null]);
});

// --- several hunks in one file -----------------------------------------------

test("the second hunk starts at its own oldStart/newStart", () => {
  // Hunks are islands with skipped lines between them. A counter carried across
  // them would number the second hunk as though the gap were not there.
  const first = hunk({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+B", " c"] });
  const second = hunk({ oldStart: 80, oldLines: 2, newStart: 80, newLines: 3, lines: [" z", "+zz", " y"] });
  const one = unifiedRows(first), two = unifiedRows(second);
  expect(one[one.length - 1]!.oldN).toBe(3);
  expect(two.map((r) => r.oldN)).toEqual([80, null, 81]);
  expect(two.map((r) => r.newN)).toEqual([80, 81, 82]);
  // And the split view agrees with the unified one about where hunk two begins.
  expect(splitRows(second)[0]!.l!.num).toBe(80);
});

// --- split pairing when the sides are different lengths ----------------------

test("three removals for one addition keep all four lines", () => {
  const rows = splitRows(hunk({ oldStart: 10, oldLines: 3, newStart: 10, newLines: 1, lines: ["-a", "-b", "-c", "+x"] }));
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.l?.text)).toEqual(["a", "b", "c"]);
  // Pairing to the shorter side would have rendered one row and silently eaten
  // two deletions; padding the short side keeps the columns honest.
  expect(rows.map((r) => r.r?.text)).toEqual(["x", undefined, undefined]);
  expect(rows.map((r) => r.l?.num)).toEqual([10, 11, 12]);
});

test("one removal for three additions keeps all four lines", () => {
  const rows = splitRows(hunk({ oldStart: 10, oldLines: 1, newStart: 10, newLines: 3, lines: ["-a", "+x", "+y", "+z"] }));
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.r?.text)).toEqual(["x", "y", "z"]);
  expect(rows.map((r) => r.l?.text)).toEqual(["a", undefined, undefined]);
  expect(rows.map((r) => r.r?.num)).toEqual([10, 11, 12]);
});

test("a context line closes the change block instead of pairing across it", () => {
  const rows = splitRows(hunk({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: ["-a", " mid", "+x"] }));
  // Three rows, not two: `a` and `x` are on opposite sides of a line git told
  // us is unchanged, so they are not two halves of one edit.
  expect(rows.map((r) => [r.l?.text ?? null, r.r?.text ?? null])).toEqual([
    ["a", null],
    ["mid", "mid"],
    [null, "x"],
  ]);
});

// --- intra-line (token) diff -------------------------------------------------

test("identical lines produce no segments at all", () => {
  expect(tokenDiff("const x = 1;", "const x = 1;")).toBeNull();
  expect(tokenDiff("", "")).toBeNull();
  expect(tokenDiff("only left", "")).toBeNull();
});

test("a line changed at both ends is reconstructed exactly by its segments", () => {
  const a = "const total = sum(items, seed);";
  const b = "let total = sum(items, base);";
  const td = tokenDiff(a, b)!;
  expect(td).not.toBeNull();
  // The invariant the renderer depends on: segments are the whole line, in
  // order. Anything else paints code the file does not contain.
  expect(td.left.map((s) => s.text).join("")).toBe(a);
  expect(td.right.map((s) => s.text).join("")).toBe(b);
  expect(td.left.filter((s) => s.hi).map((s) => s.text)).toEqual(["const", "seed"]);
  expect(td.right.filter((s) => s.hi).map((s) => s.text)).toEqual(["let", "base"]);
  // Adjacent runs of the same verdict are merged, so the untouched middle is
  // one span rather than one per token.
  expect(td.left).toHaveLength(4);
});

test("lines with nothing in common are left plain", () => {
  // The del/add pairing is positional, so unrelated lines land opposite each
  // other all the time. Highlighting those is telling the reader to compare
  // noise.
  expect(tokenDiff("import { readFile } from 'node:fs';", "})")).toBeNull();
});

test("attachTokenDiff pairs by offset within a block and never across context", () => {
  const rows: URow[] = [
    { oldN: 1, newN: null, text: "const a = 1;", kind: "del" },
    { oldN: null, newN: 1, text: "const a = 2;", kind: "add" },
    { oldN: 2, newN: 2, text: "const b = 3;", kind: "ctx" },
    { oldN: 3, newN: null, text: "const c = 4;", kind: "del" },
  ];
  attachTokenDiff(rows);
  expect(rows[0]!.segs!.filter((s) => s.hi).map((s) => s.text)).toEqual(["1"]);
  expect(rows[1]!.segs!.filter((s) => s.hi).map((s) => s.text)).toEqual(["2"]);
  expect(rows[2]!.segs).toBeUndefined();
  // A removal with no addition opposite it has nothing to be compared against —
  // it must not borrow the context line above or the block before it.
  expect(rows[3]!.segs).toBeUndefined();
});

test("an empty line is a line, not a missing one", () => {
  // git writes a blank context line as a lone space, and some producers emit
  // the empty string. Both are one row, and both still move the gutters.
  const rows = unifiedRows(hunk({ oldStart: 4, newStart: 4, lines: [" ", "", " x"] }));
  expect(rows.map((r) => r.text)).toEqual(["", "", "x"]);
  expect(rows.map((r) => r.oldN)).toEqual([4, 5, 6]);
});
