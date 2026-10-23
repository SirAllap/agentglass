/*
 * Key dispatch as Strata's: exact modifiers, the Latin letter of the physical key, Shift+arrows with
 * Ctrl or Alt, Ctrl+Shift+Enter, the filter's hand-through, a preview document's own keys, Esc keeping
 * the cursor and the anchor, Delete in the Trash, and the names of a folder made by the key.
 */
import { describe, expect, test } from "bun:test";
import { deleteAct, finderKey, finderOwnsChord, latin, windowChord, type Ctx, type KeyIn } from "../src/lib/finderKeys.ts";
import { dismissChoice, extendSelect, selectAll, single } from "../src/lib/finderSelect.ts";
import { freeName } from "../src/lib/finderOps.ts";
import type { Row } from "../src/lib/finderMiller.ts";

const k = (key: string, o: Partial<KeyIn> = {}): KeyIn => ({ key, ctrl: false, meta: false, shift: false, alt: false, ...o });
const free: Ctx = { inField: false, hasSelection: false };
const filter: Ctx = { inField: true, inFilter: true, hasSelection: false };
const rows = (...n: string[]): Row[] => n.map((name) => ({ name, kind: "file", bytes: 1 }) as unknown as Row);

describe("exact modifiers, Super included", () => {
  test("Super with anything is no chord outside a Mac; Ctrl+Super is none anywhere", () => {
    expect(finderKey(k("c", { ctrl: true, meta: true }), free)).toBeNull();
    expect(finderKey(k("c", { ctrl: true, meta: true }), { ...free, mac: true })).toBeNull();
    expect(finderKey(k("c", { meta: true }), free)).toBeNull();
    expect(finderKey(k("ArrowDown", { meta: true }), free)).toBeNull();
    expect(finderKey(k("c", { meta: true }), { ...free, mac: true })).toEqual({ t: "copyfiles" });
  });
  test("Ctrl+Shift+Enter opens a tab like Ctrl+Enter, and the finder owns that chord", () => {
    expect(finderKey(k("Enter", { ctrl: true }), free)).toEqual({ t: "opentab" });
    expect(finderKey(k("Enter", { ctrl: true, shift: true }), free)).toEqual({ t: "opentab" });
    expect(finderOwnsChord(k("Enter", { ctrl: true, shift: true }))).toBe(true);
    expect(finderOwnsChord(k("Enter", { ctrl: true, shift: true, alt: true }))).toBe(false);
  });
});

describe("a letter is the Latin letter of its key", () => {
  test("Cyrillic and Greek layouts reach Ctrl+C, Ctrl+Shift+N and Ctrl+Alt+T by the code", () => {
    expect(finderKey(k("с", { ctrl: true, code: "KeyC" }), free)).toEqual({ t: "copyfiles" });
    expect(finderKey(k("Ь", { ctrl: true, shift: true, code: "KeyN" }), free)).toEqual({ t: "newfolder" });
    expect(finderKey(k("е", { ctrl: true, alt: true, code: "KeyT" }), free)).toEqual({ t: "terminal" });
  });
  test("a Latin layout keeps the letter it typed, whatever the code says", () => {
    expect(latin({ key: "c", code: "KeyJ" })).toBe("c");
    expect(latin({ key: "C", code: "KeyJ" })).toBe("c");
    expect(latin({ key: "ArrowUp", code: "ArrowUp" })).toBe("arrowup");
  });
});

describe("Shift+Up and Shift+Down extend, with Ctrl or Alt held too", () => {
  test("every modifier mix reaches the range", () => {
    for (const o of [{}, { ctrl: true }, { alt: true }, { ctrl: true, alt: true }]) {
      expect(finderKey(k("ArrowUp", { shift: true, ...o }), free)).toEqual({ t: "extend", by: "up" });
      expect(finderKey(k("ArrowDown", { shift: true, ...o }), free)).toEqual({ t: "extend", by: "down" });
    }
  });
});

