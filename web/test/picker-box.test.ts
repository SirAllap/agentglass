import { describe, expect, it } from "bun:test";
import { placeInBox, type PickerPlacement } from "../src/lib/pickerBox.ts";

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

/* The pull request's body: the box the pencil's picker belongs to, from the
   prose column to the sidebar's right edge. The people picker asks for 440x320
   and the pencil is a 16px button at the section's right edge. */
const panel = box(300, 88, 1440, 900);
const pencil = box(1400, 300, 1416, 316);
const size = { width: 440, height: 320 };

const inside = (p: PickerPlacement, b: ReturnType<typeof box>, pad = 8) =>
  p.left >= b.left + pad - 0.001
  && p.left + p.width <= b.right - pad + 0.001
  && p.top >= b.top + pad - 0.001
  && p.top + p.height <= b.bottom - pad + 0.001;

const scaleBox = (b: ReturnType<typeof box>, k: number) => box(b.left * k, b.top * k, b.right * k, b.bottom * k);
const scaleSize = (s: typeof size, k: number) => ({ width: s.width * k, height: s.height * k });

describe("placeInBox", () => {
  for (const k of [0.8, 0.91, 1]) {
    it(`stays inside the panel at ${k * 100}% zoom`, () => {
      const b = scaleBox(panel, k);
      const p = placeInBox(scaleBox(pencil, k), scaleSize(size, k), b);
      expect(inside(p, b)).toBe(true);
    });
  }

  it("keeps its right edge on the pencil when the panel has the room", () => {
    const wide = box(900, 88, 1440, 900);
    const p = placeInBox(pencil, { width: 240, height: 320 }, wide);
    expect(p.left + p.width).toBe(pencil.right);
    expect(p.side).toBe("below");
  });

  it("hangs directly under the pencil, not over the block above it", () => {
    const p = placeInBox(pencil, size, panel);
    expect(p.top).toBe(pencil.bottom + 6);
    expect(p.left).toBeLessThan(pencil.left);
  });

  it("never draws wider than the box it was given", () => {
    const narrow = box(1192, 88, 1440, 900);
    const p = placeInBox(pencil, size, narrow);
    expect(p.width).toBe(narrow.right - narrow.left - 16);
    expect(inside(p, narrow)).toBe(true);
  });

  it("flips above when there is no room below", () => {
    const low = box(1400, 860, 1416, 876);
    const p = placeInBox(low, size, panel);
    expect(p.side).toBe("above");
    expect(p.top).toBe(low.top - 6 - p.height);
    expect(p.top).toBeGreaterThanOrEqual(panel.top + 8);
  });

  it("stays below and scrolls when below is the roomier side", () => {
    const short = box(1192, 88, 1440, 380);
    const p = placeInBox(box(1400, 100, 1416, 116), size, short);
    expect(p.side).toBe("below");
    expect(p.height).toBeLessThan(size.height);
    expect(p.maxHeight).toBe(p.height);
    expect(inside(p, short)).toBe(true);
  });

  it("opens upward when it is asked to, so what sits under the trigger stays in view", () => {
    const low = box(1400, 600, 1416, 616);
    const p = placeInBox(low, size, panel, undefined, undefined, "above");
    expect(p.side).toBe("above");
    expect(p.top).toBe(low.top - 6 - p.height);
    expect(p.height).toBe(size.height);
    expect(inside(p, panel)).toBe(true);
  });

  it("stays upward while it can still draw half the picker, and scrolls rather than cover what is below", () => {
    // Room above for four of its rows and less than its whole height; below there is more room.
    const mid = box(1400, 380, 1416, 396);
    const p = placeInBox(mid, size, panel, undefined, undefined, "above");
    expect(p.side).toBe("above");
    expect(p.height).toBeLessThan(size.height);
    expect(p.height).toBeGreaterThanOrEqual(size.height / 2);
    expect(p.top).toBe(mid.top - 6 - p.height);
  });

  it("still opens below when there is no room above it", () => {
    const top = box(1400, 92, 1416, 108);
    const p = placeInBox(top, size, panel, undefined, undefined, "above");
    expect(p.side).toBe("below");
    expect(inside(p, panel)).toBe(true);
  });
});
