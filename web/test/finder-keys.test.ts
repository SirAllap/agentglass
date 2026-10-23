import { describe, expect, test } from "bun:test";
import { finderKey, type KeyIn } from "../src/lib/finderKeys.ts";

const k = (key: string, o: Partial<KeyIn> = {}): KeyIn => ({ key, ctrl: false, meta: false, shift: false, alt: false, ...o });
const free = { inField: false, hasSelection: false };

describe("which keys the finder takes", () => {
  test("the arrows, Home and End move, Enter opens, Backspace goes up, Space previews", () => {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]) expect(finderKey(k(key), free)).toEqual({ t: "move", key });
    expect(finderKey(k("Enter"), free)).toEqual({ t: "enter" });
    expect(finderKey(k("Backspace"), free)).toEqual({ t: "up" });
    expect(finderKey(k(" "), free)).toEqual({ t: "preview" });
  });
  test("the chords: hidden, sidebar, path, copy — with Ctrl or Cmd, never with Shift or Alt", () => {
    expect(finderKey(k("h", { ctrl: true }), free)).toEqual({ t: "hidden" });
    expect(finderKey(k("B", { meta: true }), free)).toEqual({ t: "sidebar" });
    expect(finderKey(k("l", { ctrl: true }), free)).toEqual({ t: "path" });
    expect(finderKey(k("c", { ctrl: true }), free)).toEqual({ t: "copy" });
    expect(finderKey(k("h", { ctrl: true, shift: true }), free)).toBeNull();
    expect(finderKey(k("ArrowDown", { alt: true }), free)).toBeNull();
  });
  test("Ctrl+C is the browser's when text is selected", () => {
    expect(finderKey(k("c", { ctrl: true }), { inField: false, hasSelection: true })).toBeNull();
  });
  test("a key typed into another field is never taken, but F1 always opens the help", () => {
    const typing = { inField: true, hasSelection: false };
    for (const key of ["ArrowDown", "Enter", "Backspace", " ", "h"]) expect(finderKey(k(key), typing)).toBeNull();
    expect(finderKey(k("l", { ctrl: true }), typing)).toBeNull();
    expect(finderKey(k("F1"), typing)).toEqual({ t: "help" });
  });
  test("letters and Tab are left alone: they are the palette's", () => {
    expect(finderKey(k("a"), free)).toBeNull();
    expect(finderKey(k("Tab"), free)).toBeNull();
    expect(finderKey(k("ArrowDown", { shift: true }), free)).toBeNull();
  });
});
