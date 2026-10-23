import { describe, expect, test } from "bun:test";
import { activates, pointerAction, springMs } from "../src/lib/finderPointer.ts";
import { crumbs, hierarchy } from "../src/lib/finderMiller.ts";

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
    expect(pointerAction("columns", "folder", 0, 2)).toBe("focus-child");
    expect(pointerAction("columns", "folder", 2, 1)).toBe("menu");
    expect(pointerAction("columns", "folder", 1, 1)).toBe("new-tab");
    expect(pointerAction("columns", "file", 0, 1)).toBe("select");
    expect(pointerAction("columns", "file", 0, 2)).toBe("open");
    expect(pointerAction("columns", "file", 2, 1)).toBe("menu");
    expect(pointerAction("columns", "file", 1, 1)).toBe("reveal");
  });
  for (const view of ["icons", "list"] as const) test(view, () => {
    expect(pointerAction(view, "folder", 0, 1)).toBe("select");
    expect(pointerAction(view, "folder", 0, 2)).toBe("open");
    expect(pointerAction(view, "folder", 2, 1)).toBe("menu");
    expect(pointerAction(view, "folder", 1, 1)).toBe("new-tab");
    expect(pointerAction(view, "file", 0, 1)).toBe("select");
    expect(pointerAction(view, "file", 0, 2)).toBe("open");
    expect(pointerAction(view, "file", 2, 1)).toBe("menu");
    expect(pointerAction(view, "file", 1, 1)).toBe("reveal");
  });
  for (const view of ["columns", "icons", "list"] as const) test(`${view}: empty space`, () => {
    expect(pointerAction(view, "empty", 0, 1)).toBe("clear");
    expect(pointerAction(view, "empty", 0, 2)).toBe("none");
    expect(pointerAction(view, "empty", 2, 1)).toBe("menu");
    expect(pointerAction(view, "empty", 1, 1)).toBe("none");
  });
  test("the middle button counts one click: a second one opens no second tab", () => {
    expect(pointerAction("columns", "folder", 1, 2)).toBe("none");
    expect(pointerAction("icons", "file", 1, 2)).toBe("none");
  });
  test("the mouse's back and forward buttons are history, wherever they land", () => {
    for (const view of ["columns", "icons", "list", "sidebar"] as const) for (const item of ["folder", "file", "place", "empty"] as const) {
      expect(pointerAction(view, item, 3, 1)).toBe("back");
      expect(pointerAction(view, item, 4, 1)).toBe("forward");
    }
  });
  test("a sidebar place", () => {
    expect(pointerAction("sidebar", "place", 0, 1)).toBe("go");
    expect(pointerAction("sidebar", "place", 2, 1)).toBe("menu");
    expect(pointerAction("sidebar", "place", 1, 1)).toBe("none");
  });
  test("no button other than the primary ever opens, enters or goes", () => {
    for (const view of ["columns", "icons", "list", "sidebar"] as const) for (const item of ["folder", "file", "place", "empty"] as const) for (const b of [1, 2, 3, 4]) for (const c of [1, 2])
      expect(["open", "go", "pick", "select", "clear", "focus-child"]).not.toContain(pointerAction(view, item, b, c));
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
    expect(fn.slice(0, fn.indexOf("export const noRange"))).toMatch(/onClick:[^\n]*activates\(e\.button, "click"\)[\s\S]*onDoubleClick:[\s\S]*?activates\(e\.button, "click"\)[\s\S]*onAuxClick:[\s\S]*?pointerAction/);
  });
  test("path bar crumbs and the bar, and tabs", () => {
    expect(code(pathbar!)).toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); if \(!activates\(e\.button, "click"\)\) return; if \(i === parts\.length - 1\) edit\(\); else onGo/);
    expect(code(pathbar!)).toMatch(/onClick=\{\(e\) => \{ if \(activates\(e\.button, "click"\)\) edit\(\)/);
    expect(code(tabs!)).toMatch(/onClick=\{\(e\) => \{ if \(activates\(e\.button, "click"\)\) onSelect/);
  });
  test("a right click selects the row without showing it as a column, and only Columns shows a folder on a pick", () => {
    expect(code(machine!)).toMatch(/pickRaw = useCallback\(\(col: number, row: Row, show = prefs\.view === "columns"\)/);
    expect(code(machine!)).toContain("opensOnPick(row, prefs.mirror && show)");
    expect(code(machine!)).toMatch(/choose: \(dir, name\) =>[^\n]*pickHeld\(col, row, false\)/);
  });
});

describe("the views act on what the table says", () => {
  test("a double click on a file goes to the desktop's application in every view; the bench opens only from the preview", () => {
    const opens = [...code(machine!).matchAll(/onOpen=\{[^\n]*?\}\}?/g)].map((m) => m[0]);
    expect(opens.length).toBe(3);
    for (const o of opens) { expect(o).toContain("openDefault("); expect(o).not.toContain("onBench("); }
  });
  test("Columns: a second click on a folder moves to its column instead of opening anything", () => {
    const fn = code(column!).slice(code(column!).indexOf("export const rowPointer"));
    expect(fn.slice(0, fn.indexOf("export const noRange"))).toMatch(/a === "focus-child"\) h\.onFocusChild/);
    expect(code(machine!)).toMatch(/onFocusChild=\{\(\) => \{ if \(trail\.length > i \+ 1\) setFocusCol\(i \+ 1\); \}\}/);
  });
  test("the empty space clears through the table, and the back and forward buttons are wired on the whole finder", () => {
    expect(code(machine!)).toMatch(/onContextMenu=\{onContext\} onClick=\{onEmpty\}/);
    expect(code(machine!)).toMatch(/pointerAction\(prefs\.view, "empty", e\.button, e\.detail \|\| 1\) !== "clear"/);
    expect(code(machine!)).toContain("data-machine-finder onAuxClick={onHistoryButton}");
  });
  test("the middle button on a file reveals it, in all three views", () => {
    expect(code(column!)).toContain("onReveal, onFocusChild, onSlow, onSlowCancel })");
    expect(code(views!).match(/onPick, onOpen, onTab, onReveal, onSlow, onSlowCancel \}\)/g)?.length).toBe(2);
  });
});

