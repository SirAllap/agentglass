/*
 * How wide a column is: the longest name it holds, kept between a floor and a
 * ceiling, with whatever width is free given to the last column so nothing is
 * cut while there is room. Drag and double-click change one column's width.
 */
import { describe, expect, test } from "bun:test";
import { COL_CHROME, COL_DEFAULT, columnWidth, fitWidth, dragWidth, longestNames, revealScroll, stripPad, previewWidth, dragPreviewWidth, stripLayout, stripRoom, TIGHT_W } from "../src/lib/finderColumns.ts";

const px = (s: string) => s.length * 7;

describe("the width of one column (Strata's rule: 300, never narrower)", () => {
  test("every column is 300 px whatever its names, and only a drag or a fit changes that", () => {
    expect(COL_DEFAULT).toBe(300);
    expect(columnWidth()).toBe(300);
  });
  test("a drag is never under 300 and never over the room the strip has", () => {
    expect(dragWidth(300, -500)).toBe(300);
    expect(dragWidth(300, 40)).toBe(340);
    expect(dragWidth(300, 5000)).toBe(800);
    expect(columnWidth(120)).toBe(300);
    expect(columnWidth(700, 500)).toBe(500);
    expect(columnWidth(700, 200)).toBe(300);   // a strip narrower than a column still gets a whole one
  });
  test("a strip of many columns does not squeeze them: widths do not depend on how many there are", () => {
    expect(Array.from({ length: 30 }, () => columnWidth(undefined, 1000)).every((w) => w === 300)).toBe(true);
  });
  test("fit is the longest name plus the row's chrome, between 300 and the room", () => {
    expect(fitWidth(["a.txt", "a-rather-long-file-name-that-needs-more-than-three-hundred.txt"], px)).toBe(Math.ceil(px("a-rather-long-file-name-that-needs-more-than-three-hundred.txt")) + COL_CHROME);
    expect(fitWidth(["a"], px)).toBe(300);
    expect(fitWidth(["x".repeat(500)], px, 600)).toBe(600);
  });
  test("only the longest few are measured, so 100,000 names cost 16 measurements", () => {
    let measured = 0;
    const names = Array.from({ length: 100_000 }, (_, i) => `f${i}`);
    names.push("the-one-long-name-that-decides-the-fit-for-this-folder-of-a-hundred-thousand.txt");
    const w = fitWidth(names, (s) => { measured++; return px(s); });
    expect(measured).toBeLessThanOrEqual(16);
    expect(w).toBe(Math.ceil(px("the-one-long-name-that-decides-the-fit-for-this-folder-of-a-hundred-thousand.txt")) + COL_CHROME);
    expect(longestNames(names)[0]).toBe("the-one-long-name-that-decides-the-fit-for-this-folder-of-a-hundred-thousand.txt");
  });
});

describe("padding so an edge can be reached", () => {
  test("short last columns: room is added until the window is filled from the edge", () => {
    expect(stripPad([300, 300, 300, 300, 300], 900, 700)).toBe(100);
    expect(stripPad([300, 300], 0, 700)).toBe(0);
    expect(stripPad([300, 300, 300, 300], 0, 700)).toBe(0);
  });
});

describe("a lone column keeps its own width", () => {
  test("the free room stays empty, as in Strata: nothing hands it to the last column", async () => {
    const src = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
    expect(src).not.toContain("fillLast");
  });
});

