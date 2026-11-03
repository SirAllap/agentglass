/*
 * The Polaris view's keys, and the stage menu they open. Each entry names the
 * handler; the walk fails when the file no longer contains it, so a menu cannot
 * lose its key in silence.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POLARIS_KEYMAP, tabAt } from "../src/lib/polarisKeys.ts";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

describe("the Polaris key map", () => {
  test("every entry's handler is still in its file", () => {
    for (const k of POLARIS_KEYMAP) {
      const text = src(k.file);
      expect({ keys: k.keys, file: k.file, found: text.includes(k.anchor) }).toEqual({ keys: k.keys, file: k.file, found: true });
    }
  });
  test("the menu's keys are all listed", () => {
    const has = (key: string) => POLARIS_KEYMAP.some((k) => k.keys.includes(key));
    for (const key of ["Shift+F10", "ContextMenu", "Alt+1..6", "Home", "Enter", "Esc"]) {
      expect({ key, listed: has(key) }).toEqual({ key, listed: true });
    }
  });
  test("an anchor nobody wrote fails, so the walk is not a no-op", () => {
    expect("a file without it".includes(POLARIS_KEYMAP[0]!.anchor)).toBe(false);
  });
});

describe("tabAt", () => {
  const e = (key: string, over = {}) => ({ key, altKey: true, ctrlKey: false, metaKey: false, ...over });
  test("Alt+1..6 are the six blocks in the bar's order", () => {
    expect(["1", "2", "3", "4", "5", "6"].map((k) => tabAt(e(k)))).toEqual([0, 1, 2, 3, 4, 5]);
  });
  test("other digits and other modifiers are not ours", () => {
    expect(tabAt(e("7"))).toBeNull();
    expect(tabAt(e("0"))).toBeNull();
    expect(tabAt(e("1", { altKey: false }))).toBeNull();
    expect(tabAt(e("1", { ctrlKey: true }))).toBeNull();
    expect(tabAt(e("1", { metaKey: true }))).toBeNull();
  });
});
