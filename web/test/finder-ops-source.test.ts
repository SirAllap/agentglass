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

const ui = await Bun.file(new URL("../src/components/finder/machine/FinderOpsUI.tsx", import.meta.url)).text();
const hook = await Bun.file(new URL("../src/components/finder/machine/useFinderOps.tsx", import.meta.url)).text();

describe("a name is typed in place, as Strata does", () => {
  test("rename and new folder go through the inline editor, never a box", () => {
    expect(code(hook)).not.toContain("NameDialog");
    expect(code(hook)).toContain("startName({ dir: t.dir, was,");
    expect(code(col)).toContain("<InlineName");
  });
  test("a click elsewhere keeps a good name and drops a bad one; Escape always drops", () => {
    const f = code(ui).slice(code(ui).indexOf("export function InlineName("));
    expect(f).toContain("onBlur={() => finish(!problem)}");
    expect(f).toContain('e.key === "Escape"');
    expect(f).toContain("if (done.current) return;");
  });
  test("the icons and list views, which draw no editor, still get one", () => {
    expect(code(hook)).toContain("!env.columnsView");
  });
});

const print = await Bun.file(new URL("../src/lib/finderPrint.ts", import.meta.url)).text();
describe("printing a file", () => {
  test("goes through a blob, because the preview is served sandboxed and a sandboxed frame cannot print", () => {
    expect(code(print)).toContain("URL.createObjectURL(blob)");
    expect(code(print)).toContain("f.src = href;");
    expect(code(print)).not.toContain("f.src = url");
  });
});

describe("properties in the empty space", () => {
  test("describe the folder itself instead of saying nothing is chosen", () => {
    const f = code(hook).slice(code(hook).indexOf('case "props": {'));
    expect(f.slice(0, 400)).toContain("if (!c || !c.rows.length)");
  });
});

describe("a box laid over the finder", () => {
  test("closes on Escape wherever the focus is", () => {
    const f = code(ui).slice(code(ui).indexOf("export function Sheet("), code(ui).indexOf("export interface InlineEdit"));
    expect(f).toContain('window.addEventListener("keydown", on, true)');
    expect(f).toContain('e.key === "Escape"');
  });
});

describe("the tabs sit where Strata's do", () => {
  test("the strip is drawn above the toolbar that holds the path row", () => {
    const m = code(fm);
    expect(m.indexOf("<FinderTabs")).toBeGreaterThan(0);
    expect(m.indexOf("<FinderTabs")).toBeLessThan(m.indexOf("<FinderPathBar"));
    expect(m.indexOf("<FinderTabs")).toBeLessThan(m.indexOf('aria-label="New tab"'));
  });
});

describe("the context menu stays inside the window", () => {
  test("it is placed again when its size changes, not only when it opens", () => {
    const f = code(ui).slice(code(ui).indexOf("export function ContextMenu("), code(ui).indexOf("export function Sheet("));
    expect(f).toContain("new ResizeObserver(place)");
    expect(f).toContain("window.innerHeight - h - 8");
  });
});

describe("a box on a narrow window", () => {
  test("its column may shrink below the box's own width, so the box never runs off the right", () => {
    const f = code(ui).slice(code(ui).indexOf("export function Sheet("), code(ui).indexOf("export interface InlineEdit"));
    expect(f).toContain('gridTemplateColumns: "minmax(0, 1fr)"');
  });
});
