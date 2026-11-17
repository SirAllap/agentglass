import { describe, expect, test } from "bun:test";
import { dialogMaxHeight, isLowWindow } from "../src/lib/gitStrips.ts";

describe("git dialog strip in a small window", () => {
  test("short window is low", () => { expect(isLowWindow(420, 1200)).toBe(true); });
  test("narrow window is low", () => { expect(isLowWindow(900, 420)).toBe(true); });
  test("roomy window is not low", () => { expect(isLowWindow(900, 1200)).toBe(false); });
  test("unmeasured (0) is never low", () => { expect(isLowWindow(0, 0)).toBe(false); });
  test("height alone still works", () => { expect(isLowWindow(559)).toBe(true); expect(isLowWindow(560)).toBe(false); });
  test("dialog height is the window minus 16px each side", () => {
    expect(dialogMaxHeight(420)).toBe(388);
    expect(dialogMaxHeight(10)).toBe(0);
  });
});
