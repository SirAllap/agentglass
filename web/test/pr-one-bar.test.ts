import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * The pull-request panel's four header bars (repo, views, search, filters) are
 * one. There is no renderer here, so the rule is asserted against source.
 */
const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const code = (x: string) => x.split("\n").filter((l) => !/^\s*(\/?\*|\/\/)/.test(l)).join("\n");
const panel = code(read("../src/components/PrPanel.tsx"));
const bar = code(read("../src/components/PrFilterBar.tsx"));
const css = read("../src/index.css");

describe("the pull-request list header is one bar", () => {
  it("the header wraps in the list view and keeps its fixed height in the detail view", () => {
    expect(panel).toContain('selected == null ? "agx-prbar flex-wrap gap-y-1.5" : ""');
    expect(panel).toContain('{ ...viewHeaderStyle, height: "auto", maxHeight: "none"');
  });

  it("the views, the filter parts and the refresh are children of that one header, in that order", () => {
    const head = panel.indexOf("<div className={`${viewHeaderClass} relative");
    const pills = panel.indexOf('aria-label="Pull request views"');
    const filter = panel.indexOf("<PrFilterBar");
    const refresh = panel.indexOf("<RefreshButton onRefresh");
    expect(head).toBeGreaterThan(0);
    expect(pills).toBeGreaterThan(head);
    expect(filter).toBeGreaterThan(pills);
    expect(refresh).toBeGreaterThan(filter);
  });

  it("the filter bar draws parts of the header, not a bar of its own", () => {
    expect(bar).not.toContain("border-b shrink-0 flex flex-col");
    expect(bar).toContain("<>");
  });

  it("the search says one short thing in the box and the whole syntax in a popover", () => {
    expect(bar).toContain("placeholder={SEARCH_PLACEHOLDER}");
    expect(bar).toContain("focused && !menuOpen");
  });

  it("Sort and Save left the bar for the \"⋯\" menu; the builder has no button of its own", () => {
    expect(bar).not.toContain("FacetMenu");
    expect(panel).toContain("<FilterBuilder bare");
  });

  it("under 1500px the search takes a line of its own and the controls keep their places", () => {
    expect(css).toMatch(/@container agx-prbar \(max-width: 1499px\)\s*\{\s*\.agx-prbar-search \{[^}]*flex: 1 1 100% !important/);
  });
});
