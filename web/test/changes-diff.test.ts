// The row builders behind the Changes/Git diff (unified and split views).
//
// The regression these pin: git ends a hunk whose file has no trailing newline
// with a "\ No newline at end of file" marker. It is metadata about the file,
// not a line of it — every other diff parser in the app drops it — but the two
// row builders keyed off the first character and, seeing anything but +/-,
// counted it as a context line. That painted a phantom row reading " No newline
// at end of file" AND advanced the old/new gutters, so every line number below
// it was off by one.
import { test, expect, beforeAll } from "bun:test";
import type { DiffHunk } from "../../shared/types.ts";

let rows: typeof import("../src/components/ChangesModal.tsx");

beforeAll(async () => {
  // ChangesModal pulls in api.ts, which resolves the server address from these
  // at import time; nothing here touches a real DOM, the row builders are pure.
  (globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  rows = await import("../src/components/ChangesModal.tsx");
});

// A one-line change to a file with no trailing newline: git repeats the marker
// after each side.
const HUNK: DiffHunk = {
  oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
  lines: [" one", "-two", "\\ No newline at end of file", "+two!", "\\ No newline at end of file"],
};

test("unified rows drop the no-newline marker instead of painting a phantom line", () => {
  const out = rows.unifiedRows(HUNK);
  expect(out.map((r) => r.text)).toEqual(["one", "two", "two!"]);
  expect(out.map((r) => r.kind)).toEqual(["ctx", "del", "add"]);
  // No " No newline at end of file" row snuck in as context.
  expect(out.some((r) => r.text.includes("No newline"))).toBe(false);
});

test("unified gutter numbers stay put — the marker does not advance them", () => {
  const out = rows.unifiedRows(HUNK);
  expect(out.map((r) => r.oldN)).toEqual([1, 2, null]);
  // Counting the marker as context would have pushed the added line to 3.
  expect(out.map((r) => r.newN)).toEqual([1, null, 2]);
});

test("split rows drop the marker and keep the pair aligned", () => {
  const out = rows.splitRows(HUNK);
  // Two rows: the shared context, then the −/+ pair — not a phantom third.
  expect(out).toHaveLength(2);
  expect(out[0]!.l!.text).toBe("one");
  expect(out[1]!.l!.text).toBe("two");
  expect(out[1]!.r!.text).toBe("two!");
  // The added side is line 2 of the new file, not 3.
  expect(out[1]!.r!.num).toBe(2);
});
