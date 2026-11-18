import { describe, expect, test } from "bun:test";
import { paneAtCorner, paneFoot, touchesRightEdge } from "../src/lib/paneBox.ts";

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
const foot = (pane: { left: number; top: number; right: number; bottom: number } | null) =>
  paneFoot({ screen: rect(0, 0, 1000, 500), slot: rect(0, 0, 1000, 500), cols: 100, rows: 50, pane });

describe("touchesRightEdge", () => {
  test("single pane reaches the edge", () => {
    expect(touchesRightEdge({ left: 0, width: 1000 }, 1000)).toBe(true);
    expect(foot(null).atRight).toBe(true);
  });
  test("vertical split: right pane yes, left pane no", () => {
    expect(foot({ left: 50, top: 0, right: 99, bottom: 49 }).atRight).toBe(true);
    expect(foot({ left: 0, top: 0, right: 49, bottom: 49 }).atRight).toBe(false);
  });
  test("horizontal split: only the bottom pane touches the corner", () => {
    expect(foot({ left: 0, top: 0, right: 99, bottom: 24 }).atRight).toBe(false);
    expect(foot({ left: 0, top: 25, right: 99, bottom: 49 }).atRight).toBe(true);
  });
  test("2x2 grid: only the bottom-right pane", () => {
    expect(foot({ left: 0, top: 0, right: 49, bottom: 24 }).atRight).toBe(false);
    expect(foot({ left: 50, top: 0, right: 99, bottom: 24 }).atRight).toBe(false);
    expect(foot({ left: 0, top: 25, right: 49, bottom: 49 }).atRight).toBe(false);
    expect(foot({ left: 50, top: 25, right: 99, bottom: 49 }).atRight).toBe(true);
  });
  test("big font: slack of one cell plus padding still counts as the edge", () => {
    // cellW 14, padding 4, 17 px of slack right of the grid: beyond the old fixed 16.
    const big = (pane: { left: number; top: number; right: number; bottom: number }) =>
      paneFoot({ screen: rect(4, 0, 980, 500), slot: rect(0, 0, 1001, 500), cols: 70, rows: 50, pane });
    expect(big({ left: 35, top: 0, right: 69, bottom: 49 }).atRight).toBe(true);
    expect(big({ left: 0, top: 0, right: 34, bottom: 49 }).atRight).toBe(false);
  });
});

describe("paneAtCorner (card reserve, independent of actionsMode and of any measure)", () => {
  test("2x2 split: only the bottom-right pane is the corner", () => {
    expect(paneAtCorner({ left: 0, top: 0, right: 49, bottom: 24 }, 100, 50)).toBe(false);
    expect(paneAtCorner({ left: 50, top: 0, right: 99, bottom: 24 }, 100, 50)).toBe(false);
    expect(paneAtCorner({ left: 0, top: 25, right: 49, bottom: 49 }, 100, 50)).toBe(false);
    expect(paneAtCorner({ left: 50, top: 25, right: 99, bottom: 49 }, 100, 50)).toBe(true);
  });
  test("no pane (single or zoomed) is the corner", () => {
    expect(paneAtCorner(null, 100, 50)).toBe(true);
  });
});

describe("setFootBox dedupe", () => {
  test("sees an atRight-only change", () => {
    const src = require("node:fs").readFileSync(new URL("../src/components/TerminalPanel.tsx", import.meta.url), "utf8") as string;
    expect(src).toContain("prev.width === foot.width && prev.atRight === foot.atRight ? prev : foot");
  });
});
