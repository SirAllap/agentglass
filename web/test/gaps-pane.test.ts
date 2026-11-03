/*
 * The gaps and additions page: three tables that say what the redesign adds
 * and where each piece lives. The rows are the contract with the approved
 * mockup, so the count and a few of its sentences are pinned here rather than
 * left to a screenshot; and a narrow window stacks the table instead of
 * scrolling it sideways.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { GAPS_ADDED, GAPS_DECISIONS, GAPS_MISSED, GAPS_SUB, GapsPane } from "../src/components/orchestration/GapsPane.tsx";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");
const html = renderToStaticMarkup(React.createElement(GapsPane));

/** One section of the page, from its heading to the next. */
const section = (letter: string) => {
  const at = html.indexOf(`id="agx-orch-gaps-${letter}"`);
  expect(at, letter).toBeGreaterThan(-1);
  const next = html.indexOf("<h3", at);
  return html.slice(at, next < 0 ? undefined : next);
};
const rows = (letter: string) => (section(letter).match(/<tr>/g) ?? []).length;

describe("the gaps and additions page", () => {
  test("the three sections are drawn, A with its column names, and the row counts are the mockup's", () => {
    expect(GAPS_MISSED.length).toBe(31);
    for (const t of ["A · What the first mockup missed, now drawn", "B · Decisions (no function removed)", "C · Added functionality"]) {
      expect(html).toContain(t);
    }
    expect(section("a")).toContain(">Missing<");
    expect(section("a")).toContain(">In the redesign<");
    expect(section("a")).toContain(">Where<");
    // A carries a head row; B and C carry none, as the mockup draws them.
    expect(rows("a")).toBe(32);
    expect(rows("b")).toBe(GAPS_DECISIONS.length);
    expect(rows("c")).toBe(GAPS_ADDED.length);
  });

  test("every row of A ends in a chip that says where it lives", () => {
    expect((section("a").match(/agx-orch-gaps-chip/g) ?? []).length).toBe(GAPS_MISSED.length);
  });

  test("the sentences that name a control survive, so a moved control can be found in it", () => {
    for (const s of ["Team rail: 14 roles, drag to path", "One place to configure a worker", "Pin to the bench, as a PR is pinned.", "Rule priority ↑↓"]) {
      expect(html).toContain(s);
    }
  });

  test("the sub line and the first row are the approved mockup's words", () => {
    expect(GAPS_SUB).toBe("From the real code and 78 + 29 screenshots of today's app. Corrections to my first mockup: the path has FIVE blocks (not eight) and the team has 14 roles.");
    expect(GAPS_MISSED[0].missing).toBe("Envelope save bar and “Permissions not saved”");
  });

  test("the table takes its column widths from what is in it, and a chip never wraps", () => {
    const css = read("components/orchestration/orchestration.css");
    const at = css.indexOf(".agx-orch-gaps {");
    const region = css.slice(at, css.indexOf("@media (max-width: 640px)", at));
    // The mockup sets no widths: a fixed layout and a 24% Where column drew it half again as wide.
    expect(region).not.toContain("table-layout");
    expect(region).not.toMatch(/\.agx-orch-gaps-tb (th|td):nth-child\(\d\) \{ width/);
    expect(region).toContain("white-space: nowrap");
  });

  test("it has no setting and nothing to save: it is a reference, not a page of controls", () => {
    const src = read("components/orchestration/GapsPane.tsx");
    expect(src).not.toContain("SettingRow");
    expect(src).not.toContain("settingId");
    expect(src).not.toContain("onClick");
  });

  test("it is reached from Settings, right under Orchestration", () => {
    const modal = read("components/SettingsModal.tsx");
    expect(modal).toContain('{ id: "gaps", label: "Gaps and additions", group: "Agents"');
    expect(modal).toContain('{show("gaps") && <GapsPane />}');
  });

  test("a narrow window stacks the table instead of scrolling it sideways", () => {
    const css = read("components/orchestration/orchestration.css");
    const at = css.indexOf("@media (max-width: 640px)");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("\n}\n", at));
    expect(block).toContain(".agx-orch-gaps-tb thead { display: none; }");
    expect(block).toContain(".agx-orch-gaps-tb tbody tr > td { display: block;");
    expect(block).toContain('content: attr(data-label) " · "');
  });
});