describe("the chrome around the views", () => {
  test("the path bar's menu is the whole path, the current folder first, up to home as a house or the root as a disk", () => {
    const h = hierarchy(crumbs("/home/ada/orbit/acme", "/home/ada"));
    expect(h.map((x) => x.label)).toEqual(["acme", "orbit", "~"]);
    expect(h.map((x) => x.icon)).toEqual(["folder", "folder", "house"]);
    expect(h.map((x) => x.current)).toEqual([true, false, false]);
    const r = hierarchy(crumbs("/srv/data", "/home/ada"));
    expect(r.map((x) => [x.label, x.icon])).toEqual([["data", "folder"], ["srv", "folder"], ["/", "hard-drive"]]);
  });
  test("the right button anywhere on the path bar opens that menu, and a click in it never reaches the bar", () => {
    expect(code(pathbar!)).toMatch(/onContextMenu=\{\(e\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\); setMenu\(new DOMRect\(e\.clientX, e\.clientY, 1, 1\)\); \}\}/);
    expect(code(pathbar!)).toMatch(/<span onClick=\{\(e\) => e\.stopPropagation\(\)\}[^\n]*>\s*<Popover anchor=\{menu\}[^\n]*label="Path hierarchy"/);
  });
  test("the current folder in the bar is a label, as in Strata: a click on it types the path", () => {
    expect(code(pathbar!)).toContain("if (i === parts.length - 1) edit(); else onGo(c.path);");
  });
  test("the browser's own menu never shows over the finder, except in a text field", () => {
    expect(code(machine!)).toContain("data-machine-finder onAuxClick={onHistoryButton} onContextMenu={noNativeMenu}");
    expect(code(machine!)).toMatch(/const noNativeMenu = \(e: React\.MouseEvent\) => \{ if \(!\(e\.target as HTMLElement\)\.closest\("input, textarea, \[contenteditable=\\"true\\"\]"\)\) e\.preventDefault\(\); \};/);
  });
});

describe("dragging files, as Strata's", () => {
  test("a drag resting on a folder, a place or a crumb opens it after 750 ms, on a tab after 450 ms; a pane and the Trash never", () => {
    expect(springMs("folder")).toBe(750);
    expect(springMs("place")).toBe(750);
    expect(springMs("crumb")).toBe(750);
    expect(springMs("tab")).toBe(450);
    expect(springMs("pane")).toBeNull();
    expect(springMs("trash")).toBeNull();
  });
  test("the finder takes drags on its whole window, so the path's crumbs and the tabs are targets too", () => {
    expect(code(machine!)).toContain("onContextMenu={noNativeMenu} {...dnd}");
    expect(code(machine!)).not.toMatch(/onClick=\{onEmpty\} \{\.\.\.dnd\}/);
    expect(code(pathbar!)).toContain('data-drop-path={i < parts.length - 1 ? c.path : undefined} data-drop-kind="crumb"');
    expect(code(tabs!)).toContain('data-drop-path={p} data-drop-kind="tab"');
    expect(code(machine!)).toMatch(/const ms = springMs\(d\.kind\); if \(ms !== null\) spring\.current = \{ el: d\.el, t: setTimeout/);
  });
  test("the middle button closes a tab when it is let go, not when it is pressed", () => {
    expect(code(tabs!)).toMatch(/onAuxClick=\{\(e\) => \{ if \(e\.button === 1\) \{ e\.preventDefault\(\); onClose\(i\); \} \}\}/);
  });
});
