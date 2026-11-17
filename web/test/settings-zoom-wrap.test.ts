import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { railTrim, RAIL_PAD, RAIL_SLOT } from "../src/lib/settingsNav.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("section chip strip wraps, with no hidden scroll or fade mask", () => {
  const src = read("../src/components/settings/shell/PageRail.tsx");
  expect(src).toContain('"flex flex-wrap gap-1.5 py-2"');
  expect(src).not.toContain("overflow-x-auto py-2");
  expect(src).not.toContain("maskImage");
});

test("left view rail snaps to whole icons when it scrolls", () => {
  expect(read("../src/components/workspace/ViewRail.tsx")).toContain("agw-rail-snap");
  const css = read("../src/index.css");
  expect(css).toContain(".agw-rail-snap { scroll-snap-type: y mandatory");
  expect(css).toContain(".agw-rail-snap [data-view] { scroll-snap-align: start; }");
});

test("settings nav rail (the icon rail at 200 %) snaps to whole icons", () => {
  const css = read("../src/index.css");
  expect(css).toContain(".agx-sn-scroll { padding: 4px 6px; scroll-snap-type: y mandatory");
  expect(css).toContain(".agx-sn-scroll .agx-sn-it, .agx-sn-scroll .agx-sn-gh { scroll-snap-align: start; }");
});

test("the icon rail's visible height is whole slots: one slot height, trimmed bottom margin", () => {
  const css = read("../src/index.css");
  expect(css).toContain(".agx-sn-scroll .agx-sn-gh, .agx-sn-scroll .agx-sn-it { box-sizing: border-box; height: 36px; padding-block: 0; }");
  expect(css).toContain(".agx-sn-scroll .agx-sn-grp { margin: 0; }");
  const nav = read("../src/components/SettingsNav.tsx");
  expect(nav).toContain("railTrim(el.clientHeight)");
  // 500px viewport: avail 196 -> 8 + 5 slots (188) leaves 8; a whole fit leaves 0.
  expect(railTrim(196)).toBe(8);
  expect(railTrim(8 + 36 * 5)).toBe(0);
  expect((196 - railTrim(196) - RAIL_PAD) % RAIL_SLOT).toBe(0);
  expect(railTrim(30)).toBe(0);
});

test("a jumped-to rail entry stays pinned across a list or height change and re-lands", () => {
  const src = read("../src/components/settings/shell/PageRail.tsx");
  expect(src).toContain("pinnedId.current = s.id");
  expect(src).toContain("new ResizeObserver(realign)");
  expect(src).toContain("pinned.current = pinnedId.current !== null");
});

test("Settings actions are the house Button, not a bare agx-btn", () => {
  for (const f of ["AboutPage", "ReportProblem"]) {
    const src = read(`../src/components/settings/pages/${f}.tsx`);
    expect(src).not.toContain('className="agx-btn"');
    expect(src).toContain('<Button size="compact"');
  }
});
