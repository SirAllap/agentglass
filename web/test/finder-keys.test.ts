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
    expect(finderKey(k("c", { ctrl: true }), free)).toEqual({ t: "copyfiles" });
    expect(finderKey(k("y"), free)).toEqual({ t: "copy" });
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
    expect(finderKey(k("ArrowLeft", { shift: true }), free)).toBeNull();
    expect(finderKey(k("Home", { shift: true }), free)).toBeNull();
  });
  test("shift+arrows and pages extend the selection; ctrl+A takes all; ctrl+space toggles", () => {
    expect(finderKey(k("ArrowDown", { shift: true }), free)).toEqual({ t: "extend", by: "down" });
    expect(finderKey(k("ArrowUp", { shift: true }), free)).toEqual({ t: "extend", by: "up" });
    expect(finderKey(k("PageDown", { shift: true }), free)).toEqual({ t: "extend", by: "pageDown" });
    expect(finderKey(k("PageUp", { shift: true }), free)).toEqual({ t: "extend", by: "pageUp" });
    expect(finderKey(k("a", { ctrl: true }), free)).toEqual({ t: "all" });
    expect(finderKey(k(" ", { ctrl: true }), free)).toEqual({ t: "toggle" });
  });
  test("in a text field none of them is taken", () => {
    const typing = { inField: true, hasSelection: false };
    expect(finderKey(k("a", { ctrl: true }), typing)).toBeNull();
    expect(finderKey(k("ArrowDown", { shift: true }), typing)).toBeNull();
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

describe("the folder tab keys", () => {
  test("Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Enter", () => {
    expect(finderKey(k("t", { ctrl: true }), free)).toEqual({ t: "newtab" });
    expect(finderKey(k("w", { ctrl: true }), free)).toEqual({ t: "closetab" });
    expect(finderKey(k("Tab", { ctrl: true }), free)).toEqual({ t: "tab", by: 1 });
    expect(finderKey(k("Tab", { ctrl: true, shift: true }), free)).toEqual({ t: "tab", by: -1 });
    expect(finderKey(k("Enter", { ctrl: true }), free)).toEqual({ t: "opentab" });
  });
  test("Ctrl+PageDown and Ctrl+PageUp step the tabs too, as Strata's second pair", () => {
    expect(finderKey(k("PageDown", { ctrl: true }), free)).toEqual({ t: "tab", by: 1 });
    expect(finderKey(k("PageUp", { ctrl: true }), free)).toEqual({ t: "tab", by: -1 });
  });
  test("a text field keeps them, and Alt does not take them", () => {
    expect(finderKey(k("t", { ctrl: true }), { inField: true, hasSelection: false })).toBeNull();
    expect(finderKey(k("t", { ctrl: true, alt: true }), free)).not.toEqual({ t: "newtab" });
  });
});
