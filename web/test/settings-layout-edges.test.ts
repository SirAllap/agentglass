/*
 * Layout edges found in a narrow window and a wide one, asserted as source
 * because there is no renderer here. Each was measured in headless Chrome
 * before the change:
 *
 *   · the ClickUp header was a two-column grid whose right column is
 *     max-content, so below ~900px the left column came out 0px wide and the
 *     read-only card lay over the account line;
 *   · a step card's header gave its title whatever the badges left, 172px at
 *     1440 and 0px in a 1000px window, so the title wrapped a word per line;
 *   · the map's two columns only stacked under a 760px VIEWPORT, but the
 *     settings column is capped at 760px, so they never had room in between;
 *   · More under a toggle row drew a divider between it and its own row.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");

describe("ClickUp header", () => {
  const pane = src("components/ClickUpPane.tsx");
  const at = pane.indexOf('aria-label="Connection"');
  const head = pane.slice(at, at + 400);

  it("wraps instead of being a two-track grid with an auto column", () => {
    expect(head).toContain("flex flex-wrap");
    expect(head).not.toContain("gridTemplateColumns");
  });
});

describe("workflow map step cards", () => {
  const css = src("components/workflowMapStyle.ts");

  it("the step header wraps and the title keeps a floor", () => {
    expect(css).toMatch(/\.wfm-sh\{display:flex;flex-wrap:wrap;/);
    expect(css).toMatch(/\.wfm-sh>:nth-child\(2\)\{flex:1 1 200px;min-width:0\}/);
    expect(css).not.toMatch(/\.wfm-sh\{display:grid/);
  });

  it("stacks by the settings column's width, not the viewport's", () => {
    expect(css).toMatch(/@container agx-settings \(max-width:\d+px\)\{\.wfm-grid\{grid-template-columns:minmax\(0,1fr\)\}/);
  });
});

describe("More under an operable settings row", () => {
  it("is not given the divider every other sibling gets", () => {
    const css = src("index.css");
    expect(css).toMatch(/\.agx-settings-rows > \.agx-settings-more \{ border-top: 0; \}/);
    expect(src("components/SettingRow.tsx")).toContain('className="agx-settings-more ');
  });
});
