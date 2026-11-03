/*
 * A menu placed once and then left behind by the window.
 *
 * Measured: a menu opened at 1440x900 sat at y=250, and after the window shrank
 * to 640x360 its bottom was 79px below the edge (190px at 427x240). Opening it
 * *at* 640 clamped it correctly, so this is the resize, and zooming is the same
 * event. The clamping arithmetic is one function now, and every menu re-runs it
 * when the window changes size instead of trusting the answer it got at open.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MENU_MARGIN, clampToWindow, naturalHeight } from "../src/lib/menuPlacement.ts";

const read = (f: string) => readFileSync(join(import.meta.dir, "..", "src", "components", f), "utf8");

describe("clampToWindow", () => {
  test("a menu whose last rows fall below the window is lifted back inside", () => {
    const at = clampToWindow({ left: 300, top: 250 }, { width: 240, height: 190 }, { width: 640, height: 360 });
    expect(at.top + 190).toBeLessThanOrEqual(360 - MENU_MARGIN);
    expect(at.left).toBe(300);
  });

  test("a window wider than the menu does not move one that already fits", () => {
    const at = clampToWindow({ left: 300, top: 100 }, { width: 240, height: 190 }, { width: 1440, height: 900 });
    expect(at).toEqual({ left: 300, top: 100 });
  });

  test("a menu pinned by its right edge moves back in when the window narrows", () => {
    const at = clampToWindow({ left: 1100, top: 100 }, { width: 378, height: 312 }, { width: 427, height: 240 });
    expect(at.left).toBeGreaterThanOrEqual(MENU_MARGIN);
    expect(at.left + 378).toBeLessThanOrEqual(427 - MENU_MARGIN);
  });

  test("a menu taller than the window keeps its first row reachable", () => {
    expect(clampToWindow({ left: 10, top: 90 }, { width: 200, height: 400 }, { width: 427, height: 240 }).top).toBe(MENU_MARGIN);
  });
});

describe("naturalHeight", () => {
  test("a list a previous placement capped measures its whole content", () => {
    // 190px of client box under a 312px list: the ceiling is inline, the content is not.
    expect(naturalHeight({ scrollHeight: 312, offsetHeight: 192, clientHeight: 190 })).toBe(314);
  });

  test("a list nothing caps measures the box it paints", () => {
    expect(naturalHeight({ scrollHeight: 190, offsetHeight: 192, clientHeight: 190 })).toBe(192);
  });
});

describe("every menu asks again when the window changes size", () => {
  const CONTEXT = read("ContextMenu.tsx");
  const ANCHORED = read("AnchoredMenu.tsx");
  const TOPBAR = read("TopBar.tsx");

  test("the right-click menu clamps through the shared helper, at open and on resize", () => {
    expect(CONTEXT).toContain('import { clampToWindow } from "../lib/menuPlacement.ts";');
    expect(CONTEXT).toContain("clampToWindow(");
    expect(CONTEXT).toContain('window.addEventListener("resize", place)');
  });

  test("an anchored list is placed again rather than dismissed, so a resize does not lose it", () => {
    expect(ANCHORED).toContain('window.addEventListener("resize", place)');
    expect(ANCHORED).not.toContain('window.addEventListener("resize", close)');
    // The natural height, not the cap the last placement left on the element:
    // measured with it, a list that grew reads short and is placed on that number.
    expect(ANCHORED).toContain("height: naturalHeight(el)");
  });

  test("the usage sheet is re-anchored to its chip, because the strip gives cells up as it narrows", () => {
    expect(TOPBAR).toContain('window.addEventListener("resize", place)');
    const sheet = TOPBAR.slice(TOPBAR.indexOf("const planProviderForAnchor"), TOPBAR.indexOf("const openPlan"));
    expect(sheet).toContain("anchorFor(was.provider)");
    expect(sheet).toContain("window.innerWidth - r.right");
  });
});
