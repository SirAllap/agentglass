import { describe, expect, test } from "bun:test";
import { clampToWindow } from "../src/lib/menuPlacement.ts";

const src = await Bun.file(new URL("../src/components/StackMarks.tsx", import.meta.url)).text();

/* The stack ladder hung from the chip's left edge at a fixed 480px, so a chip near the window's right edge (detail pane docked right) pushed it off screen. */
describe("the stack ladder stays inside the window", () => {
  test("a ladder that would run past the right edge is shifted back in", () => {
    const at = clampToWindow({ left: 900, top: 100 }, { width: 480, height: 300 }, { width: 1200, height: 800 });
    expect(at.left).toBe(1200 - 480 - 8);
  });
  test("the ladder is placed through clampToWindow, not a fixed left: 0", () => {
    expect(src).toContain("clampToWindow(");
    expect(src).toContain("style={{ left: shift, top: \"100%\" }}");
    expect(src).not.toContain("style={{ left: 0, top: \"100%\" }}");
  });
});
