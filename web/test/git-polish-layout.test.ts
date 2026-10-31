// Two layout rules in the Git view, asserted against source because there is no
// renderer here. Measured at 1000px: the bench button sat on the dock's More,
// and the reflog's search sat 43px above the log's because the log put a
// "history of" row over it.
import { describe, expect, it } from "bun:test";

const panel = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
const dock = await Bun.file(new URL("../src/components/GitDock.tsx", import.meta.url)).text();
const review = await Bun.file(new URL("../src/components/diff/DiffReview.tsx", import.meta.url)).text();

describe("the bench button does not sit on a bottom bar", () => {
  it("the dock keeps clear of it, through the one shared hook", () => {
    expect(dock).toContain("useFurnitureClear<HTMLDivElement>(");
    expect(dock).toMatch(/paddingRight: 12 \+ clear/);
    expect(dock).toContain("ref={bar}");
  });
  it("the review tray keeps a fixed corner clear, on its bar and its body, and measures nothing", () => {
    // The bench button is always in that corner, so a constant does the job the
    // hook did without moving the bar's content between renders.
    expect(review).toContain("const BENCH_CORNER = 64;");
    expect(review.split("marginRight: BENCH_CORNER").length - 1).toBe(1);
    expect(review.split("style={{ ...gutter, minHeight: 46 }}").length - 1).toBe(1);
    expect(review).not.toContain("querySelectorAll(\"[data-floating-furniture]\")");
  });
});

describe("a search box lives in the same place in every history tab", () => {
  const logStart = panel.indexOf('view === "log" ? (');
  const reflogStart = panel.indexOf('view === "reflog" ? (');
  const log = panel.slice(logStart, panel.indexOf('view === "branches" ? (', logStart));
  it("the log's scope and its search are one toolbar row, so nothing can sit over the search", () => {
    const search = log.indexOf("search={{");
    expect(log.match(/<LogToolbar /g)?.length).toBe(2);
    expect(search).toBeGreaterThan(log.indexOf("<LogToolbar", log.indexOf("</>) : (<>")));
    expect(log).not.toContain("<ListSearch");
    expect(log).not.toContain("logScopeStrip");
  });
  it("neither tab puts a row over its search", () => {
    const reflog = panel.slice(reflogStart, reflogStart + 6000);
    expect(reflog.indexOf("<ListSearch")).toBeGreaterThan(-1);
    expect(log).not.toContain("history of");
  });
});
