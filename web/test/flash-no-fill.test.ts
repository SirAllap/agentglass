import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();

// A jump target is marked by its ring alone. A tint over a card repaints the
// card's own background, which read as the comment itself changing colour.
test("the jump flash draws a ring and sets no background", () => {
  const start = css.indexOf("@keyframes agx-flash-pulse");
  expect(start).toBeGreaterThan(-1);
  const body = css.slice(start, css.indexOf("\n}\n", start));
  expect(body).toContain("box-shadow");
  expect(body).not.toMatch(/background/);
  const rule = css.slice(css.indexOf("\n.agx-flash {"), css.indexOf("\n}\n", css.indexOf("\n.agx-flash {")));
  expect(rule).not.toMatch(/background/);
});
