/*
 * Ctrl and Shift click, Shift+arrows and Ctrl+A choose several rows of one
 * column. The cursor row is the one the preview follows; the set is what the
 * footer counts. A set is by NAME, like the single selection, because rows
 * arrive in pages and are re-sorted.
 */
import { describe, expect, test } from "bun:test";
import { clickSelect, extendBy, extendSelect, selectAll, selectedFooter, single, toggleCursor, type Choice } from "../src/lib/finderSelect.ts";
import type { Row } from "../src/lib/finderMiller.ts";

const row = (name: string, kind: Row["kind"] = "file", bytes: number | null = 10): Row => ({ name, kind, bytes, items: kind === "dir" ? 0 : null, mtime: 0, hidden: false });
const rows = ["a", "b", "c", "d", "e"].map((n) => row(n));
const names = (c: Choice) => [...c.names].sort();

describe("click", () => {
  test("a plain click is one row and the anchor", () => {
    expect(clickSelect(rows, single("a"), "c", { ctrl: false, shift: false })).toEqual({ names: new Set(["c"]), anchor: "c", cursor: "c" });
  });
  test("ctrl toggles a row in and out", () => {
    const one = clickSelect(rows, single("a"), "c", { ctrl: true, shift: false });
    expect(names(one)).toEqual(["a", "c"]);
    expect(one.cursor).toBe("c");
    const off = clickSelect(rows, one, "a", { ctrl: true, shift: false });
    expect(names(off)).toEqual(["c"]);
  });
  test("shift takes the range from the anchor, either way, and keeps the anchor", () => {
    const r = clickSelect(rows, single("b"), "d", { ctrl: false, shift: true });
    expect(names(r)).toEqual(["b", "c", "d"]);
    expect(r.anchor).toBe("b");
    expect(names(clickSelect(rows, single("d"), "b", { ctrl: false, shift: true }))).toEqual(["b", "c", "d"]);
  });
  test("shift with no anchor is a plain click", () => {
    expect(names(clickSelect(rows, { names: new Set(), anchor: null, cursor: null }, "c", { ctrl: false, shift: true }))).toEqual(["c"]);
  });
  test("ctrl+shift adds the range to what is already chosen", () => {
    const base = clickSelect(rows, single("a"), "b", { ctrl: true, shift: false }); // a, b — anchor b
    expect(names(clickSelect(rows, base, "d", { ctrl: true, shift: true }))).toEqual(["a", "b", "c", "d"]);
  });
});

describe("keys", () => {
  test("shift+arrow grows from the anchor, and back down shrinks", () => {
    let c = single("b");
    c = extendSelect(rows, c, 1); expect(names(c)).toEqual(["b", "c"]);
    c = extendSelect(rows, c, 1); expect(names(c)).toEqual(["b", "c", "d"]);
    c = extendSelect(rows, c, -1); expect(names(c)).toEqual(["b", "c"]);
    c = extendSelect(rows, c, -1); c = extendSelect(rows, c, -1); expect(names(c)).toEqual(["a", "b"]);
    expect(c.anchor).toBe("b");
  });
  test("a page step moves the cursor by that many and stops at the ends", () => {
    expect(names(extendSelect(rows, single("a"), 3))).toEqual(["a", "b", "c", "d"]);
    expect(names(extendSelect(rows, single("d"), 50))).toEqual(["d", "e"]);
  });
  test("ctrl+space toggles the cursor row", () => {
    const c = toggleCursor(rows, clickSelect(rows, single("a"), "c", { ctrl: true, shift: false }));
    expect(names(c)).toEqual(["a"]);
  });
  test("ctrl+a takes every row shown and leaves the anchor and the cursor on the last, as Strata does", () => {
    const c = selectAll(rows, single("c"));
    expect(c.names.size).toBe(5);
    expect(c.anchor).toBe("e");
    expect(c.cursor).toBe("e");
  });
  test("an empty column selects nothing", () => { expect(selectAll([], single(null)).names.size).toBe(0); });
  test("a name that left the folder is dropped from the set", () => {
    const c = clickSelect(rows, single("a"), "c", { ctrl: true, shift: false });
    expect(names(clickSelect(rows.filter((r) => r.name !== "a"), c, "e", { ctrl: true, shift: false }))).toEqual(["c", "e"]);
  });
});

describe("step", () => {
  test("up is negative, a page is a page, a tile line is the tiles in it", () => {
    expect(extendBy("down", 12, 1)).toBe(1);
    expect(extendBy("up", 12, 6)).toBe(-6);
    expect(extendBy("pageDown", 12, 6)).toBe(12);
    expect(extendBy("pageUp", 0, 1)).toBe(-1);
  });
});

describe("footer", () => {
  const mixed = [row("src", "dir", null), row("lib", "dir", null), row("a.ts", "file", 1500), row("b.ts", "file", 2500), row("c.ts", "file", null)];
  const all = selectAll(mixed, single("src"));
  test("folders and files are counted apart", () => { expect(selectedFooter(mixed, all)).toBe("2 folders, 3 files selected (4 kB known; size incomplete)"); });
  test("one kind says one kind", () => {
    expect(selectedFooter(mixed, { names: new Set(["a.ts", "b.ts"]), anchor: "a.ts", cursor: "b.ts" })).toBe("2 files selected (4 kB)");
    expect(selectedFooter(mixed, { names: new Set(["src", "lib"]), anchor: "src", cursor: "lib" })).toBe("2 folders selected");
  });
  test("past 64 it stops listing details", () => {
    const big = Array.from({ length: 70 }, (_, i) => row(`f${i}`));
    expect(selectedFooter(big, selectAll(big, single("f0")))).toBe("70 items selected");
  });
});

// A rule about source, asserted against source: there is no renderer here. Every place that draws a
// choosable row passes the modifier keys on, and stops a Shift-click selecting the text in between.
describe("the rows hand their modifier keys on", () => {
  const files = ["Column.tsx", "FolderViews.tsx"];
  const src = Promise.all(files.map((f) => Bun.file(new URL(`../src/components/finder/machine/${f}`, import.meta.url)).text()));
  test("every row's click reports ctrl and shift, and mousedown keeps the text unselected", async () => {
    const [col, views] = await src;
    expect((col!.match(/rowPointer\("columns"/g) ?? []).length).toBe(1);
    expect((views!.match(/rowPointer\("(icons|list)"/g) ?? []).length).toBe(2);
    expect((col!.match(/h\.onPick\(r, modOf\(e\)\)/g) ?? []).length).toBe(1);
    expect((col!.match(/onMouseDown=\{noRange\}/g) ?? []).length).toBe(1);
    expect((views!.match(/onMouseDown=\{noRange\}/g) ?? []).length).toBe(2);
  });
});
