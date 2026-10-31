/*
 * The live window the Window & startup and Appearance previews draw. It shows
 * the app's own screens on invented data, never the Dashboard, and it follows
 * the controls: Display size changes how much of the app fits, density and type
 * size are worn by the window itself.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LIVE_BASE_W, LIVE_VIEWS, LiveWindow } from "../src/components/settings/previews/LiveWindow.tsx";
import { AppearancePreview } from "../src/components/settings/previews/AppearancePreview.tsx";
import { WindowPreview } from "../src/components/settings/previews/WindowPreview.tsx";

const DIR = join(import.meta.dir, "../src/components/settings/previews");
const src = (f: string) => readFileSync(join(DIR, f), "utf8");
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const h = React.createElement;

describe("the views a live window offers", () => {
  test("Starboard is not one of them, and neither preview draws the miniature", () => {
    expect(LIVE_VIEWS.map((v) => v.id)).toEqual(["settings", "lantern", "diff"]);
    for (const f of ["WindowPreview.tsx", "AppearancePreview.tsx", "LiveWindow.tsx"]) {
      expect(src(f), f).not.toMatch(/<MiniApp\b|view="dash"|"dash"/);
    }
  });

  test("each view is the app's own component", () => {
    const c = src("LiveWindow.tsx");
    expect(c).toContain("<SettingsPageHeader");
    expect(c).toContain("<SettingsCard");
    expect(c).toContain("<LanternDemo");
    expect(c).toContain("<DiffDemo");
    expect(src("LanternPreview.tsx")).toContain("<AgentCard");
    expect(src("DiffPreview.tsx")).toMatch(/<SplitDiff[\s\S]*<UnifiedDiff/);
  });

  test("a view draws its own body", () => {
    const body = (view: "settings" | "lantern" | "diff") => html(h(LiveWindow, { view, zoomPct: 100, aspect: 1.6 }));
    expect(body("settings")).toContain('data-view-body="settings"');
    expect(body("lantern")).toContain('data-view-body="lantern"');
    expect(body("diff")).toContain('data-view-body="diff"');
    expect(body("lantern")).not.toContain('data-view-body="settings"');
  });
});

describe("the window follows the controls", () => {
  test("Display size sets how wide the window is laid out: a bigger size fits less", () => {
    const width = (zoomPct: number) => Number(html(h(LiveWindow, { view: "settings", zoomPct, aspect: 1.6 })).match(/width:([\d.]+)px;height/)?.[1]);
    // Rendered without a layout, the box is 480 px: drawn at half the base width.
    expect(width(100)).toBeCloseTo(LIVE_BASE_W, 0);
    expect(width(125)).toBeCloseTo(LIVE_BASE_W / 1.25, 0);
    expect(width(90)).toBeGreaterThan(width(100));
  });

  test("density and type size are worn by the window, so the real rows answer to them", () => {
    const m = (o: object) => html(h(LiveWindow, { view: "settings", zoomPct: 100, aspect: 1.6, ...o }));
    expect(m({ density: "compact" })).toContain('data-density="compact"');
    expect(m({ density: "comfortable" })).not.toContain("data-density");
    expect(m({ fontPx: 15 })).toContain('data-ui-font="15"');
    expect(m({ fontPx: 13 })).not.toContain("data-ui-font");
  });

  test("the previews pass their values through", () => {
    const a = html(h(AppearancePreview, { theme: "porcelain", accent: "", density: "roomy", fontPx: 14, translucent: false, view: "lantern" }));
    expect(a).toContain('data-density="roomy"');
    expect(a).toContain('data-ui-font="14"');
    expect(a).toContain('data-view-body="lantern"');
    const w = html(h(WindowPreview, { zoomPct: 110, fullscreen: false, startAtLogin: false, launchAnimation: false, showClock: false, codexQuota: false, view: "diff" }));
    expect(w).toContain('data-view-body="diff"');
    expect(w).toContain(`width:${LIVE_BASE_W / 1.1}px`);
  });
});
