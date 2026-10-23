/*
 * A commit's file box is capped at 520px. The diff inside it used to be its own
 * scroller; once the Files tab began scrolling with the page, the box clipped
 * the rest of a long file with nothing to scroll. The box's body must scroll.
 */
import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

test("a commit's file box scrolls its own diff", () => {
  const at = src.indexOf("function FileStack(");
  const body = src.slice(at, src.indexOf("\n}\n", at));
  expect(body).toContain("maxHeight: 520");
  expect(body).toMatch(/data-vscroll className="[^"]*overflow-auto/);
});
