/*
 * The sidebar's edge can be dragged, as in Strata: 201 px to start, never
 * narrower than 169, remembered. The rail is a fixed 34 and is not resized.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, readPrefs } from "../src/lib/finderMiller.ts";
import { SIDE_DEFAULT, SIDE_MAX, SIDE_MIN, sidebarWidth } from "../src/lib/finderColumns.ts";

describe("sidebar width", () => {
  test("Strata's numbers", () => { expect([SIDE_MIN, SIDE_DEFAULT]).toEqual([169, 201]); expect(DEFAULT_PREFS.sideW).toBe(201); });
  test("the full list takes the stored width, between the floor and the cap", () => {
    expect(sidebarWidth("full", 260, 1400)).toBe(260);
    expect(sidebarWidth("full", 100, 1400)).toBe(169);
    expect(sidebarWidth("full", 900, 1400)).toBe(SIDE_MAX);
  });
  test("it never eats the columns: 320 px stay for them", () => {
    expect(sidebarWidth("full", 360, 700)).toBe(360);
    expect(sidebarWidth("full", 360, 600)).toBe(280);
    expect(sidebarWidth("full", 360, 400)).toBe(169);
  });
  test("the rail is not resizable", () => { expect(sidebarWidth("rail", 300, 1400)).toBe(34); });
  test("a stored width is clamped and a wrong type is the default", () => {
    expect(readPrefs(JSON.stringify({ sideW: 5 })).sideW).toBe(169);
    expect(readPrefs(JSON.stringify({ sideW: 9999 })).sideW).toBe(SIDE_MAX);
    expect(readPrefs(JSON.stringify({ sideW: "wide" })).sideW).toBe(201);
  });
});

describe("the edge", () => {
  const src = Bun.file(new URL("../src/components/finder/machine/Sidebar.tsx", import.meta.url)).text();
  test("is a keyboard-reachable separator with a 6 px grip, and the rail does not get one", async () => {
    const s = await src;
    expect(s).toContain('role="separator"');
    expect(s).toContain("width: 6");
    expect(s).toContain("tabIndex={0}");
    expect(s).toMatch(/!rail && \(\s*<div role="separator"/);
  });
});

describe("a grip keeps its own arrow keys", () => {
  test("the window's key listener steps aside for a separator", async () => {
    const s = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
    expect(s).toContain("closest?.('[role=\"separator\"]')");
  });
});
