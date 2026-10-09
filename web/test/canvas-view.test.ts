/*
 * What the window decides about a sheet: which fit is shown for a panel width
 * (the PANEL's, not the viewport's), how an opening is eased, and the way a
 * moon travels between two angles.
 */
import { describe, expect, test } from "bun:test";
import { CLOSE_MS, NARROW_PX, OPEN_MS, angleBetween, easeOut, fitOf } from "../src/lib/canvasView.ts";

describe("fit", () => {
  test("below 900 px the panel is narrow, at 900 it is wide", () => {
    expect(fitOf(NARROW_PX - 1)).toBe("narrow");
    expect(fitOf(NARROW_PX)).toBe("wide");
    expect(fitOf(0)).toBe("narrow");
    expect(fitOf(1e9)).toBe("wide");
  });
});

describe("the opening", () => {
  test("180 ms to open, 120 to close, eased out, and a phase outside 0..1 is held to it", () => {
    expect(OPEN_MS).toBe(180);
    expect(CLOSE_MS).toBe(120);
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    expect(easeOut(-3)).toBe(0);
    expect(easeOut(9)).toBe(1);
  });
});

describe("a moon's travel", () => {
  test("it takes the shorter way round, clockwise when they are level", () => {
    expect(angleBetween(10, 50, 0.5)).toBeCloseTo(30, 6);
    expect(angleBetween(350, 10, 0.5)).toBeCloseTo(0, 6);
    expect(angleBetween(10, 350, 0.5)).toBeCloseTo(0, 6);
    expect(angleBetween(0, 180, 0.5)).toBeCloseTo(90, 6);
  });
  test("it starts where it was and ends where it was told, and the result is always in [0, 360)", () => {
    for (const [a, b] of [[0, 359], [359, 0], [270, 321], [12, 270]] as const) {
      expect(angleBetween(a, b, 0)).toBeCloseTo(a, 6);
      expect(angleBetween(a, b, 1)).toBeCloseTo(b % 360, 6);
      for (const t of [0.25, 0.5, 0.75, 7, -2]) { const v = angleBetween(a, b, t); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(360); }
    }
  });
});