describe("a field hands the finder nothing, except the filter's view keys and rename", () => {
  test("Ctrl+1/2/3 switch the view from the filter, by position on any layout", () => {
    expect(finderKey(k("1", { ctrl: true }), filter)).toEqual({ t: "view", view: "columns" });
    expect(finderKey(k("&", { ctrl: true, code: "Digit2" }), filter)).toEqual({ t: "view", view: "icons" });
    expect(finderKey(k("3", { ctrl: true, code: "Numpad3" }), filter)).toEqual({ t: "view", view: "list" });
    expect(finderKey(k("1", { ctrl: true }), { inField: true, hasSelection: false })).toBeNull();
    expect(finderKey(k("&", { ctrl: true, code: "Digit1" }), free)).toEqual({ t: "view", view: "columns" });
  });
  test("F2 and Ctrl+R rename from the filter; nothing else does", () => {
    expect(finderKey(k("F2"), filter)).toEqual({ t: "rename" });
    expect(finderKey(k("r", { ctrl: true }), filter)).toEqual({ t: "rename" });
    expect(finderKey(k("F2"), { inField: true, hasSelection: false })).toBeNull();
    for (const key of ["Delete", "a", "ArrowDown", "Escape"]) expect(finderKey(k(key), filter)).toBeNull();
    expect(finderKey(k("a", { ctrl: true }), filter)).toBeNull();
    expect(finderKey(k("k", { ctrl: true }), filter)).toBeNull();
  });
});

describe("a preview document keeps its own keys", () => {
  const doc: Ctx = { ...free, inPreview: true };
  test("Ctrl+A/C/X/V and the arrows are left to it; Space, Ctrl+1 and the rest still reach the finder", () => {
    for (const l of ["a", "c", "x", "v"]) { expect(finderKey(k(l, { ctrl: true }), doc)).toBeNull(); expect(finderKey(k(l, { ctrl: true }), free)).not.toBeNull(); }
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "PageDown"]) expect(finderKey(k(key), doc)).toBeNull();
    expect(finderKey(k(" "), doc)).toEqual({ t: "space" });
    expect(finderKey(k("Escape"), doc)).toEqual({ t: "escape" });
    expect(finderKey(k("1", { ctrl: true }), doc)).toEqual({ t: "view", view: "columns" });
  });
});

describe("the window's chords wait while a name is typed or a dialog is up", () => {
  test("F5, Ctrl+K, Ctrl+Shift+K, Ctrl+Alt+T and Ctrl+\\ are the ones swallowed", () => {
    expect(windowChord(k("F5"))).toBe(true);
    expect(windowChord(k("k", { ctrl: true }))).toBe(true);
    expect(windowChord(k("K", { ctrl: true, shift: true }))).toBe(true);
    expect(windowChord(k("t", { ctrl: true, alt: true }))).toBe(true);
    expect(windowChord(k("\\", { ctrl: true }))).toBe(true);
    expect(windowChord(k("т", { ctrl: true, alt: true, code: "KeyT" }))).toBe(true);
    for (const o of [k("c", { ctrl: true }), k("F5", { ctrl: true }), k("Enter"), k("k")]) expect(windowChord(o)).toBe(false);
  });
});

describe("Delete", () => {
  test("goes to the Trash at once, and in the Trash asks to delete for good; Shift always asks", () => {
    expect(deleteAct("/home/u/docs", false)).toBe("trash");
    expect(deleteAct("/home/u/.local/share/Trash/files", false)).toBe("delete");
    expect(deleteAct("/home/u/docs", true)).toBe("delete");
  });
});

describe("Esc on several rows", () => {
  test("keeps the cursor and the anchor, so Shift+Down starts again at the cursor", () => {
    const r = rows("a", "b", "c", "d");
    const all = selectAll(r, single(null));
    expect(all.anchor).toBe("d"); // select-all leaves the anchor on the last row, as Strata's
    const picked = { names: new Set(["b", "c"]), anchor: "b", cursor: "c" };
    const after = dismissChoice(picked);
    expect(after.cursor).toBe("c");
    expect(after.anchor).toBe("b");
    expect([...after.names]).toEqual(["c"]);
    expect([...extendSelect(r, after, 1).names]).toEqual(["b", "c", "d"]);
  });
});

describe("a folder made by the key", () => {
  test("is named new folder, then new folder (1), (2)…", () => {
    expect(freeName("new folder", ["a"])).toBe("new folder");
    expect(freeName("new folder", ["new folder"])).toBe("new folder (1)");
    expect(freeName("new folder", ["new folder", "New Folder (1)"])).toBe("new folder (2)");
  });
});
