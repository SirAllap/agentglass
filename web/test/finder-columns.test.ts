/*
 * How wide a column is: the longest name it holds, kept between a floor and a
 * ceiling, with whatever width is free given to the last column so nothing is
 * cut while there is room. Drag and double-click change one column's width.
 */
import { describe, expect, test } from "bun:test";
import { COL_CHROME, COL_MAX, COL_MIN, columnWidth, dragWidth, fillLast, longestNames, previewWidth, splitName } from "../src/lib/finderColumns.ts";

const px = (s: string) => s.length * 7;

describe("the width of one column", () => {
  test("it is as wide as its longest name plus the icon, size and padding", () => {
    expect(columnWidth(["a.txt", "a-rather-long-file-name.txt"], px)).toBe(Math.ceil(px("a-rather-long-file-name.txt")) + COL_CHROME);
  });
  test("a short folder keeps the floor and a huge name stops at the ceiling", () => {
    expect(columnWidth(["a"], px)).toBe(COL_MIN);
    expect(columnWidth(["x".repeat(500)], px)).toBe(COL_MAX);
    expect(columnWidth([], px)).toBe(COL_MIN);
  });
  test("ten similar long names stay distinguishable: the width follows the longest, not a fixed 210", () => {
    const names = Array.from({ length: 10 }, (_, i) => `agentglass-feature-branch-${i}-worktree`);
    expect(columnWidth(names, px)).toBeGreaterThan(260);
  });
  test("only the longest few are measured, so 100,000 names cost 100,000 length checks and 16 measurements", () => {
    let measured = 0;
    const names = Array.from({ length: 100_000 }, (_, i) => `f${i}`);
    names.push("the-one-long-name-that-decides.txt");
    const w = columnWidth(names, (s) => { measured++; return px(s); });
    expect(measured).toBeLessThanOrEqual(16);
    expect(w).toBe(Math.ceil(px("the-one-long-name-that-decides.txt")) + COL_CHROME);
    expect(longestNames(names)[0]).toBe("the-one-long-name-that-decides.txt");
  });
});

describe("a dragged width", () => {
  test("follows the pointer, within a floor and a ceiling wider than the automatic ones", () => {
    expect(dragWidth(300, 40)).toBe(340);
    expect(dragWidth(300, -500)).toBe(120);
    expect(dragWidth(300, 5000)).toBe(800);
  });
  test("a column with a dragged width ignores the names", () => {
    expect(columnWidth(["x".repeat(500)], px, 250)).toBe(250);
    expect(columnWidth(["a"], px, 900)).toBe(800);
  });
});

describe("free width", () => {
  test("goes to the last column, so it fills before anything is cut", () => {
    expect(fillLast([200, 300], 900)).toEqual([200, 700]);
  });
  test("when the columns are already wider than the room, nothing is taken away", () => {
    expect(fillLast([400, 500], 600)).toEqual([400, 500]);
    expect(fillLast([], 600)).toEqual([]);
  });
});

describe("the column edge", () => {
  test("is a keyboard-reachable separator that drags and refits on double-click", async () => {
    const t = await Bun.file(new URL("../src/components/finder/machine/Column.tsx", import.meta.url)).text();
    expect(t).toContain('role="separator"');
    expect(t).toContain("onDoubleClick={onFit}");
    expect(t).toContain("setPointerCapture");
    expect(t).toContain("dragWidth(");
    expect(t).not.toMatch(/width: 232/);
  });
  test("every row keeps its full name on hover", async () => {
    const t = await Bun.file(new URL("../src/components/finder/machine/Column.tsx", import.meta.url)).text();
    expect(t).toContain("title={r.why ?? r.name}");
  });
});

describe("the edge stays inside its column", () => {
  test("a grip hanging past the column makes the row scroll sideways for nothing", async () => {
    const t = await Bun.file(new URL("../src/components/finder/machine/Column.tsx", import.meta.url)).text();
    expect(t).toMatch(/right: 0, width: 6, cursor: "col-resize"/);
    expect(t).not.toMatch(/right: -\d+/);
  });
});

describe("a name cut in the middle", () => {
  test("a short name is whole", () => {
    expect(splitName("notes.md")).toEqual(["notes.md", ""]);
  });
  test("the end stays, so two versions of one name stay different rows", () => {
    const [h1, t1] = splitName("agentglass-finder-notes-v2.json");
    const [h2, t2] = splitName("agentglass-finder-notes-v3.json");
    expect(h1 + t1).toBe("agentglass-finder-notes-v2.json");
    expect(t1).not.toBe(t2);
    expect(t1.endsWith(".json")).toBe(true);
  });
  test("without a short extension the last eight characters stay", () => {
    expect(splitName("a-very-long-folder-name-without-dots")).toEqual(["a-very-long-folder-name-with", "out-dots"]);
  });
});

describe("the preview panel's width", () => {
  test("a third of the finder between 300 and 460 until it is dragged", () => {
    expect(previewWidth(1000)).toBe(360);
    expect(previewWidth(600)).toBe(300);
    expect(previewWidth(3000)).toBe(460);
  });
  test("dragged, it keeps 240 px at least and leaves the columns 320", () => {
    expect(previewWidth(1200, 100)).toBe(240);
    expect(previewWidth(1200, 700)).toBe(700);
    expect(previewWidth(1200, 1100)).toBe(880);
    expect(previewWidth(400, 1100)).toBe(240);
  });
});
