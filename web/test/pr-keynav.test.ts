// j/k file navigation in the PR files tab wraps, and starts sensibly from no
// selection (PR panel keyboard nav). The wrap-around is the pure part of
// the handler; the DOM parts (hunk scroll, focus, input guard) mirror the
// changes modal verbatim.
import { test, expect } from "bun:test";
import { stepFileIndex } from "../src/lib/prNav.ts";

test("j/k wrap around the file list", () => {
  expect(stepFileIndex(5, 0, 1)).toBe(1);
  expect(stepFileIndex(5, 4, 1)).toBe(0); // past the end → first
  expect(stepFileIndex(5, 0, -1)).toBe(4); // before the start → last
  expect(stepFileIndex(5, 2, -1)).toBe(1);
});

test("from no selection, j lands on the first file and k on the last", () => {
  expect(stepFileIndex(5, -1, 1)).toBe(0);
  expect(stepFileIndex(5, -1, -1)).toBe(4);
});

test("an empty file list has no next index", () => {
  expect(stepFileIndex(0, -1, 1)).toBe(-1);
});
