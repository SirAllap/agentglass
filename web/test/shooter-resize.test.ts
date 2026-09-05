/*
 * Dragging a handle on a screenshot selection.
 *
 * The rule worth pinning is the flip: pull the left edge past the right one and
 * the selection should turn inside out, not become a rectangle with a negative
 * width — which is a thing that draws nothing, silently, and reads as the tool
 * having died.
 */
import { describe, expect, test } from "bun:test";
import { resize } from "../src/components/browser/Shooter.tsx";

const base = { x: 100, y: 100, width: 200, height: 100 };

describe("a handle, moved", () => {
  test("an edge moves only its own side", () => {
    expect(resize(base, "e", { x: 400, y: 0 })).toEqual({ x: 100, y: 100, width: 300, height: 100 });
    expect(resize(base, "w", { x: 50, y: 0 })).toEqual({ x: 50, y: 100, width: 250, height: 100 });
    expect(resize(base, "n", { x: 0, y: 60 })).toEqual({ x: 100, y: 60, width: 200, height: 140 });
    expect(resize(base, "s", { x: 0, y: 260 })).toEqual({ x: 100, y: 100, width: 200, height: 160 });
  });

  test("a corner moves both", () => {
    expect(resize(base, "se", { x: 350, y: 250 })).toEqual({ x: 100, y: 100, width: 250, height: 150 });
    expect(resize(base, "nw", { x: 80, y: 90 })).toEqual({ x: 80, y: 90, width: 220, height: 110 });
  });

  test("and past the opposite edge it turns inside out rather than going negative", () => {
    const flipped = resize(base, "w", { x: 400, y: 0 });
    expect(flipped.width).toBe(100);
    expect(flipped.x).toBe(300);
    const up = resize(base, "n", { x: 0, y: 260 });
    expect(up.height).toBe(60);
    expect(up.y).toBe(200);
  });
});
