import { describe, expect, test } from "bun:test";
import { bandRows, dragStarts, edgeStep, emptyClickSelectsFirst, fileUris, inTrash, releaseActivates, startsMarqueeAt, tipMoved } from "../src/lib/finderPointer.ts";
import { PEEK } from "../src/lib/finderPeek.ts";

const src = (f: string) => Bun.file(new URL(`../src/components/finder/machine/${f}`, import.meta.url)).text();
const machine = await src("MachineFinder.tsx");
const column = await src("Column.tsx");
const views = await src("FolderViews.tsx");
const peek = await src("FolderPeek.tsx");
const tabs = await src("FinderTabs.tsx");
const ops = await src("FinderOpsUI.tsx");
const bar = await src("PreviewBar.tsx");

describe("a press on a row: drag or rubber band", () => {
  test("a selected row drags from anywhere, an unselected one from its icon or name only", () => {
    expect(dragStarts(true, false)).toBe(true);
    expect(dragStarts(false, true)).toBe(true);
    expect(dragStarts(false, false)).toBe(false);
  });
  test("the blank of an unselected row, empty space, and Alt on anything start a band; the primary button only", () => {
    expect(startsMarqueeAt(0, null, false)).toBe(true);
    expect(startsMarqueeAt(0, { selected: false, onContent: false }, false)).toBe(true);
    expect(startsMarqueeAt(0, { selected: false, onContent: true }, false)).toBe(false);
    expect(startsMarqueeAt(0, { selected: true, onContent: false }, false)).toBe(false);
    expect(startsMarqueeAt(0, { selected: true, onContent: true }, true)).toBe(true);
    expect(startsMarqueeAt(2, null, false)).toBe(false);
  });
  test("the press that starts a band stops the row's native drag; Columns, Icons and List mark their icon and their name", () => {
    expect(machine).toMatch(/if \(rowEl \|\| t\.closest\("header"\)\) \{ e\.preventDefault\(\);/);
    expect(column).toContain("<span data-icon");
    expect(views.match(/<span data-icon/g)?.length).toBe(2);
    expect(views).toContain("<span data-name");
    expect(column).toContain('<span data-name className="min-w-0 truncate">{name}</span><span className="flex-1" />');
  });
  test("a drag offers a uri-list of file:// links, from a row or from the preview's header", () => {
    expect(fileUris(["/home/ann/a b.txt", "/srv/x#1"])).toBe("file:///home/ann/a%20b.txt\r\nfile:///srv/x%231");
    expect(machine).toContain('e.dataTransfer.setData("text/uri-list", fileUris(paths))');
    expect(machine).toContain("[data-preview-drag]");
    expect(bar).toMatch(/data-preview-drag=\{dragPath\} draggable=\{dragPath \? true : undefined\}/);
  });
});

describe("the rubber band scrolls the list and counts rows that are not drawn", () => {
  test("the step is zero in the middle, 24 px at most, faster the further past the line", () => {
    expect(edgeStep(300, 100, 500)).toBe(0);
    expect(edgeStep(110, 100, 500)).toBeLessThan(0);
    expect(edgeStep(490, 100, 500)).toBeGreaterThan(0);
    expect(edgeStep(480, 100, 500)).toBeLessThan(edgeStep(495, 100, 500));
    expect(edgeStep(-400, 100, 500)).toBe(-24);
    expect(edgeStep(900, 100, 500)).toBe(24);
  });
  test("a list stacks rows rowH apart, group headers taking slots", () => {
    expect(bandRows({ rowH: 20 }, 100, { left: 0, right: 50, top: 35, bottom: 65 })).toEqual([1, 2, 3]);
    expect(bandRows({ rowH: 20, slotOf: [1, 2, 3, 4] }, 4, { left: 0, right: 50, top: 0, bottom: 15 })).toEqual([]);
    expect(bandRows({ rowH: 20 }, 100_000, { left: 0, right: 50, top: 1_000_000, bottom: 1_000_030 })).toEqual([50_000, 50_001]);
  });
  test("tiles sit per to a line, tileW wide from padX", () => {
    const l = { rowH: 100, hitH: 96, per: 3, tileW: 120, padX: 8 };
    expect(bandRows(l, 9, { left: 0, right: 20, top: 10, bottom: 20 })).toEqual([0]);
    expect(bandRows(l, 9, { left: 130, right: 140, top: 110, bottom: 120 })).toEqual([4]);
    expect(bandRows(l, 9, { left: 0, right: 500, top: 98, bottom: 99 })).toEqual([]);
  });
  test("it is driven by a timer and the layout, not by the DOM rows", () => {
    expect(machine).toContain("bandRows(lay, rows.length, box)");
    expect(machine).toContain("edgeStep(py, r.top, r.bottom)");
    expect(machine).not.toContain("touches(");
  });
});

describe("empty space and the strip", () => {
  test("coming back to a column puts the cursor on its first row, unless a filter narrows it", () => {
    expect(emptyClickSelectsFirst(true, false)).toBe(true);
    expect(emptyClickSelectsFirst(true, true)).toBe(false);
    expect(emptyClickSelectsFirst(false, false)).toBe(false);
  });
  test("the keyboard's column is read before the press moves it; the strip after the last column and a column's header start a band", () => {
    expect(machine).toContain("pressFocus.current = focusCol;");
    expect(machine).toContain("pressFocus.current !== col");
    expect(machine).toContain('data-strip className="agx-scroll');
    expect(machine).toMatch(/if \(t\.closest\("input, button, \[role=\\"separator\\"\]"\)\) return;\n\s*const dirEl = dirOf\(t\)/);
  });
  test("a list's headings have no menu", () => {
    expect(machine).toContain('t.closest("header, input, [data-heading], [role=\\"separator\\"]")');
    expect(views.match(/data-heading/g)?.length).toBe(2);
  });
});

describe("a filter turns a click into an activation", () => {
  test("folders navigate, files open, the Trash only opens folders, a modifier still selects", () => {
    expect(releaseActivates({ filtered: true, isDir: true, trash: false, mods: false })).toBe(true);
    expect(releaseActivates({ filtered: true, isDir: false, trash: false, mods: false })).toBe(true);
    expect(releaseActivates({ filtered: true, isDir: false, trash: true, mods: false })).toBe(false);
    expect(releaseActivates({ filtered: true, isDir: true, trash: true, mods: false })).toBe(true);
    expect(releaseActivates({ filtered: false, isDir: true, trash: false, mods: false })).toBe(false);
    expect(releaseActivates({ filtered: true, isDir: true, trash: false, mods: true })).toBe(false);
    expect(inTrash("/home/ann/.local/share/Trash/files")).toBe(true);
    expect(inTrash("/home/ann/docs")).toBe(false);
  });
  test("the views hand the filter to the row", () => {
    expect(column).toContain('filtered: filter !== ""');
    expect(machine.match(/filtered=\{\(filters\[lastCol\.path\] \?\? ""\) !== ""\}/g)?.length).toBe(2);
  });
});

describe("hovering", () => {
  test("a peek closes after 80 ms and opens only after the pointer was the last thing that moved the person", () => {
    expect(PEEK.close).toBe(80);
    expect(peek).toContain("if (!byPointer() ||");
    expect(machine).toContain("() => pointerNav.current");
    expect(machine).toMatch(/pointerNav\.current = false;\n\s*cancelSlowRef\.current\(\)/);
    expect(machine).toContain("pointerNav.current = true; pressFocus.current = focusCol;");
  });
  test("a caption tooltip needs a rest beyond 4 px of slop, and only a cut caption", () => {
    expect(tipMoved({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(false);
    expect(tipMoved({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(true);
    expect(views).toContain("el.scrollHeight <= el.clientHeight + 1");
    expect(views).toContain("TIP_REST_MS");
  });
  test("only the picture and the name of a tile light up", () => {
    expect(views.match(/agx-tile-part/g)?.length).toBe(2);
  });
  test("a tab has no native tooltip", () => {
    expect(tabs).not.toMatch(/role="tab"[^\n]*title=/);
  });
});

describe("one right click while a menu is open", () => {
  test("the backdrop closes the menu and hands the click to what is under it", () => {
    expect(ops).toContain("onContextMenu={(e) => { e.preventDefault(); onClose(); retarget(e.clientX, e.clientY); }}");
    expect(ops).toContain('new MouseEvent("contextmenu"');
  });
});
