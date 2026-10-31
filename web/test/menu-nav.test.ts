/*
 * Arrow keys in a menu: Up and Down wrap, Home and End go to the ends, nothing focused starts at the right end.
 */
import { describe, expect, test } from "bun:test";
import { isMenuKey, menuIndex } from "../src/lib/menuNav.ts";

describe("menuIndex", () => {
  test("Down and Up wrap", () => {
    expect(menuIndex(0, "ArrowDown", 3)).toBe(1);
    expect(menuIndex(2, "ArrowDown", 3)).toBe(0);
    expect(menuIndex(1, "ArrowUp", 3)).toBe(0);
    expect(menuIndex(0, "ArrowUp", 3)).toBe(2);
  });
  test("nothing focused: Down takes the first row, Up the last", () => {
    expect(menuIndex(-1, "ArrowDown", 4)).toBe(0);
    expect(menuIndex(-1, "ArrowUp", 4)).toBe(3);
  });
  test("Home and End", () => {
    expect(menuIndex(2, "Home", 5)).toBe(0);
    expect(menuIndex(2, "End", 5)).toBe(4);
  });
  test("no rows: -1", () => {
    expect(menuIndex(-1, "ArrowDown", 0)).toBe(-1);
  });
  test("only the four keys are menu keys", () => {
    expect(["ArrowDown", "ArrowUp", "Home", "End"].every(isMenuKey)).toBe(true);
    expect(isMenuKey("Enter")).toBe(false);
    expect(isMenuKey("ArrowLeft")).toBe(false);
  });
});
