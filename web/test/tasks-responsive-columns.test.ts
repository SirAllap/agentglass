/*
 * The board table has no minimum width. Narrow, it drops columns by the width
 * of the table itself (a ResizeObserver on its scroller, not a viewport media
 * query: the card pane eats the table's room long before the window is small).
 * PR and Pts go under 760px, Who goes under 560px. Read as source for the wiring.
 */
import { describe, expect, it } from "bun:test";
import { columnTier, columnsAt } from "../src/lib/tasksColumnFit.ts";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const hook = await Bun.file(new URL("../src/lib/useColumnTier.ts", import.meta.url)).text();

describe("columnsAt", () => {
  it("keeps everything from 760px up", () => {
    expect(columnsAt(columnTier(760))).toEqual({ pr: true, who: true, pts: true });
    expect(columnsAt(columnTier(1400))).toEqual({ pr: true, who: true, pts: true });
  });
  it("drops PR and Pts under 760px", () => {
    expect(columnsAt(columnTier(759))).toEqual({ pr: false, who: true, pts: false });
    expect(columnsAt(columnTier(560))).toEqual({ pr: false, who: true, pts: false });
  });
  it("drops Who as well under 560px", () => {
    expect(columnsAt(columnTier(559))).toEqual({ pr: false, who: false, pts: false });
  });
  it("treats an unmeasured table as wide, so the first paint is not the narrow one", () => {
    expect(columnsAt(columnTier(0))).toEqual({ pr: true, who: true, pts: true });
  });
});

describe("the table", () => {
  it("has no minimum width", () => {
    expect(src).not.toContain("TABLE_MIN_W");
    expect(src).not.toMatch(/minWidth: 720/);
  });
  it("measures its own scroller with a ResizeObserver", () => {
    expect(hook).toContain("new ResizeObserver(");
    expect(hook).not.toContain("matchMedia");
    expect(hook).not.toContain("setInterval");
    expect(src).toContain("useColumnTier(");
  });
  it("draws the heading and rows from the same tier", () => {
    expect(src).toContain("showPr={cols.pr}");
    expect(src).toContain("cols.pts");
  });
});
