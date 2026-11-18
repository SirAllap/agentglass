/*
 * Settings > Plugins against mockup v2: the chips and cards that draw an icon
 * where the mockup draws one. A dot says "a state"; the icon says which kind.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBadge } from "../src/components/SettingsKit.tsx";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");

describe("StatusBadge icon", () => {
  test("an icon takes the place of the dot", () => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { tone: "warn", icon: createElement("svg", { "data-x": "1" }), children: "Asks again" }));
    expect(html).toContain('data-x="1"');
    expect(html).not.toContain("<i");
  });
  test("without an icon the dot stays", () => {
    expect(renderToStaticMarkup(createElement(StatusBadge, { tone: "ok", children: "Running" }))).toContain("<i");
  });
});

describe("Plugins page icons", () => {
  test("market unreachable draws the cloud, not the warning", () => {
    const unreach = src("components/plugins/Market.tsx").match(/agx-plug-unreach-pic[^\n]*/)?.[0] ?? "";
    expect(unreach).toContain("<CloudOffIcon");
    expect(unreach).not.toContain("WarningIcon");
  });
  test("asks again / not approved draw the warning, stopped the block", () => {
    const pane = src("components/PluginsPane.tsx");
    expect(pane).toMatch(/tone === "warn" \? <WarningIcon[^>]*\/> : tone === "err" \? <BlockedIcon/);
  });
  test("market tile: installed draws the check, update the arrow", () => {
    const market = src("components/plugins/Market.tsx");
    expect(market).toMatch(/mode === "installed" \? <DoneIcon[^>]*\/> : <UpIcon/);
  });
});
