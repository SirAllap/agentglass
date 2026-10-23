/*
 * Menus, dialogs and focus order of the Finder, as Strata's: a Sheet closes on its backdrop, the prompts that
 * ask for a secret or a verdict close on their buttons only, a name being typed answers an outside press,
 * an open menu swallows Ctrl/Alt chords, and the arrows move focus between the controls of a layer.
 */
import { describe, expect, test } from "bun:test";
import { MENU_EDGE, menuSwallows } from "../src/lib/finderMenu.ts";
import { spatialNext } from "../src/lib/finderSpatial.ts";
import { dropAsks, outsidePress } from "../src/lib/finderOps.ts";

const read = (f: string) => Bun.file(new URL(`../src/components/finder/machine/${f}`, import.meta.url)).text();
const ui = await read("FinderOpsUI.tsx"), vol = await read("VolumeDialogs.tsx"), side = await read("Sidebar.tsx"), mf = await read("MachineFinder.tsx");
const flow = await read("useVolumeFlow.tsx"), cust = await read("FinderCustomize.tsx"), bar = await read("FinderPathBar.tsx");
const fn = (src: string, head: string) => { const at = src.indexOf(head); expect(at).toBeGreaterThan(-1); let d = 0, i = src.indexOf("{", src.indexOf(")", at)); for (let j = i; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && --d === 0) return src.slice(at, j + 1); } return src.slice(at); };

describe("menu keys and edge", () => {
  test("Ctrl, Alt and Super combos are swallowed; a bare modifier is not", () => {
    expect(menuSwallows({ key: "c", ctrlKey: true, altKey: false, metaKey: false })).toBe(true);
    expect(menuSwallows({ key: "ArrowLeft", ctrlKey: false, altKey: true, metaKey: false })).toBe(true);
    expect(menuSwallows({ key: "x", ctrlKey: false, altKey: false, metaKey: true })).toBe(true);
    expect(menuSwallows({ key: "Control", ctrlKey: true, altKey: false, metaKey: false })).toBe(false);
    expect(menuSwallows({ key: "ArrowDown", ctrlKey: false, altKey: false, metaKey: false })).toBe(false);
  });
  test("the context menu clamps 16 px from the window's edge", () => {
    expect(MENU_EDGE).toBe(16);
    const place = fn(ui, "export function ContextMenu(");
    expect(place).toContain("MENU_EDGE");
    expect(place).not.toMatch(/Math\.max\(8,/);
  });
  test("useMenuKeys stops the combo", async () => {
    const k = await read("useMenuKeys.ts");
    expect(k).toMatch(/menuSwallows\(e\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\)/);
  });
});

describe("spatial arrows", () => {
  const row = [{ x: 0, y: 0, w: 60, h: 30 }, { x: 70, y: 0, w: 60, h: 30 }, { x: 140, y: 0, w: 60, h: 30 }];
  test("Left and Right walk a row, and stop at its ends", () => {
    expect(spatialNext(row, 1, "ArrowRight")).toBe(2);
    expect(spatialNext(row, 1, "ArrowLeft")).toBe(0);
    expect(spatialNext(row, 2, "ArrowRight")).toBeNull();
  });
  test("Down takes the control below, not a farther one in the same row", () => {
    const grid = [...row, { x: 0, y: 40, w: 60, h: 30 }, { x: 140, y: 40, w: 60, h: 30 }];
    expect(spatialNext(grid, 0, "ArrowDown")).toBe(3);
    expect(spatialNext(grid, 2, "ArrowDown")).toBe(4);
    expect(spatialNext(grid, 3, "ArrowUp")).toBe(0);
  });
});

describe("dialogs", () => {
  test("a Sheet closes on a press on its backdrop and walks its buttons with the arrows", () => {
    const s = fn(ui, "export function Sheet(");
    expect(s).toContain("e.target === e.currentTarget");
    expect(s).toContain("spatialKey(e)");
  });
  test("the passphrase and connection prompts have no backdrop cancel; the message dialogs keep theirs", () => {
    expect(fn(vol, "export function PassphraseDialog(")).not.toContain("onClick={onCancel} onKeyDown");
    expect(fn(vol, "export function ConnectDialog(")).not.toContain("onClick={onCancel} onKeyDown");
    expect(fn(vol, "export function ErrorDialog(")).toContain("onClick={onClose} onKeyDown");
  });
  test("Customize focuses Done", () => { expect(cust).toMatch(/<button autoFocus [^>]*>Done<\/button>/); });
  test("the delete confirm takes Left/h and Right/l between Cancel and the confirm button", () => {
    const c = fn(ui, "export function ConfirmDialog(");
    expect(c).toContain('"ArrowLeft" || e.key === "h"');
    expect(c).toContain('"ArrowRight" || e.key === "l"');
  });
});

describe("a name being typed", () => {
  test("an outside press submits a rename and drops a new entry", () => {
    expect(outsidePress(true)).toBe("submit");
    expect(outsidePress(false)).toBe("cancel");
  });
  test("it listens at the document for the press and for the wheel, and a blur only keeps a rename", () => {
    const n = fn(ui, "export function InlineName(");
    expect(n).toContain('document.addEventListener("pointerdown"');
    expect(n).toContain('"wheel"');
    expect(n).toContain("onBlur={() => finish(inRow && !problem)}");
  });
});

describe("the sidebar", () => {
  test("the Menu key and Shift+F10 open the row's menu; Shift+Menu and Ctrl+Menu do not", () => {
    expect(side).toContain('e.key === "ContextMenu" ? e.shiftKey');
    expect(side).toContain("e.ctrlKey || e.altKey || e.metaKey");
  });
  test("a mounted device row takes drops, and a keyboard activation says so", () => {
    expect(side).toMatch(/data-side-row data-drop-path=\{!inert && v\.mountPoint/);
    expect(side).toContain("onGo(p.path, e.detail === 0)");
    expect(mf).toContain("keyGoTo");
  });
  test("an unmounted device mounts without navigating", () => {
    const o = fn(flow, "const open = useCallback(");
    expect(o).not.toMatch(/go\(r\.mountPoint\)/);
    expect(o).toContain('work(v, "mount")');
  });
  test("Up from the first row goes to the top bar, whose arrows walk its buttons", () => {
    expect(mf).toContain('e.key === "ArrowUp" && at <= 0');
    expect(mf).toContain("data-finder-topbar");
  });
  test("a cross-volume drop with no modifier asks; a modifier does not", () => {
    const mounts = ["/media/ada/orbit"];
    expect(dropAsks("/home/ada", "/media/ada/orbit/x", false, { mounts })).toBe(true);
    expect(dropAsks("/home/ada", "/media/ada/orbit/x", true, { mounts })).toBe(false);
    expect(dropAsks("/home/ada", "/media/ada/orbit/x", false, { mounts, shift: true })).toBe(false);
    expect(dropAsks("/home/ada", "/home/ada/b", false, { mounts })).toBe(false);
  });
});

describe("the path bar", () => {
  test("the wheel scrolls it sideways", () => { expect(bar).toMatch(/onWheel=\{\(e\) => \{ if \(Math\.abs\(e\.deltaY\) > Math\.abs\(e\.deltaX\)\) e\.currentTarget\.scrollLeft \+= e\.deltaY/); });
});
