/*
 * Source rules for the operations' wiring: a right click finds its row and its
 * folder through two attributes, so every view that draws a row has to carry
 * them, and the one place that decides what a key does must hand the file keys
 * to the operations before anything else.
 */
import { describe, expect, test } from "bun:test";

const col = await Bun.file(new URL("../src/components/finder/machine/Column.tsx", import.meta.url)).text();
const views = await Bun.file(new URL("../src/components/finder/machine/FolderViews.tsx", import.meta.url)).text();
const fm = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

describe("a right click can find what it landed on", () => {
  test("the three views mark every row with its name", () => {
    expect(code(col)).toContain("data-row={r.name}");
    expect((code(views).match(/data-row=\{r\.name\}/g) ?? []).length).toBe(2);
  });
  test("the columns and the single-folder views mark their folder", () => {
    expect(code(col)).toContain("data-dir={folderPath}");
    expect(code(fm)).toContain("data-dir={lastCol.path}");
  });
  test("the browser area listens for the right click, and ignores its own headers and inputs", () => {
    expect(code(fm)).toContain("onContextMenu={onContext}");
    const f = code(fm).slice(code(fm).indexOf("const onContext ="));
    expect(f.slice(0, f.indexOf("\n  };"))).toContain('t.closest("header, input');
  });
});

describe("the keys", () => {
  test("a file operation key is handed to the operations before the navigation switch", () => {
    const a = code(fm).slice(code(fm).indexOf("const act = useCallback("));
    expect(a.indexOf("if (ops.key(a.t)) return;")).toBeGreaterThan(0);
    expect(a.indexOf("if (ops.key(a.t)) return;")).toBeLessThan(a.indexOf("switch (a.t)"));
  });
  test("while a menu or a question is open the window handler leaves the keys alone", () => {
    expect(code(fm)).toContain("searchingRef.current || opsOpen.current");
  });
});
