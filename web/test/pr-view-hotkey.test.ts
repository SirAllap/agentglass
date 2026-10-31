import { describe, expect, test } from "bun:test";
import { viewHotkey } from "../src/lib/prFilterView.ts";

// The board's rules changed with nobody touching it: after Alt+Tab the Alt
// keyup never arrives, so a digit typed later read as Alt+digit and applied a
// view (rules, an open deck and an Undo, all from nothing).
const key = (code: string, o: Partial<{ alt: boolean; ctrl: boolean; tag: string; editable: boolean }> = {}) => ({
  altKey: o.alt ?? true, ctrlKey: o.ctrl ?? false, metaKey: false, shiftKey: false, code,
  target: { tagName: o.tag ?? "BODY", isContentEditable: o.editable ?? false } as unknown as EventTarget,
});

describe("viewHotkey", () => {
  test("Alt+1..9 with a real Alt held picks the nth view", () => {
    expect(viewHotkey(key("Digit1"), true)).toBe(0);
    expect(viewHotkey(key("Digit9"), true)).toBe(8);
  });
  test("altKey alone, with no Alt keydown since the window came back, is ignored", () => {
    expect(viewHotkey(key("Digit1"), false)).toBeNull();
  });
  test("nothing from a box being typed in, a terminal's textarea included", () => {
    expect(viewHotkey(key("Digit1", { tag: "TEXTAREA" }), true)).toBeNull();
    expect(viewHotkey(key("Digit1", { tag: "INPUT" }), true)).toBeNull();
    expect(viewHotkey(key("Digit1", { editable: true }), true)).toBeNull();
  });
  test("no Alt, another modifier, or not a digit 1-9: nothing", () => {
    expect(viewHotkey(key("Digit1", { alt: false }), true)).toBeNull();
    expect(viewHotkey(key("Digit1", { ctrl: true }), true)).toBeNull();
    expect(viewHotkey(key("Digit0"), true)).toBeNull();
    expect(viewHotkey(key("KeyA"), true)).toBeNull();
  });
});
