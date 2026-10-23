import { describe, expect, test } from "bun:test";
import { backspaceAct, escapeAct, finderKey, finderOwnsChord, leftAct, upFromFirst, type KeyIn } from "../src/lib/finderKeys.ts";
import { gridStep, keyStep } from "../src/lib/finderMiller.ts";

const k = (key: string, o: Partial<KeyIn> = {}): KeyIn => ({ key, ctrl: false, meta: false, shift: false, alt: false, ...o });
const free = { inField: false, hasSelection: false };

describe("which keys the finder takes", () => {
  test("the arrows, Home and End move, Enter opens, Backspace goes up, Space opens a folder or previews, Esc takes one thing away", () => {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]) expect(finderKey(k(key), free)).toEqual({ t: "move", key });
    expect(finderKey(k("Enter"), free)).toEqual({ t: "enter" });
    expect(finderKey(k("Backspace"), free)).toEqual({ t: "up" });
    expect(finderKey(k(" "), free)).toEqual({ t: "space" });
    expect(finderKey(k(" ", { shift: true }), free)).toEqual({ t: "preview" });
    expect(finderKey(k("Escape"), free)).toEqual({ t: "escape" });
  });
  test("the chords: hidden, sidebar, path, copy — with Ctrl or Cmd, never with Shift or Alt", () => {
    expect(finderKey(k("h", { ctrl: true }), free)).toEqual({ t: "hidden" });
    expect(finderKey(k("B", { meta: true }), free)).toEqual({ t: "sidebar" });
    expect(finderKey(k("l", { ctrl: true }), free)).toEqual({ t: "path" });
    expect(finderKey(k("c", { ctrl: true }), free)).toEqual({ t: "copyfiles" });
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
  test("a printable key opens the pane's filter with it typed (Strata's type-to-search); / opens it empty; Tab is left alone", () => {
    expect(finderKey(k("a"), free)).toEqual({ t: "find", ch: "a" });
    expect(finderKey(k("R", { shift: true }), free)).toEqual({ t: "find", ch: "R" });
    expect(finderKey(k("r", { alt: true }), free)).toBeNull();
    expect(finderKey(k("y"), free)).toEqual({ t: "find", ch: "y" });
    expect(finderKey(k("p"), free)).toEqual({ t: "find", ch: "p" });
    expect(finderKey(k("7"), free)).toEqual({ t: "find", ch: "7" });
    expect(finderKey(k("/"), free)).toEqual({ t: "find", ch: "" });
    expect(finderKey(k("Tab"), free)).toBeNull();
  });
  test("the Menu key and Shift+F10 open the selection's menu; Shift+Left and Shift+Right go to the view; Shift on history is ignored; F5 is F5 alone", () => {
    expect(finderKey(k("ContextMenu"), free)).toEqual({ t: "menu" });
    expect(finderKey(k("F10", { shift: true }), free)).toEqual({ t: "menu" });
    expect(finderKey(k("ArrowLeft", { shift: true }), free)).toEqual({ t: "shiftside", by: -1 });
    expect(finderKey(k("ArrowRight", { shift: true }), free)).toEqual({ t: "shiftside", by: 1 });
    expect(finderKey(k("ArrowLeft", { alt: true, shift: true }), free)).toEqual({ t: "back" });
    expect(finderKey(k("ArrowUp", { alt: true, shift: true }), free)).toBeNull();
    expect(finderKey(k("F5"), free)).toEqual({ t: "refresh" });
    expect(finderKey(k("F5", { ctrl: true }), free)).toBeNull();
    expect(finderKey(k("F5", { shift: true }), free)).toBeNull();
  });
  test("tabs by number and moved, and Settings, with Ctrl", () => {
    expect(finderKey(k("!", { ctrl: true, shift: true, code: "Digit1" }), free)).toEqual({ t: "tabnum", i: 0 });
    expect(finderKey(k("=", { ctrl: true, shift: true, code: "Digit0" }), free)).toEqual({ t: "tabnum", i: 9 });
    expect(finderKey(k("PageDown", { ctrl: true, shift: true }), free)).toEqual({ t: "tabmove", by: 1 });
    expect(finderKey(k("PageUp", { ctrl: true, shift: true }), free)).toEqual({ t: "tabmove", by: -1 });
    expect(finderKey(k(",", { ctrl: true }), free)).toEqual({ t: "settings" });
    expect(finderOwnsChord(k("!", { ctrl: true, shift: true, code: "Digit1" }))).toBe(true);
    expect(finderOwnsChord(k(",", { ctrl: true }))).toBe(true);
  });
  test("Up on the first row goes to the open filter, else to the header, else stays", () => {
    expect(upFromFirst({ filterOpen: true, header: true })).toBe("filter");
    expect(upFromFirst({ filterOpen: false, header: true })).toBe("header");
    expect(upFromFirst({ filterOpen: false, header: false })).toBe("stay");
  });
  test("Shift+Home and Shift+End extend to the ends; Shift+Enter opens a folder in a tab", () => {
    expect(finderKey(k("Home", { shift: true }), free)).toEqual({ t: "extend", by: "home" });
    expect(finderKey(k("End", { shift: true }), free)).toEqual({ t: "extend", by: "end" });
    expect(finderKey(k("Enter", { shift: true }), free)).toEqual({ t: "opentab" });
  });
  test("Strata's chords the app also has: the views and the text size are the finder's while it has the keys", () => {
    for (const d of ["1", "2", "3", "=", "+", "-", "0"]) expect(finderOwnsChord(k(d, { ctrl: true }))).toBe(true);
    for (const d of ["4", "k", "\\"]) expect(finderOwnsChord(k(d, { ctrl: true }))).toBe(false);
    expect(finderOwnsChord(k("1", { ctrl: true, shift: true }))).toBe(false);
    expect(finderOwnsChord(k("1"))).toBe(false);
    expect(finderKey(k("=", { ctrl: true }), free)).toEqual({ t: "text", by: 1 });
    expect(finderKey(k("-", { ctrl: true }), free)).toEqual({ t: "text", by: -1 });
    expect(finderKey(k("0", { ctrl: true }), free)).toEqual({ t: "text", by: 0 });
    expect(finderKey(k("B", { ctrl: true, shift: true }), free)).toEqual({ t: "sidefocus" });
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

describe("Esc, Left and Backspace, as Strata's", () => {
  test("Esc takes away only what a reopening would not restore: the preview page, a multi-selection; everything else closes the finder", () => {
    expect(escapeAct({ previewPage: true, multi: true })).toBe("preview-page");
    expect(escapeAct({ previewPage: false, multi: true })).toBe("multi");
    expect(escapeAct({ previewPage: false, multi: false })).toBe("none");
  });
  test("Left goes to the parent column, from the first column or List to the sidebar, and stays when the sidebar is hidden", () => {
    expect(leftAct({ view: "columns", col: 2, atLineStart: true, sidebar: true })).toBe("column");
    expect(leftAct({ view: "columns", col: 0, atLineStart: true, sidebar: true })).toBe("sidebar");
    expect(leftAct({ view: "columns", col: 0, atLineStart: true, sidebar: false })).toBe("stay");
    expect(leftAct({ view: "list", col: 0, atLineStart: true, sidebar: true })).toBe("sidebar");
    expect(leftAct({ view: "list", col: 0, atLineStart: true, sidebar: false })).toBe("stay");
    expect(leftAct({ view: "icons", col: 0, atLineStart: false, sidebar: true })).toBe("move");
    expect(leftAct({ view: "icons", col: 0, atLineStart: true, sidebar: true })).toBe("sidebar");
  });
  test("Backspace closes the column it is in below the first; otherwise it is the parent folder", () => {
    expect(backspaceAct("columns", 2)).toBe("close-column");
    expect(backspaceAct("columns", 0)).toBe("parent");
    expect(backspaceAct("icons", 3)).toBe("parent");
    expect(backspaceAct("list", 0)).toBe("parent");
  });
  test("Page Up and Page Down move a screen of lines in Icons and List too", () => {
    expect(gridStep(0, 100, 4, "PageDown", 3)).toBe(12);
    expect(gridStep(50, 100, 4, "PageUp", 3)).toBe(38);
    expect(gridStep(98, 100, 4, "PageDown", 3)).toBe(99);
    expect(gridStep(5, 100, 1, "PageDown", 10)).toBe(15);
  });
});
