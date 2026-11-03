// The views bar's first paint and the wiring that a paint cannot show. There is
// no DOM under `bun test`, so effects and presses do not run.
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyLanes, type PrView } from "../../shared/prFilter.ts";
import { PrViewsBar, VISIBLE_CHIPS, failureText } from "../src/components/PrViewsBar.tsx";
import type { PrViewsApi } from "../src/components/usePrViews.ts";

const mk = (n: number): PrView[] => Array.from({ length: n }, (_, i) => ({ id: `v${i}`, name: `View ${i}`, filter: emptyLanes(), order: i }));
function paint(views: PrView[], activeIdx: number | null, live = emptyLanes()) {
  const api: PrViewsApi = {
    views, loading: false, active: activeIdx === null ? null : views[activeIdx]!, setActive() {}, save: () => null, saveNew: () => null,
    remove() {}, rename: () => null, move() {}, undo: null, restore() {},
  };
  return renderToStaticMarkup(React.createElement(PrViewsBar, {
    api, counts: new Map(views.map((v, i) => [v.id, i + 1])), live, setLive() {}, hotkeys: false,
    sort: { options: [{ value: "a", label: "A" }], value: "a", onPick() {} },
  }));
}

describe("the views bar, first paint", () => {
  test("one button per view up to the limit, each with its count, the active one pressed", () => {
    const html = paint(mk(3), 1);
    expect(html.match(/aria-pressed="/g)?.length).toBe(3);
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(html).toContain("View 2");
  });
  test(`${VISIBLE_CHIPS} views show and the menu button counts the rest`, () => {
    const html = paint(mk(VISIBLE_CHIPS + 2), 0);
    expect(html.match(/aria-pressed="/g)?.length).toBe(VISIBLE_CHIPS);
    expect(html).not.toContain(`View ${VISIBLE_CHIPS}<`);
    expect(html).toMatch(/aria-label="More views[^"]*"[\s\S]*?>2</);
  });
  test("a changed live filter puts a dot on the active view and offers Save to it", () => {
    const live = emptyLanes();
    live.hide.children.push({ id: "x", field: "text", op: "contains", values: ["BETA"] });
    const html = paint(mk(2), 0, live);
    expect(html).toContain('aria-label="changed"');
    expect(html).toContain("Save view");
  });
  test("an untouched filter has no dot and no Save pill", () => {
    const html = paint(mk(2), 0);
    expect(html).not.toContain('aria-label="changed"');
    expect(html).not.toContain("Save view");
  });
  test("rules with no view on offer to be saved as one", () => {
    const live = emptyLanes();
    live.hide.children.push({ id: "x", field: "text", op: "contains", values: ["BETA"] });
    expect(paint(mk(2), null, live)).toContain("Save as view");
  });
  test("a refusal is said in the name box's words", () => {
    expect(failureText("taken", "  QA ")).toBe("“QA” is taken");
    expect(failureText("empty")).toBe("Give it a name");
    expect(failureText("full")).toContain("12 views");
  });
});

describe("the board is wired to it", () => {
  const panel = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
  test("PrPanel draws the views bar and counts through the board's own evaluation", () => {
    expect(panel).toContain("usePrViews(repoSlug)");
    expect(panel).toContain("<PrViewsBar api={viewsApi}");
    const counts = panel.slice(panel.indexOf("const viewCounts"), panel.indexOf("Neither list has answered yet"));
    expect(counts).toContain("evalExempt(deckRows, v.filter, readPrField, isRuleExempt)");
  });
  test("the old preset row and builder are not on the PR board any more", () => {
    expect(panel).not.toContain("<FilterPresets");
    expect(panel).not.toContain("<FilterBuilder");
    expect(panel).not.toContain("useFilterPresets");
  });
});

// The board stays mounted under the other views and is only `visibility: hidden`
// (Workspace.tsx). A child that says `visibility: visible` shows through its
// hidden parent, which drew "Clear filters" over the Git and Terminal views.
// The Clear now lives in the rules row (disabled, never hidden), so the rule is
// "nobody forces it", in both the views bar and the deck.
describe("the views bar under a hidden board", () => {
  test("no control forces visibility: visible, so a hidden board hides it too", () => {
    const bar = readFileSync(new URL("../src/components/PrViewsBar.tsx", import.meta.url), "utf8");
    const code = bar.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n");
    expect(code).not.toMatch(/visibility:[^,}]*"visible"/);
    const deck = readFileSync(new URL("../src/components/PrFilterDeck.tsx", import.meta.url), "utf8");
    expect(deck).not.toMatch(/visibility:[^,}]*"visible"/);
  });
});
