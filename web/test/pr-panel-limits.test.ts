import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RAIL_W, RAIL_W_XL, railBeside, railWidth, BP_PAGE, BP_SIDE, BP_SUB, BP_WIDE, BP_XL, COLLAPSE_AT, EXPAND_AT, headerFolded, PANEL_DEFAULT, PANEL_MIN, panelBand } from "../src/lib/prPanelLimits.ts";
import { DOCK_MIN_PX, DOCK_PX, LANE_PX, dockMax } from "../src/lib/prDock.ts";

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
const block = css.slice(css.indexOf(".prx {"));

describe("the panel limits", () => {
  test("the three widths are the ones the mockup names", () => {
    expect([PANEL_MIN, PANEL_DEFAULT]).toEqual([320, 620]);
  });
  test("the splitter is clamped to them", () => {
    expect(DOCK_MIN_PX).toBe(PANEL_MIN);
    expect(DOCK_PX).toBe(PANEL_DEFAULT);
    expect(dockMax(5000)).toBe(5000 - LANE_PX);
  });
  test("the bands fall on the breakpoints", () => {
    expect(panelBand(439)).toBe("tight");
    expect(panelBand(440)).toBe("side");
    expect(panelBand(719)).toBe("side");
    expect(panelBand(720)).toBe("wide");
    expect(panelBand(960)).toBe("page");
    expect(panelBand(1280)).toBe("xl");
  });
});

describe("the CSS literals match the constants", () => {
  const mins = (n: number) => `@container pr (min-width: ${n}px)`;
  test.each([[BP_SIDE], [BP_WIDE], [BP_PAGE], [BP_SUB]])("min-width %ipx is in the block", (n) => {
    expect(block).toContain(mins(n));
  });
  test("tight is one pixel under BP_SIDE", () => { expect(block).toContain(`@container pr (max-width: ${BP_SIDE - 1}px)`); });
  test("every container query in the block is a known breakpoint", () => {
    const known = new Set([BP_SIDE, BP_WIDE, BP_PAGE, BP_SUB, BP_XL, BP_SIDE - 1]);
    const seen = [...block.matchAll(/@container pr \((?:min|max)-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    expect(seen.length).toBeGreaterThan(5);
    for (const n of seen) expect(known.has(n)).toBe(true);
  });
  test("nothing caps the panel width", () => { expect(block).not.toContain("CONTENT_MAX"); });
});

describe("the folded header", () => {
  const roomy = { slack: 2000, chrome: 200 };
  test("folds past COLLAPSE_AT and not before", () => {
    expect(headerFolded({ y: COLLAPSE_AT, folded: false, ...roomy })).toBe(false);
    expect(headerFolded({ y: COLLAPSE_AT + 1, folded: false, ...roomy })).toBe(true);
  });
  test("stays folded until nearly the top: the gap is the hysteresis", () => {
    expect(headerFolded({ y: 30, folded: true, ...roomy })).toBe(true);
    expect(headerFolded({ y: EXPAND_AT, folded: true, ...roomy })).toBe(false);
  });
  test("never folds a body that could not scroll after it (it would flicker)", () => {
    expect(headerFolded({ y: 200, folded: false, slack: 220, chrome: 200 })).toBe(false);
  });
});

const ovBlock = css.slice(css.indexOf("Pull request Overview body"));

describe("the Overview rail limits", () => {
  test("css literals match the constants", () => {
    expect(ovBlock).toContain(`@container prov (min-width: ${BP_PAGE}px) { .prov-cols.prov-two { grid-template-columns: minmax(0, 1fr) var(--prov-rail-w, ${RAIL_W}px)`);
    expect(ovBlock).toContain(`@container prov (min-width: ${BP_XL}px) { .prov-cols.prov-two { --prov-rail-w: ${RAIL_W_XL}px`);
    expect(ovBlock).toContain(`@container prov (min-width: ${BP_WIDE}px) and (max-width: ${BP_PAGE - 1}px)`);
    expect(ovBlock).toContain(`@container prov (max-width: ${BP_SIDE - 1}px)`);
    expect(ovBlock).not.toContain("74ch");
    expect(ovBlock).toContain(".prov-cols { display: grid; gap: 24px; grid-template-columns: minmax(0, 1fr); }");
  });
  test("bands", () => {
    expect([PANEL_MIN, 439, 440, 719, 720, 959, 960, 1279, 1280, 2880].map(panelBand)).toEqual(["tight", "tight", "side", "side", "wide", "wide", "page", "page", "xl", "xl"]);
  });
  test("rail beside from the page breakpoint, 360 wide from xl", () => {
    expect(railBeside(959)).toBe(false);
    expect(railBeside(960)).toBe(true);
    expect(railWidth(1279)).toBe(320);
    expect(railWidth(1280)).toBe(360);
  });
});
