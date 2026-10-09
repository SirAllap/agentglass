// The pager belongs to the table. A page index carried over from the table (or
// left behind by a detail that shrank the list) must not put a "Page 2 of 2"
// footer under the board, nor leave the table on a page that no longer exists.
import { test, expect } from "bun:test";
import { pagerShown, pageRanOut } from "../src/lib/prPager.ts";

test("no pager under the board, on any page", () => {
  expect(pagerShown({ hasRepo: true, boardShown: true, hasNext: false, pageDepth: 1 })).toBe(false);
  expect(pagerShown({ hasRepo: true, boardShown: true, hasNext: true, pageDepth: 0 })).toBe(false);
});

test("the table keeps its pager when it has somewhere to go", () => {
  expect(pagerShown({ hasRepo: true, boardShown: false, hasNext: true, pageDepth: 0 })).toBe(true);
  expect(pagerShown({ hasRepo: true, boardShown: false, hasNext: false, pageDepth: 1 })).toBe(true);
  expect(pagerShown({ hasRepo: true, boardShown: false, hasNext: false, pageDepth: 0 })).toBe(false);
  expect(pagerShown({ hasRepo: false, boardShown: false, hasNext: true, pageDepth: 0 })).toBe(false);
});

test("a page past the end is taken back, page one never is", () => {
  expect(pageRanOut({ pageDepth: 1, rows: 0, hasNext: false })).toBe(true);
  expect(pageRanOut({ pageDepth: 1, rows: 2, hasNext: false })).toBe(false);
  expect(pageRanOut({ pageDepth: 0, rows: 0, hasNext: false })).toBe(false);
});

test("PrPanel routes both decisions through the helpers", async () => {
  const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
  expect(src).toContain("pagerShown({");
  expect(src).toContain("pageRanOut({");
  expect(src).toMatch(/if \(boardShown\) setPages\(/);
});
