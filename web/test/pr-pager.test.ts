// There is no Previous/Next: the board's pages append through a Load more card.
// A page stack left over from a wide view must not follow the two queues (Needs
// my review, Mine), nor leave the list on a page that no longer exists.
import { test, expect } from "bun:test";
import { pageRanOut } from "../src/lib/prPager.ts";

test("a page past the end is taken back, page one never is", () => {
  expect(pageRanOut({ pageDepth: 1, rows: 0, hasNext: false })).toBe(true);
  expect(pageRanOut({ pageDepth: 1, rows: 2, hasNext: false })).toBe(false);
  expect(pageRanOut({ pageDepth: 0, rows: 0, hasNext: false })).toBe(false);
});

test("PrPanel pages by Load more, with no Previous/Next footer", async () => {
  const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
  expect(src).not.toContain("pagerShown");
  expect(src).not.toContain("‹ Previous");
  expect(src).toContain("listState.hasNext && listState.cursor");
  expect(src).toContain("pageRanOut({");
  expect(src).toMatch(/if \(queuesOnly\) setPages\(/);
});
