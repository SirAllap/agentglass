/**
 * The panel hung off the button's RIGHT edge, which was fine while the button
 * sat at the end of a row of pills. With the pills gone the button is the first
 * thing in the bar, and a 520px panel anchored by its right side landed almost
 * entirely off the left of the window — a dark empty strip over the header.
 */
import { test, expect } from "bun:test";
import { panelAt } from "../src/components/tasks/FilterBuilder.tsx";

const btn = (left: number, bottom = 160) => ({ left, bottom });

test("a button near the left edge opens the panel under itself", () => {
  const at = panelAt(btn(64), 1920);
  expect(at.left).toBe(64);
  expect(at.top).toBe(166);
});

test("a button near the right edge is pulled back inside the window", () => {
  const at = panelAt(btn(1800), 1920);
  /* 1920 - 720 - 8: the panel's right edge lands on the margin rather than
     past it, which is what the right-anchor was there to do. */
  expect(at.left).toBe(1192);
  expect(at.left + 720).toBeLessThanOrEqual(1920 - 8);
});

test("a window narrower than the panel still starts it on screen", () => {
  /* 94vw is below the 520 minimum here, so the box is wider than what is left
     and the clamp would go negative. It pins to the margin instead — the panel
     overhangs to the right, where `maxWidth` catches it, rather than starting
     off screen where nothing can. */
  expect(panelAt(btn(200), 480).left).toBe(8);
});
