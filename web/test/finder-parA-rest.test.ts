/*
 * The remaining parA rows, by surface. Rules about source are asserted against
 * source: there is no renderer in this project.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, readPrefs } from "../src/lib/finderMiller.ts";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const column = await read("components/finder/machine/Column.tsx");
const machine = await read("components/finder/machine/MachineFinder.tsx");
const css = await read("index.css");

describe("columns: row 68, the width a new column opens at is the last one dragged or fitted", () => {
  test("a preference, 300 to 800, 300 by default", () => {
    expect(DEFAULT_PREFS.colW).toBe(300);
    expect(readPrefs(JSON.stringify({ colW: 420.4 })).colW).toBe(420);
    expect(readPrefs(JSON.stringify({ colW: 90 })).colW).toBe(300);
    expect(readPrefs(JSON.stringify({ colW: 9000 })).colW).toBe(800);
    expect(readPrefs(JSON.stringify({ colW: "wide" })).colW).toBe(300);
  });
  test("a drag and a fit remember it, a column without its own width opens at it", () => {
    expect(machine).toContain("columnWidth(dragged[c.path] ?? prefs.colW, columnRoom)");
    expect(machine.match(/setPrefs\(\{ colW: w \}\)/g)?.length).toBe(2);
  });
});

describe("columns: rows 69, 74 and 102, Strata's timings", () => {
  test("a column opened after the finder settled slides in over 220 ms, and one that came back with it does not", () => {
    expect(css).toMatch(/\.agx-col-enter \{ animation: agx-col-enter 220ms/);
    expect(css).toContain("@keyframes agx-col-enter { from { transform: translate(-24px, 0); opacity: 0; }");
    expect(column).toContain("const [entering] = useState(!!enter);");
    expect(machine).toContain("<Column key={c.path} enter={settled}");
  });
  test("an autofit animates the width, a drag does not", () => {
    expect(column).toContain("transition: fitting ?");
    expect(column).toContain("onDoubleClick={fit}");
  });
  test("the spinner waits 120 ms and the skeleton 150, then both go with the load", () => {
    expect(column).toContain("export const SPINNER_DELAY_MS = 120;");
    expect(column).toContain("export const SKELETON_GRACE_MS = 150;");
    expect(column).toContain("loading && spin &&");
    expect(column).toContain("<ColumnSkeleton rowH={rowH} />");
    expect(column).not.toContain('"Reading…"');
  });
  test("eighteen rows of blocks, the widths Strata's skeleton cycles", () => {
    expect(column).toContain("SKELETON_NAMES = [96, 72, 112, 84, 104, 64]");
    expect(column).toContain("Array.from({ length: 18 }");
  });
});

describe("columns: row 93, the cursor is one outlined row, the selection is every filled row", () => {
  test("only the cursor row wears the ring, and it is text-contrast, not the accent", async () => {
    const { rowPaint } = await import("../src/lib/finderContrast.ts");
    expect(rowPaint("active", true).boxShadow).toContain("var(--text)");
    expect(rowPaint("active", false).boxShadow).toBeUndefined();
    expect(rowPaint("active", false).background).toContain("--primary");
    expect(column).toContain("rowPaint(rowTone(sel, focused), r.name === selName)");
  });
});

describe("columns: row 99, a column that opens is scrolled to, the first layout and reduced motion jump", () => {
  test("smooth only after the first placement and not under reduced motion", () => {
    const at = machine.indexOf("function ColumnsRow(");
    const body = machine.slice(at, machine.indexOf("\n}\n", at));
    expect(body).toContain('behavior: "smooth"');
    expect(body).toContain("placed.current &&");
    expect(body).toContain("!reducedMotion()");
  });
});

describe("sidebar: row 51, Strata's surface and its 0.6 alpha edge", () => {
  test("the nav wears them and not the page's nav token", async () => {
    const side = await read("components/finder/machine/Sidebar.tsx");
    expect(side).toContain("borderRight: SIDEBAR_EDGE, background: SIDEBAR_SURFACE");
    expect(side).not.toContain("surface-nav");
    const { SIDEBAR_EDGE, SIDEBAR_SURFACE, PREVIEW_SURFACE } = await import("../src/lib/finderContrast.ts");
    expect(SIDEBAR_SURFACE).toBe(PREVIEW_SURFACE);
    expect(SIDEBAR_EDGE).toContain("60%");
  });
});

describe("icons: row 115, the card is Strata's measure", () => {
  test("picture + 12, 4, two lines of 18, 14 and 4 below, four between cards, never narrower than 120", async () => {
    const { CARD, tileSize } = await import("../src/lib/finderMiller.ts");
    expect(CARD).toMatchObject({ pad: 6, gap: 4, line: 18, lines: 2, details: 14, padY: 4, spacing: 4, minSlot: 120 });
    for (const t of [32, 64, 96, 256]) {
      const w = Math.max(t + 12, 116) + 4, h = t + 12 + 4 + 36 + 14 + 4 + 4;
      expect(tileSize(t)).toEqual({ w, h });
    }
  });
  test("the tile is drawn from those numbers, top-aligned, with no number of its own", async () => {
    const v = await read("components/finder/machine/FolderViews.tsx");
    expect(v).toContain("items-center justify-start");
    expect(v).toContain("padding: CARD.pad");
    expect(v).toContain("lineHeight: `${CARD.line}px`");
    expect(v).toContain("height: CARD.details");
    expect(v).not.toContain("tile.h - 4");
  });
  test("row 124 needs nothing: Strata gives only its list views a type-group header", async () => {
    const v = await read("components/finder/machine/FolderViews.tsx");
    const at = v.indexOf("export function IconsView(");
    expect(v.slice(at, v.indexOf("function useCaptionTip"))).not.toContain("it.header");
  });
});

describe("list: rows 104 and 105, Strata's widths, a drag, a fit, and the widths kept", async () => {
  const L = await import("../src/lib/finderList.ts");
  test("Size 90, Type 120, Modified 150, never under 70, 80 and 110, Name the rest until dragged", () => {
    expect(L.LIST_DEFAULT).toEqual([0, 90, 120, 150]);
    expect(L.LIST_MIN).toEqual([160, 70, 80, 110]);
    expect(L.listTemplate([0, 90, 120, 150])).toBe("minmax(160px, 1fr) 90px 120px 150px");
    expect(L.listTemplate([300, 90, 120, 150])).toBe("300px 90px 120px 150px");
  });
  test("a drag stays between the minimum and 800, and only moves its own column", () => {
    expect(L.resizeList([0, 90, 120, 150], 1, 90, 50)).toEqual([0, 140, 120, 150]);
    expect(L.resizeList([0, 90, 120, 150], 1, 90, -500)[1]).toBe(70);
    expect(L.resizeList([0, 90, 120, 150], 3, 150, 5000)[3]).toBe(800);
    expect(L.resizeList([0, 90, 120, 150], 0, 400, 0)[0]).toBe(400);
  });
  test("a fit is the widest content and the cell's padding, inside the bounds", () => {
    expect(L.fitList([0, 90, 120, 150], 2, 40)[2]).toBe(80);
    expect(L.fitList([0, 90, 120, 150], 2, 200.2)[2]).toBe(225);
  });
  test("stored widths are read field by field", () => {
    expect(L.readListW(undefined)).toEqual([0, 90, 120, 150]);
    expect(L.readListW([0, "x", 5, 99999])).toEqual([0, 90, 80, 800]);
    expect(L.readListW([240, 100, 100, 100])[0]).toBe(240);
    expect(readPrefs(JSON.stringify({ listW: [0, 100, 130, 160] })).listW).toEqual([0, 100, 130, 160]);
  });
  test("the headings and every row use the one template, so a column is one width down the list", async () => {
    const v = await read("components/finder/machine/FolderViews.tsx");
    expect(v.match(/gridTemplateColumns: tpl/g)?.length).toBe(2);
    expect(v).toContain('role="separator" aria-orientation="vertical" aria-label={`Resize ${t}`}');
    expect(v).toContain("onDoubleClick={() => {");
    expect((await read("components/finder/machine/MachineFinder.tsx"))).toContain("onWidths={(w) => setPrefs({ listW: w })}");
  });
});

describe("list: row 103, Strata's heading look and arrow", async () => {
  test("a bold 0.82em heading on the surface with a 28 px height, the hover and press fills, and an arrow icon on the sorted one", async () => {
    const v = await read("components/finder/machine/FolderViews.tsx");
    expect(v).toContain('fontSize: "0.82em", fontWeight: 700');
    expect(v).toContain("minHeight: 28");
    expect(v).toContain('name={sortWay === "asc" ? "arrow-up" : "arrow-down"} size={12}');
    expect(v).not.toContain('" ↑" : " ↓"');
    expect(css).toContain(".agx-list-heading:hover { background: color-mix(in srgb, var(--primary) 15%, transparent)");
    expect(css).toContain(".agx-list-heading:active");
  });
});

describe("status bar: row 165, the count's second sentence for a screen reader", async () => {
  const { footerDescription } = await import("../src/lib/finderSelect.ts");
  const dir = { kind: "dir", items: 2 } as const, file = { kind: "file", items: null } as const;
  test("nothing chosen: files and folders, singular and plural", () => {
    expect(footerDescription([file, file, file, dir, dir], 0)).toBe("3 files, 2 folders");
    expect(footerDescription([file, dir], 0)).toBe("1 file, 1 folder");
    expect(footerDescription([], 0)).toBe("0 files, 0 folders");
  });
  test("something chosen: how much of the folder, and what the size leaves out", () => {
    expect(footerDescription([file, file, dir], 2)).toBe("2 of 3 items selected. Size includes selected files only; folder contents are not counted.");
    expect(footerDescription([file], 1)).toBe("1 of 1 item selected. Size includes selected files only; folder contents are not counted.");
  });
  test("the footer carries it as its description", async () => {
    expect(await read("components/finder/machine/MachineFinder.tsx")).toContain('aria-live="polite" aria-description={describedCount}');
  });
});

describe("search: row 229, the empty hint and the indexing spinner", async () => {
  const search = await read("components/finder/machine/FinderSearch.tsx");
  test("the empty state is Strata's two lines, and the box keeps the break", async () => {
    const { emptyText } = await import("../src/lib/finderSearch.ts");
    expect(emptyText("", "ready", 0).split("\n")).toEqual(["Type to search Home and mounted local drives", "Fuzzy matching · try a name or path fragment"]);
    expect(search).toContain('className="whitespace-pre-line"');
  });
  test("a spinner stands in the search bar while the index is built, described as Strata describes it", () => {
    expect(search).toContain('status === "building" && <span role="status" aria-label="Indexing files…"');
  });
});

describe("narrow window: the List scrolls sideways under its columns' width instead of cutting the last one", async () => {
  const { listMinWidth } = await import("../src/lib/finderList.ts");
  test("Name's minimum plus the others plus the row margin; a dragged Name counts as dragged", () => {
    expect(listMinWidth([0, 90, 120, 150])).toBe(160 + 90 + 120 + 150 + 8);
    expect(listMinWidth([300, 90, 120, 150])).toBe(300 + 90 + 120 + 150 + 8);
  });
  test("the table is inside a sideways scroller and sized by it", async () => {
    const v = await read("components/finder/machine/FolderViews.tsx");
    expect(v).toContain("overflow-x-auto overflow-y-hidden");
    expect(v).toContain("minWidth: listMinWidth(widths)");
  });
});
