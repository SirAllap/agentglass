/*
 * A working-tree file's diff, flattened for a phone-width list.
 *
 * `/git/file-diff` answers with hunks whose lines carry their sign in the first
 * character; a screen needs a header per hunk, a row per line and the line
 * numbers a reader quotes. Pinned here because the arithmetic (a removed line
 * has no new number, an added one no old number) is what goes wrong quietly.
 */
import { expect, test } from "bun:test";
import { gitDiffRows, gitDiffTotals } from "../src/model/gitDiffRows.ts";

const hunk = {
  oldStart: 10, oldLines: 3, newStart: 10, newLines: 3,
  lines: [" keep", "-old value", "+new value", " tail"],
};

test("a header per hunk, then a row per line, numbered on the side that has it", () => {
  const rows = gitDiffRows([hunk]);
  expect(rows[0]).toEqual({ key: "h0", kind: "hunk", text: "@@ -10,3 +10,3 @@" });
  expect(rows.slice(1).map((r) => [r.kind, r.old, r.new, r.text])).toEqual([
    ["ctx", 10, 10, "keep"],
    ["del", 11, undefined, "old value"],
    ["add", undefined, 11, "new value"],
    ["ctx", 12, 12, "tail"],
  ]);
});

test("keys are positions, so two identical lines stay two rows", () => {
  const rows = gitDiffRows([{ ...hunk, lines: ["+same", "+same"] }]);
  expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
});

test("totals count what changed, not the context", () => {
  expect(gitDiffTotals([hunk])).toEqual({ added: 1, removed: 1 });
});

test("no hunks is no rows", () => {
  expect(gitDiffRows([])).toEqual([]);
});
