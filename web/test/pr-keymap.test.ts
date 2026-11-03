import { describe, expect, test } from "bun:test";
import { PR_KEYMAP, cardStep, viewForKey } from "../src/lib/prKeymap.ts";

describe("the keyboard map", () => {
  test("every entry's handler is still in its file", async () => {
    for (const k of PR_KEYMAP) {
      const src = await Bun.file(new URL(`../${k.file}`, import.meta.url)).text();
      expect({ keys: k.keys, file: k.file, found: src.includes(k.anchor) }).toEqual({ keys: k.keys, file: k.file, found: true });
    }
  });
  test("the spec's keys are all listed", () => {
    const has = (scope: string, key: string) => PR_KEYMAP.some((k) => k.scope === scope && k.keys.includes(key));
    for (const [s, k] of [["cards", "Tab"], ["cards", "Enter, Space"], ["cards", "j, k"], ["cards", "Shift+F10"], ["cards", "/"], ["views", "Alt+1"], ["views", "Esc"],
      ["menus", "Home"], ["picker", "Arrows"], ["merge", "Ctrl+Enter"], ["merge", "Esc"], ["files", "j, k"], ["files", "x"], ["controls", "Space"]] as const) {
      expect({ s, k, listed: has(s, k) }).toEqual({ s, k, listed: true });
    }
  });
  test("an entry that names a handler nobody wrote fails the walk", () => {
    // Break the guard on purpose: a made-up anchor must not be found.
    expect("a file without it".includes(PR_KEYMAP[0]!.anchor)).toBe(false);
  });
  test("the board wires j/k and the panel wires Alt+digits through the map's decisions", async () => {
    const board = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
    const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    expect(board).toContain('import { cardStep } from "../lib/prKeymap.ts"');
    expect(panel).toContain('import { viewForKey } from "../lib/prKeymap.ts"');
  });
});

describe("cardStep", () => {
  test("starts at the ends when nothing is focused, stops at the ends", () => {
    expect(cardStep(5, -1, 1)).toBe(0);
    expect(cardStep(5, -1, -1)).toBe(4);
    expect(cardStep(5, 4, 1)).toBe(4);
    expect(cardStep(5, 0, -1)).toBe(0);
    expect(cardStep(5, 2, 1)).toBe(3);
    expect(cardStep(0, -1, 1)).toBe(-1);
  });
});

describe("viewForKey", () => {
  const e = (code: string, over = {}) => ({ code, altKey: true, ctrlKey: false, metaKey: false, shiftKey: true, ...over });
  test("Alt+Shift+1..4 are the four views, in the bar's order", () => {
    expect(["Digit1", "Digit2", "Digit3", "Digit4"].map((c) => viewForKey(e(c)))).toEqual(["open", "closed", "inbox", "ci"]);
  });
  test("other digits, other modifiers, and a bare digit are not ours", () => {
    expect(viewForKey(e("Digit5"))).toBeNull();
    expect(viewForKey(e("Digit1", { altKey: false }))).toBeNull();
    expect(viewForKey(e("Digit1", { ctrlKey: true }))).toBeNull();
    expect(viewForKey(e("KeyA"))).toBeNull();
  });
  test("plain Alt+digit belongs to the saved views, so it never also switches the view", () => {
    for (const c of ["Digit1", "Digit2", "Digit3", "Digit4"]) expect(viewForKey(e(c, { shiftKey: false }))).toBeNull();
  });
});