describe("scrolling the strip to the active column", () => {
  const W = [300, 300, 300, 300, 300]; // five columns in a 700 px window
  test("everything fits: no scroll", () => { expect(revealScroll({ widths: [300, 300], active: 1, page: 700, current: 0 })).toBe(0); });
  test("the newest column in view starts the window on a column's own edge", () => {
    // right edge of column 4 is 1500; the window needs to start at ≥ 800; the next edge is 900
    expect(revealScroll({ widths: W, active: 4, page: 700, current: 0 })).toBe(900);
  });
  test("never a window that starts mid-column", () => {
    for (let a = 0; a < 5; a++) { const s = revealScroll({ widths: W, active: a, page: 700, current: 123 }); expect(s % 300).toBe(0); }
  });
  test("a window that is already right stays", () => { expect(revealScroll({ widths: W, active: 3, page: 700, current: 600 })).toBe(600); });
  test("going back left brings the column to the left edge", () => { expect(revealScroll({ widths: W, active: 0, page: 700, current: 900 })).toBe(0); });
  test("uneven widths: the edge is the column's own", () => {
    const w = [200, 350, 260, 410];
    const s = revealScroll({ widths: w, active: 3, page: 700, current: 0 });
    expect([0, 200, 550, 810]).toContain(s);
    expect(s + 700).toBeGreaterThanOrEqual(1220);
  });
  test("a column wider than the window shows from its left edge", () => { expect(revealScroll({ widths: [300, 900], active: 1, page: 700, current: 0 })).toBe(300); });
  test("empty or unmeasured is 0", () => { expect(revealScroll({ widths: [], active: 0, page: 700, current: 5 })).toBe(0); expect(revealScroll({ widths: [300], active: 0, page: 0, current: 5 })).toBe(0); });
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

describe("names and badges in a row", () => {
  test("a long name ends in an ellipsis: one truncating span, no clipped tail", async () => {
    const t = await Bun.file(new URL("../src/components/finder/machine/Column.tsx", import.meta.url)).text();
    expect(t).toContain('<span data-name className="min-w-0 truncate">{name}</span>');
    expect(t).not.toContain("splitName");
  });
  test("the item count shows on the selected folder of the active column only", async () => {
    const t = await Bun.file(new URL("../src/components/finder/machine/Column.tsx", import.meta.url)).text();
    expect(t).toContain("r.items !== null && !tight && badge &&");
    expect(t).toContain("r.name === selName && showsBadge(true, focused)");
  });
});

describe("the preview panel's width", () => {
  test("a third of the finder between 300 and 460 until it is dragged", () => {
    expect(previewWidth(1000)).toBe(360);
    expect(previewWidth(600)).toBe(300);
    expect(previewWidth(3000)).toBe(460);
  });
  test("the 320 px the columns keep are beside the sidebar, not counting it", () => {
    expect(previewWidth(1200, 1100)).toBe(880);
    expect(previewWidth(1200, 1100, 201)).toBe(679);
    expect(dragPreviewWidth(1200, 500, 900, 100, 201)).toBe(679);
  });
  test("dragged, it keeps 240 px at least and leaves the columns 320", () => {
    expect(previewWidth(1200, 100)).toBe(240);
    expect(previewWidth(1200, 700)).toBe(700);
    expect(previewWidth(1200, 1100)).toBe(880);
    expect(previewWidth(400, 1100)).toBe(240);
  });
});

describe("the strip layout cannot loop", () => {
  /** What the browser does to a scroll position once the strip has `pad` of room after it. */
  const clamp = (scroll: number, widths: number[], pad: number, page: number) => Math.max(0, Math.min(scroll, widths.reduce((a, b) => a + b, 0) + pad - page));
  test("dragging an edge back and forth settles on the first answer each time", () => {
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let cur = 0;
    for (let i = 0; i < 400; i++) {
      const n = 2 + Math.floor(rnd() * 5);
      const widths = Array.from({ length: n }, () => 120 + Math.floor(rnd() * 500));
      const active = Math.floor(rnd() * n), page = 500 + Math.floor(rnd() * 900);
      let a = stripLayout(widths, active, page, cur);
      cur = clamp(a.scroll, widths, a.pad, page);
      // The layout effect runs again only when widths or the active column change. Asked again with what the browser did, it must not move the pad, or a state holding the pad would be set again and again.
      const b = stripLayout(widths, active, page, cur);
      expect(b.pad, `${widths} @${active}/${page}`).toBe(a.pad);
      expect(b.scroll).toBe(cur);
    }
  });
  test("the strip's room is not React state", async () => {
    const src = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
    const row = src.slice(src.indexOf("function ColumnsRow("));
    expect(row.slice(0, row.indexOf("\n}\n"))).not.toMatch(/useState|setPad/);
  });
  test("the rows of a tight column drop their size and count", async () => {
    expect(TIGHT_W).toBeGreaterThan(120);
    const src = await Bun.file(new URL("../src/components/finder/machine/Column.tsx", import.meta.url)).text();
    expect(src).toContain("!tight &&");
  });
});

describe("free room goes to the preview, not to a gap", () => {
  test("with the preview beside the columns and nothing dragged, the preview grows and the columns do not", async () => {
    const src = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
    expect(src).toContain('"0 1 auto" : "1 1 0%"');
    expect(src).toMatch(/flex: `\$\{prevDrag === undefined && prefs\.view === "columns" \? 1 : 0\} 0 /);
  });
});

describe("the sidebar as a page", () => {
  test("a window too narrow for it beside the files gives it the whole width", async () => {
    const { sidePageWidth } = await import("../src/lib/finderColumns.ts");
    expect(sidePageWidth(true, 460)).toBe(460);
    expect(sidePageWidth(false, 460)).toBeNull();
    expect(sidePageWidth(true, 0)).toBeNull();
  });
  test("the finder passes it to the sidebar", async () => {
    const t = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
    expect(t).toContain("const sideW = sidePageWidth(compact && sidePage, box.w) ??");
  });
});

describe("the strip beside the preview", () => {
  test("holds only whole columns, at least one", async () => {
    const { wholeColumnsWidth } = await import("../src/lib/finderColumns.ts");
    expect(wholeColumnsWidth([300, 300, 300], 697)).toBe(600);
    expect(wholeColumnsWidth([300, 300], 900)).toBe(600);
    expect(wholeColumnsWidth([300, 300], 200)).toBe(300);
    expect(wholeColumnsWidth([], 500)).toBe(0);
  });
  test("the finder caps the strip with it and snaps to column edges, and refits when the strip is resized", async () => {
    const t = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
    expect(t).toContain("maxWidth: stripMax");
    expect(t).toContain('scrollSnapType: "x mandatory"');
    expect(t).toContain("[key, active, page]");
  });
});

describe("autofit beside the preview", () => {
  // The strip beside the preview shrinks to its first column (300), so a fit measured against the strip could never pass 300.
  const long = ["a-very-long-folder-name-that-needs-more-than-three-hundred-pixels.txt"];
  test("the room is the finder less the sidebar, the preview and its divider", () => {
    expect(stripRoom(1400, 201)).toBe(1400 - 201 - previewWidth(1400) - 7);
  });
  test("a long name fits into that room, not into the 300 the strip has shrunk to", () => {
    expect(fitWidth(long, px, 300)).toBe(300);
    expect(fitWidth(long, px, stripRoom(1400, 201))).toBeGreaterThan(300);
  });
  test("the finder's fit asks for the room beside the preview", async () => {
    const t = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
    expect(t).toContain("measure, columnRoom)");
    expect(t).toContain("const columnRoom = stripAvail ?? (mainBox.w || undefined);");
    expect(t).toContain("columnWidth(dragged[c.path], columnRoom)");
    expect(t).not.toContain("mainBox.w || undefined)),");
  });
});

describe("the finder gives the preview its sidebar", () => {
  test("every width it asks for counts the sidebar", async () => {
    const t = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
    expect(t).not.toMatch(/previewWidth\(box\.w, prevDrag\)/);
    expect(t).toContain("dragPreviewWidth(box.w, w0, x0, ev.clientX, sideTaken)");
  });
});
