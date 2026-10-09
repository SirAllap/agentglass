/*
 * The Plugins view and the plugin panes, held to the house controls.
 *
 * A render of the view beside the Settings pane found the same three things
 * each drawn a second time by hand:
 *
 *   - the panel strip and a panel's own sections were plain buttons in a
 *     `role="tablist"` of their own, without the roving arrows or the tabpanel
 *     `Tabs` gives, and 28 / 30px tall where a tab is 32;
 *   - the empty state, the install form, the market rows and a plugin card each
 *     spelled a push button as `text-[12px] px-2.5 py-1 rounded-lg`, a 26px
 *     control on a 22 / 28 ladder, and the market's type filter was a
 *     `rounded-full` pill beside `Chip`;
 *   - the pull request's plugin button was 24px, off the ladder, beside a
 *     22px `Menu`.
 *
 * Read from source, because mounting these wants a running plugin process.
 */
import { describe, expect, test } from "bun:test";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
/** Comments say what a thing replaced; only code is asserted on. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const view = code(await read("components/plugins/PluginsView.tsx"));
const tree = code(await read("components/plugins/PluginTree.tsx"));
const market = code(await read("components/plugins/Market.tsx"));
const pane = code(await read("components/PluginsPane.tsx"));
const review = code(await read("components/plugins/LocalReview.tsx"));
const prActions = code(await read("components/plugins/PluginPrActions.tsx"));
const css = await read("index.css");

/** The pieces a hand-drawn push button is made of. */
const HAND_BUTTON = /className="[^"]*(?:text-\[12px\]|text-\[11px\]|text-\[10px\])[^"]*\bpx-[0-9.]+[^"]*\bpy-[0-9.]+[^"]*\brounded/;

describe("the Plugins view", () => {
  test("its panel strip is the shared Tabs over a tabpanel", () => {
    expect(view).toContain("<Tabs<string>");
    expect(view).toContain('role="tabpanel"');
    expect(view).not.toContain('role="tablist"');
    expect(view).not.toContain("<button");
  });

  test("a plugin's own sections are the shared Tabs too", () => {
    expect(tree).toContain("<HouseTabs<string>");
    expect(tree).toContain('role="tabpanel"');
    expect(tree).not.toContain('role="tab"');
    expect(tree).not.toContain("h-[30px]");
  });
});

describe("the plugin panes", () => {
  test.each([
    ["Market", market],
    ["PluginsPane", pane],
    ["LocalReview", review],
    ["PluginsView", view],
  ])("%s draws no push button of its own", (_name, src) => {
    expect(HAND_BUTTON.test(src)).toBe(false);
    expect(/px-3 py-1\.5 rounded-lg/.test(src)).toBe(false);
    expect(src).toContain("<Button");
  });

  test("the market's type filter is Chip, not a pill", () => {
    expect(market).toContain("<Chip");
    expect(market).not.toContain("rounded-full whitespace-nowrap");
  });

  test("an install in flight shows in the button, not in a second control", () => {
    expect(market).toContain('<Button tone="primary" pending={busy}');
    expect(pane).toContain("<Button pending={busy}");
  });

  test("the way back is a drawn arrow, not a typed one", () => {
    expect(pane).toContain("<BackIcon");
    expect(pane).not.toContain("← All plugins");
    expect(tree).not.toContain("↗");
  });
});

describe("the pull request's plugin button", () => {
  test("stands on the compact rung beside the Menu it sits next to", () => {
    expect(prActions).toContain("height: CTRL_H.compact");
    expect(prActions).not.toContain("h-[24px]");
    expect(prActions).toContain("rounded-lg");
  });
});

describe("a plugin's form fields", () => {
  test("wear the house well and edge, not --bg3 and a half-strength --border", () => {
    const rule = css.slice(css.indexOf(".agx-input {"), css.indexOf("}", css.indexOf(".agx-input {")));
    expect(rule).toContain("var(--surface-inset)");
    expect(rule).toContain("color-mix(in srgb, var(--text) 14%, transparent)");
    expect(rule).not.toContain("var(--bg3)");
  });
});
