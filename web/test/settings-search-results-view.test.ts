/*
 * Three bugs found on the first screenshot of the results view, in the same
 * file (the app has no renderer to test the DOM against — see AGENTS.md's
 * "Tests" section — so, as with every other settings-search test, the
 * decision is pulled out of the source and asserted there):
 *
 *  - typing "sound" left "Pull request checks" / "Pull request conversation"
 *    / "From your desktop" standing over nothing: `Group` is a heading with
 *    no card of its own, so Section's own `:has(.agx-settings-rows:empty)`
 *    fix never reaches it — its rows are siblings, not children it wraps.
 *  - ↑/↓ moved `highlight` with nothing on screen to show for it.
 *  - the header counted `rowResults` (every page a query answers) over a
 *    screen that only ever shows the top 5.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const modal = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname, "utf8");
const css = readFileSync(new URL("../src/index.css", import.meta.url).pathname, "utf8");

describe("a Group with every row filtered away takes its own heading with it", () => {
  test("Group's own element carries the class the CSS hides it by", () => {
    const from = modal.indexOf("function Group(");
    const body = modal.slice(from, modal.indexOf("\n}", from));
    expect(body).toContain("agx-settings-group-heading");
  });

  test("the CSS rule hides a heading with nothing between it and the next one, or the end", () => {
    expect(css).toMatch(/\.agx-settings-group-heading:has\(\+ \.agx-settings-group-heading\)/);
    expect(css).toMatch(/\.agx-settings-group-heading:last-child/);
  });
});

describe("the highlighted search result is marked, not just scrolled", () => {
  // The results moved out of the page into the panel beside the nav, so the
  // mark moved with them: the page underneath sits behind a scrim and a class
  // on a row there would be invisible.
  const panel = readFileSync(new URL("../src/components/SettingsSearchPanel.tsx", import.meta.url).pathname, "utf8");

  test("the selected hit carries a data attribute, and the effect scrolls that very node into view", () => {
    expect(panel).toContain('data-sel={sel === i ? "true" : undefined}');
    expect(panel).toContain("aria-selected={sel === i}");
    const at = panel.indexOf("scrollIntoView");
    expect(at).toBeGreaterThan(-1);
    expect(panel.slice(Math.max(0, at - 120), at)).toContain('[data-sel="true"]');
  });

  test("the mark is drawn: a tint and an outline, not only a scroll", () => {
    const at = css.indexOf(".agx-sp-hit[data-sel]");
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("}", at) + 1);
    expect(rule).toMatch(/background:/);
    expect(rule).toMatch(/box-shadow:/);
  });
});

describe("the results header counts what is actually on screen", () => {
  test("the count and the plural come from the same model the rows are drawn from", () => {
    const panel = readFileSync(new URL("../src/components/SettingsSearchPanel.tsx", import.meta.url).pathname, "utf8");
    // searchSummary(model, q) reads model.flat, which is also what the panel maps over to draw rows.
    expect(panel).toContain("{searchSummary(model, q)}");
    expect(panel).toContain("model.pages.map(");
    expect(modal).toContain("const searchModel = useMemo(() => groupSearch(ql, tabs, matchIn)");
    expect(modal).toContain("model={searchModel}");
    expect(modal).not.toContain("rowResults.length");
  });
});
