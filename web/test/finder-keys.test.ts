import { describe, expect, test } from "bun:test";
import { finderKey, type KeyIn } from "../src/lib/finderKeys.ts";
import { keyStep } from "../src/lib/finderMiller.ts";

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


describe("the keys Strata has that the finder now answers", () => {
  const key = (k: string, o: { ctrl?: boolean } = {}) => finderKey({ key: k, ctrl: !!o.ctrl, meta: false, shift: false, alt: false }, { inField: false, hasSelection: false });
  test("F5 refreshes, Ctrl+F filters, Ctrl+. is Ctrl+H", () => {
    expect(key("F5")).toEqual({ t: "refresh" });
    expect(key("f", { ctrl: true })).toEqual({ t: "filter" });
    expect(key(".", { ctrl: true })).toEqual({ t: "hidden" });
  });
  test("Ctrl+1, 2, 3 switch the view", () => {
    expect(key("1", { ctrl: true })).toEqual({ t: "view", view: "columns" });
    expect(key("2", { ctrl: true })).toEqual({ t: "view", view: "icons" });
    expect(key("3", { ctrl: true })).toEqual({ t: "view", view: "list" });
  });
  test("Ctrl+Up and Ctrl+Down are first and last, and the page keys move", () => {
    expect(key("ArrowUp", { ctrl: true })).toEqual({ t: "move", key: "Home" });
    expect(key("ArrowDown", { ctrl: true })).toEqual({ t: "move", key: "End" });
    expect(key("PageDown")).toEqual({ t: "move", key: "PageDown" });
  });
  test("a page is as many rows as asked, kept inside the column", () => {
    const cols = [{ rows: 30, sel: 0, dirs: [] }];
    expect(keyStep({ col: 0, row: 2 }, "PageDown", cols, 10).row).toBe(12);
    expect(keyStep({ col: 0, row: 25 }, "PageDown", cols, 10).row).toBe(29);
    expect(keyStep({ col: 0, row: 4 }, "PageUp", cols, 10).row).toBe(0);
  });
});
