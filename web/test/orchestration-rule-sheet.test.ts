/*
 * The rule sheet's grammar, read from source: one step row for every chain, its
 * columns decided in one place, and one control per job that adds a step. A
 * regression here is visible on the screen as rows of different widths and the
 * remove button dropping under the tile, so it is cheaper to assert than to
 * photograph.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "src", "components", "orchestration");
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SHEET = strip(readFileSync(join(DIR, "RuleForm.tsx"), "utf8"));
const CSS = readFileSync(join(DIR, "orchestration.css"), "utf8");

describe("the rule sheet has one row grammar", () => {
  test("every step is the same row component, and it is written once", () => {
    expect(SHEET.split('className="agx-rule-step"').length - 1).toBe(1);
    expect(SHEET.split("<StepRow ").length - 1).toBe(1);
    expect(SHEET).toContain("<StepRow key={i}");
  });

  test("the row's columns are fixed in the stylesheet, not per row in the markup", () => {
    const rule = CSS.slice(CSS.indexOf(".agx-rule-step {"), CSS.indexOf("}", CSS.indexOf(".agx-rule-step {")));
    expect(rule).toContain("grid-template-columns: 18px minmax(0, 1fr) 168px 28px 28px 28px");
    expect(rule).not.toContain("flex-wrap");
    // The model field's width lives in the class; a per-row width is what made the tiles 774/730/645 wide.
    expect(SHEET).not.toMatch(/agx-rule-model[^\n]*width:\s*\d/);
  });

  test("a job adds a step from one menu, never from a grid of tiles", () => {
    expect(SHEET).not.toContain("EngineTiles");
    expect(SHEET.split("<AddStep ").length - 1).toBe(1);
    expect(SHEET).toContain('aria-haspopup="menu"');
    expect(SHEET).toContain("<AnchoredMenu");
  });

  test("jobs fold, and the one with steps starts open", () => {
    expect(SHEET).toContain("openJobs");
    expect(SHEET).toContain("aria-expanded={bodyOpen}");
    expect(SHEET).toContain('initial?.orchestrator ? "orchestrator" : ROLE_IDS.find((r) => initial?.workers?.[r])');
  });
});
