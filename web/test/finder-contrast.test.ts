/*
 * Two surfaces, one emphasis: the columns are the darker base and the preview
 * a lighter card; the column with the keyboard has the bright title, the accent
 * selection and the badge, and the columns before it keep a quiet row.
 */
import { describe, expect, test } from "bun:test";
import { COLUMNS_SURFACE, PREVIEW_SURFACE, rowPaint, rowTone, showsBadge, titleColor } from "../src/lib/finderContrast.ts";

const src = async (p: string) => await Bun.file(new URL(p, import.meta.url)).text();
const machine = await src("../src/components/finder/machine/MachineFinder.tsx");
const column = await src("../src/components/finder/machine/Column.tsx");
const body = (s: string, open: string) => { const i = s.indexOf(open); expect(i).toBeGreaterThan(-1); return s.slice(i); };

describe("the decision", () => {
  test("the preview is a different surface from the columns, and both are house tokens", () => {
    expect(COLUMNS_SURFACE).not.toBe(PREVIEW_SURFACE);
    expect(COLUMNS_SURFACE).toBe("var(--bg)");
    expect(PREVIEW_SURFACE).toBe("var(--surface-card)");
  });
  test("a selected row is active in the keyboard column, parent in any other, and an unselected one is nothing", () => {
    expect(rowTone(true, true)).toBe("active");
    expect(rowTone(true, false)).toBe("parent");
    expect(rowTone(false, true)).toBe("none");
    expect(rowTone(false, false)).toBe("none");
  });
  test("only the active selection has the badge", () => {
    expect(showsBadge(true, true)).toBe(true);
    expect(showsBadge(true, false)).toBe(false);
    expect(showsBadge(false, true)).toBe(false);
  });
  test("a parent row has a fill and no ring; the active one has both", () => {
    const parent = rowPaint("parent"), active = rowPaint("active");
    expect(parent.background).toBeDefined();
    expect(parent.boxShadow).toBeUndefined();
    expect(parent.background).not.toContain("--primary");
    expect(active.boxShadow).toBeDefined();
    expect(rowPaint("none").background).toBeUndefined();
  });
  test("an inactive title is grey, not the text colour", () => {
    expect(titleColor(true)).toBe("var(--text)");
    expect(titleColor(false)).toBe("var(--text3)");
  });
});

describe("the screen uses it", () => {
  test("the stage the columns sit in is the columns' surface, so a closed preview leaves one surface", () => {
    const s = body(machine, `<div className="flex-1 min-h-0 flex"`);
    expect(s.slice(0, 220)).toContain("COLUMNS_SURFACE");
  });
  test("the preview's own pane is the card surface", () => {
    expect(body(machine, "{previewInline && (").slice(0, 600)).toContain("PREVIEW_SURFACE");
  });
  test("a column is drawn by the tones: its rows, its badge and its title", () => {
    expect(column).toContain("rowTone(");
    expect(column).toContain("rowPaint(");
    expect(column).toContain("showsBadge(");
    expect(column).toContain("titleColor(");
  });
  test("the badge is asked of showsBadge, never read off the selected name alone", () => {
    const code = column.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(code.match(/selName &&/g)?.length).toBe(1);
    expect(code).toMatch(/selName && showsBadge\(/);
  });
});
