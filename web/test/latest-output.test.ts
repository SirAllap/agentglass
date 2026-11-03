/*
 * The "Latest output" pill shows from 80 px behind the bottom, lifts above the blocked note, and scrolls smoothly unless motion is reduced.
 */
import { describe, expect, test } from "bun:test";
import { pillBottom, pxBehind, scrollBehavior, showLatest, LATEST_SHOW_PX } from "../src/lib/latestOutput.ts";

describe("distance", () => {
  test("rows below the viewport times the cell height", () => {
    expect(pxBehind(100, 90, 17)).toBe(170);
  });
  test("at the bottom, or with no scrollback (tmux alt screen), it is 0", () => {
    expect(pxBehind(100, 100, 17)).toBe(0);
    expect(pxBehind(0, 0, 17)).toBe(0);
    expect(pxBehind(5, 9, 17)).toBe(0);
  });
  test("no cell size yet reads as 0, never NaN", () => {
    expect(pxBehind(100, 0, 0)).toBe(0);
  });
});

describe("threshold", () => {
  test("79 px hides, 80 px shows", () => {
    expect(showLatest(LATEST_SHOW_PX - 1)).toBe(false);
    expect(showLatest(LATEST_SHOW_PX)).toBe(true);
  });
});

test("sits at 14 px, and at 64 px when the blocked note is up", () => {
  expect(pillBottom(false)).toBe(14);
  expect(pillBottom(true)).toBe(64);
});

test("smooth scroll unless reduced motion", () => {
  expect(scrollBehavior(false)).toBe("smooth");
  expect(scrollBehavior(true)).toBe("auto");
});
