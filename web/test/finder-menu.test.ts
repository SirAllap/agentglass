/*
 * A menu row answers the pointer and the keyboard with the same quiet fill:
 * the step between rows is decided in lib/finderMenu.ts, and every menu the
 * finder draws takes its rows through it.
 */
import { describe, expect, test } from "bun:test";
import { MENU_ROW, stepActive } from "../src/lib/finderMenu.ts";

const read = async (p: string) => await Bun.file(new URL(p, import.meta.url)).text();
const popover = await read("../src/components/finder/machine/Popover.tsx");
const ops = await read("../src/components/finder/machine/FinderOpsUI.tsx");
const keys = await read("../src/components/finder/machine/useMenuKeys.ts");
const css = await read("../src/index.css");

describe("stepping between rows", () => {
  test("Down from nothing is the first row, Up from nothing the last", () => {
    expect(stepActive(5, -1, "ArrowDown")).toBe(0);
    expect(stepActive(5, -1, "ArrowUp")).toBe(4);
  });
  test("it wraps at both ends", () => {
    expect(stepActive(3, 2, "ArrowDown")).toBe(0);
    expect(stepActive(3, 0, "ArrowUp")).toBe(2);
    expect(stepActive(3, 1, "ArrowDown")).toBe(2);
  });
  test("Home and End, and an empty menu has no row", () => {
    expect(stepActive(4, 2, "Home")).toBe(0);
    expect(stepActive(4, 0, "End")).toBe(3);
    expect(stepActive(0, -1, "ArrowDown")).toBe(-1);
  });
  test("a stale index (rows fewer than before) starts over rather than pointing off the end", () => {
    expect(stepActive(2, 7, "ArrowDown")).toBe(0);
  });
});

describe("every menu row wears the highlight", () => {
  test("the stylesheet gives a row a fill for the pointer and for the key", () => {
    expect(css).toMatch(new RegExp(`\\.${MENU_ROW}:hover:not\\(:disabled\\)`));
    expect(css).toContain(`.${MENU_ROW}[data-active]`);
  });
  test("the shared item and both of the context menu's lists use the row class", () => {
    expect(popover.match(/className=\{`\$\{MENU_ROW\} /g)?.length).toBe(1);
    expect(ops.match(/className=\{`\$\{MENU_ROW\} /g)?.length).toBe(2);
  });
  test("no menu row is still drawn as a plain button", () => {
    const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code(popover)).not.toMatch(/role="menuitemcheckbox"[^>]*className="agx-btn/);
    expect(code(ops)).not.toMatch(/role="menuitem"[\s\S]{0,400}className="agx-btn w-full/);
  });
  test("every menu takes the arrow keys", () => {
    expect(popover).toContain("useMenuKeys(");
    expect(ops).toContain("useMenuKeys(");
    expect(keys).toContain("stepActive(");
    expect(keys).toContain('"Enter"');
  });
});
