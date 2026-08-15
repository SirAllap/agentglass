// j/k file navigation in the PR files tab wraps, and starts sensibly from no
// selection (PR panel keyboard nav). The wrap-around is the pure part of
// the handler; the DOM parts (hunk scroll, focus, input guard) mirror the
// changes modal verbatim.
import { test, expect } from "bun:test";
import { afterViewed, stepFileIndex } from "../src/lib/prNav.ts";

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

/*
 * Ticking "Viewed" moves you on, and what "on" means depends on the layout.
 *
 * Reported in one-file mode: marking the file viewed folded it and left you
 * looking at the same collapsed header, because the move was a scroll to a file
 * that was not on the page — the column only ever holds one.
 */
const FILES = ["a.ts", "b.ts", "c.ts"];

test("in one-file mode, viewed opens the next file", () => {
  expect(afterViewed(FILES, "a.ts", { oneFile: true, wasViewed: false })).toEqual({ kind: "open", path: "b.ts" });
});

test("in the stack, viewed scrolls to the next file", () => {
  expect(afterViewed(FILES, "a.ts", { oneFile: false, wasViewed: false })).toEqual({ kind: "scroll", path: "b.ts" });
});

test("the last file stays put — one-file mode has nowhere to go, the stack holds what it just folded", () => {
  expect(afterViewed(FILES, "c.ts", { oneFile: true, wasViewed: false })).toEqual({ kind: "stay" });
  expect(afterViewed(FILES, "c.ts", { oneFile: false, wasViewed: false })).toEqual({ kind: "scroll", path: "c.ts" });
});

test("un-ticking viewed never moves you", () => {
  expect(afterViewed(FILES, "a.ts", { oneFile: true, wasViewed: true })).toEqual({ kind: "stay" });
  expect(afterViewed(FILES, "a.ts", { oneFile: false, wasViewed: true })).toEqual({ kind: "stay" });
});

test("a file the list no longer holds — filtered away mid-tick — moves nothing", () => {
  // indexOf is -1 there, and `paths[-1 + 1]` is the FIRST file: without the
  // guard, viewing a filtered-out file threw you back to the top of the list.
  expect(afterViewed(FILES, "gone.ts", { oneFile: true, wasViewed: false })).toEqual({ kind: "stay" });
  expect(afterViewed(FILES, "gone.ts", { oneFile: false, wasViewed: false })).toEqual({ kind: "stay" });
});
