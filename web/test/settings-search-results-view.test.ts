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
  test("the highlight effect adds a class to the row's own DOM node", () => {
    const at = modal.indexOf("highlightedEl.current?.classList.remove");
    expect(at).toBeGreaterThan(-1);
    const block = modal.slice(at, modal.indexOf("}, [highlight, ql, visibleResults]);", at));
    expect(block).toContain('classList.add("agx-row-current")');
    expect(block).toContain("querySelector");
    expect(block).toContain("data-row=");
  });

  test("the class is defined, using the same tint the mouse hover already does", () => {
    const hoverAt = css.indexOf(".agx-hover:hover");
    expect(hoverAt).toBeGreaterThan(-1);
    const hoverRule = css.slice(hoverAt, css.indexOf("}", hoverAt) + 1);
    const [, hoverBg] = hoverRule.match(/background:\s*([^;]+);/) ?? [];
    expect(hoverBg).toBeTruthy();

    const at = css.indexOf(".agx-row-current");
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("}", at) + 1);
    expect(rule).toContain(hoverBg!);
  });
});

describe("the results header counts what is actually on screen", () => {
  test("the header's count and plural both read visibleResults, not rowResults", () => {
    const at = modal.indexOf("absentHit ? absentHit.say");
    expect(at).toBeGreaterThan(-1);
    const block = modal.slice(at, modal.indexOf("also: {synonymsUsed", at));
    expect(block).not.toContain("rowResults.length");
    expect((block.match(/visibleResults\.length/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
