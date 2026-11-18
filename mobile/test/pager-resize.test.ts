/*
 * A pager keeps the lane it was on when the page changes width.
 *
 * `pagingEnabled` moves by the list's width, and the list keeps its offset in
 * pixels, so after a rotate the lane under the strip is `offset / the new
 * width` — a different lane. Both boards promise that the tab lit and the lane
 * under it cannot disagree, and both had the arithmetic that breaks it.
 *
 * Asserted against source: the fix is an effect nobody can call without a
 * mounted list, and what it must be is one `scrollToIndex` keyed on the width.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (...p: string[]): string => readFileSync(join(import.meta.dir, "..", ...p), "utf8");
const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the pull-request board", () => {
  const board = strip(src("src", "board", "LaneBoard.tsx"));

  test("puts the same lane back when the width moves, without animating", () => {
    expect(board).toContain("laidOut.current === width");
    expect(board).toContain("scrollToIndex({ index, animated: false })");
    expect(board).toMatch(/\[width, index, lanes\.length\]/);
  });

  test("and lets the strip's own pick animate, as before", () => {
    expect(board).toContain("scrollToIndex({ index: next, animated: true })");
  });
});

describe("the Jira board", () => {
  const board = strip(src("src", "jira", "Board.tsx"));

  test("does the same for its pages, which are also the screen's width", () => {
    expect(board).toContain("laidOut.current === page");
    expect(board).toContain("scrollToIndex({ index: lane, animated: false })");
  });
});
