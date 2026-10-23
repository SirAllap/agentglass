import { describe, expect, test } from "bun:test";
import { activates, pointerAction } from "../src/lib/finderPointer.ts";

describe("only the primary button activates", () => {
  test("button 0 on click and mousedown, nothing else", () => {
    expect(activates(0, "click")).toBe(true);
    expect(activates(0, "mousedown")).toBe(true);
    for (const b of [1, 2, 3, 4]) for (const k of ["click", "mousedown", "contextmenu", "auxclick"] as const) expect(activates(b, k)).toBe(false);
    expect(activates(0, "contextmenu")).toBe(false);
    expect(activates(0, "auxclick")).toBe(false);
  });
});

describe("the pointer table, cell by cell", () => {
  test("Columns", () => {
    expect(pointerAction("columns", "folder", 0, 1)).toBe("pick");
    expect(pointerAction("columns", "folder", 0, 2)).toBe("open");
    expect(pointerAction("columns", "folder", 2, 1)).toBe("menu");
    expect(pointerAction("columns", "folder", 1, 1)).toBe("new-tab");
    expect(pointerAction("columns", "file", 0, 1)).toBe("select");
    expect(pointerAction("columns", "file", 0, 2)).toBe("open");
    expect(pointerAction("columns", "file", 2, 1)).toBe("menu");
    expect(pointerAction("columns", "file", 1, 1)).toBe("none");
  });
  for (const view of ["icons", "list"] as const) test(view, () => {
    expect(pointerAction(view, "folder", 0, 1)).toBe("select");
    expect(pointerAction(view, "folder", 0, 2)).toBe("open");
    expect(pointerAction(view, "folder", 2, 1)).toBe("menu");
    expect(pointerAction(view, "folder", 1, 1)).toBe("new-tab");
    expect(pointerAction(view, "file", 0, 1)).toBe("select");
    expect(pointerAction(view, "file", 0, 2)).toBe("open");
    expect(pointerAction(view, "file", 2, 1)).toBe("menu");
  });
  test("a sidebar place", () => {
    expect(pointerAction("sidebar", "place", 0, 1)).toBe("go");
    expect(pointerAction("sidebar", "place", 2, 1)).toBe("menu");
    expect(pointerAction("sidebar", "place", 1, 1)).toBe("none");
  });
  test("no button other than the primary ever opens, enters or goes", () => {
    for (const view of ["columns", "icons", "list", "sidebar"] as const) for (const item of ["folder", "file", "place"] as const) for (const b of [1, 2, 3, 4]) for (const c of [1, 2])
      expect(["open", "go", "pick", "select"]).not.toContain(pointerAction(view, item, b, c));
  });
});

const M = "../src/components/finder/machine/";
const src = async (f: string) => Bun.file(new URL(M + f, import.meta.url)).text();
const [sidebar, column, views, pathbar, tabs, machine] = await Promise.all(["Sidebar.tsx", "Column.tsx", "FolderViews.tsx", "FinderPathBar.tsx", "FinderTabs.tsx", "MachineFinder.tsx"].map(src));
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*")).join("\n");
const handlers = (s: string, re: RegExp) => [...code(s).matchAll(re)].map((m) => m[0]);

describe("every handler that acts asks which button first", () => {
  test("sidebar rows, pins, devices and the device buttons", () => {
    const h = handlers(sidebar!, /onClick=\{\(e\)[^\n]*/g);
    expect(h.length).toBeGreaterThanOrEqual(4);
    for (const x of h) if (!x.includes("MenuItem")) expect(x).toContain("activates(e.button");
    expect(code(sidebar!)).not.toMatch(/onClick=\{\(\) =>(?![^\n]*MenuItem)[^\n]*(onGo|onRemote|onVolume|onRecent)/);
  });
  test("the resize handles ignore every button but the primary", () => {
    expect(code(sidebar!)).toMatch(/onPointerDown=\{\(e\) => \{\s*if \(!activates\(e\.button, "mousedown"\)\) return;/);
    expect(code(column!)).toMatch(/onPointerDown=\{\(e\) => \{\s*if \(!activates\(e\.button, "mousedown"\)\) return;/);
    expect(code(machine!)).toMatch(/onPointerDown=\{\(e\) => \{\s*if \(!activates\(e\.button, "mousedown"\)\) return;/);
  });
  test("Columns, Icons and List rows share one pointer function and no row has a bare onClick", () => {
    expect(code(column!)).toContain('rowPointer("columns"');
    expect(code(views!)).toContain('rowPointer("icons"');
    expect(code(views!)).toContain('rowPointer("list"');
    expect(code(views!)).not.toMatch(/role="option"[^\n]*onClick=/);
    expect(code(column!)).not.toMatch(/data-row=[^\n]*onClick=/);
    const fn = code(column!).slice(code(column!).indexOf("export const rowPointer"));
    expect(fn.slice(0, fn.indexOf("export const noRange"))).toMatch(/onClick:[^\n]*activates\(e\.button, "click"\)[\s\S]*onDoubleClick:[^\n]*activates\(e\.button, "click"\)[\s\S]*onAuxClick:[^\n]*pointerAction/);
  });
  test("path bar crumbs and the bar, and tabs", () => {
    expect(code(pathbar!)).toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); if \(activates\(e\.button, "click"\)\) onGo/);
    expect(code(pathbar!)).toMatch(/onClick=\{\(e\) => \{ if \(activates\(e\.button, "click"\)\) edit\(\)/);
    expect(code(tabs!)).toMatch(/onClick=\{\(e\) => \{ if \(activates\(e\.button, "click"\)\) onSelect/);
  });
  test("a right click selects the row without showing it as a column, and only Columns shows a folder on a pick", () => {
    expect(code(machine!)).toMatch(/pickRaw = useCallback\(\(col: number, row: Row, show = prefs\.view === "columns"\)/);
    expect(code(machine!)).toContain("opensOnPick(row, prefs.mirror && show)");
    expect(code(machine!)).toMatch(/choose: \(dir, name\) =>[^\n]*pickHeld\(col, row, false\)/);
  });
});
