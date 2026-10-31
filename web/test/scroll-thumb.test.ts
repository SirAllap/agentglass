import { describe, expect, test } from "bun:test";
import { scrollForPress, thumbFor, THUMB_MIN } from "../src/lib/scrollThumb.ts";

describe("the drawn thumb", () => {
  test("nothing to scroll, nothing drawn", () => {
    const t = thumbFor(0, 300, 300);
    expect(t.over).toBe(false);
    expect(t.more).toEqual({ above: false, below: false });
  });
  test("at the top: no fade above, one below, thumb at the start", () => {
    const t = thumbFor(0, 400, 800);
    expect(t.over).toBe(true);
    expect(t.more).toEqual({ above: false, below: true });
    expect(t.top).toBe(0);
    expect(t.height).toBe(196);
  });
  test("at the bottom: the thumb ends where the track ends", () => {
    const t = thumbFor(400, 400, 800);
    expect(t.more).toEqual({ above: true, below: false });
    expect(t.top + t.height).toBeCloseTo(t.track, 5);
  });
  test("a very long list keeps a thumb you can grab", () => {
    expect(thumbFor(0, 400, 40_000).height).toBe(THUMB_MIN);
  });
});

describe("a press on the track", () => {
  test("in the middle centres the thumb there", () => {
    const t = thumbFor(0, 400, 800);
    expect(scrollForPress(t.track / 2, t.height, t.track, 400, 800)).toBeCloseTo(200, 5);
  });
  test("past either end stays inside the scroller", () => {
    expect(scrollForPress(-50, 100, 300, 400, 800)).toBe(0);
    expect(scrollForPress(900, 100, 300, 400, 800)).toBe(400);
  });
});
