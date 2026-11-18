import { expect, test } from "bun:test";
import { restingTop } from "../src/components/settings/shell/PageRail.tsx";
import { dayId } from "../src/lib/activity.ts";

// Measured headless at 2540x900 (settings zoomed 1.107 from 2200px): the rail took 7-9 positions on
// Files, Data & privacy and About. The sticky top was `rect + scrollTop`, rects in zoomed px and
// scrollTop not, so each re-measure at a new scroll position gave a new top.
const pageRail = await Bun.file(new URL("../src/components/settings/shell/PageRail.tsx", import.meta.url)).text();

test("the rail's sticky top is the same at every scroll position, zoomed or not", () => {
  for (const zoom of [1, 1.107, 1.25]) {
    const resting = 96; // the rail's resting offset from the content top, CSS px
    const tops = [0, 37, 400, 1234].map((scroll) => {
      const contentTop = 80 - scroll * zoom; // the content moves up as the box scrolls
      return restingTop(contentTop + resting * zoom, contentTop, zoom);
    });
    expect(new Set(tops)).toEqual(new Set([resting]));
  }
});

test("a missing or broken zoom reads as 1, and the top is never negative", () => {
  expect(restingTop(130, 100, undefined)).toBe(30);
  expect(restingTop(130, 100, 0)).toBe(30);
  expect(restingTop(90, 100, 1)).toBe(0);
});

test("useStickyTop does not add scrollTop to a zoomed rect", () => {
  const hook = pageRail.slice(pageRail.indexOf("export function useStickyTop"), pageRail.indexOf("export const RAIL_FLASH_MS"));
  expect(hook).toContain("restingTop(");
  expect(hook).not.toMatch(/\+ box\.scrollTop/);
});

test("Workers releases the rail pin on a scope switch, like the other scoped pages", async () => {
  const src = await Bun.file(new URL("../src/components/settings/pages/WorkersPage.tsx", import.meta.url)).text();
  expect(src).toMatch(/<SettingsPage[^>]*scopeKey=\{rootFor\(sc\.choice, sc\.project\)\}/);
});

test("an Activity day id has no spaces, so its heading names the section", () => {
  for (const d of ["Today", "Yesterday", "3 days ago", "12 Nov"]) expect(dayId(d)).toMatch(/^day-[a-z0-9-]+$/);
  expect(dayId("3 days ago")).toBe("day-3-days-ago");
  expect(dayId("12 Nov")).not.toBe(dayId("13 Nov"));
});
