/*
 * The pull request screens say "nothing" once, calmly, instead of drawing a box
 * per empty field: source pins that the old strings are gone and the new pattern
 * (EmptyState, Collapse) is what draws them.
 */
import { describe, expect, it } from "bun:test";
import { detailRows } from "../src/lib/prOverviewBody.ts";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const panel = await read("components/PrPanel.tsx");
const rail = await read("components/FileRail.tsx");
const card = await read("components/PrCard.tsx");

describe("PR Details sidebar", () => {
  it("no longer prints a box per empty field", () => {
    for (const old of ['"None yet"', '"No one assigned"', '"No milestone"', ">No reviewers<"]) {
      expect(panel).not.toContain(old.replace(/^"|"$/g, "") === "No milestone" ? `: "No milestone")` : old);
    }
    expect(panel).not.toContain('fold ? "None" : "None yet"');
    expect(panel).not.toContain('fold ? "None" : "No milestone"');
  });
  it("says Nobody asked yet for reviewers, and one quiet None for each unset rail field", () => {
    expect(panel).toContain('<EmptyState tone="warn">Nobody asked yet</EmptyState>');
    expect(panel).toMatch(/const sLabels = \(\s*<PrRailSection title="Labels"[\s\S]{0,700}<span className="prov-none">None<\/span>/);
    expect(detailRows({ assignees: [], milestone: null, linkedIssues: [], state: "OPEN" }, {}).map((r) => [r.key, r.value, r.none]))
      .toEqual([["assignee", "None", true], ["milestone", "None", true]]);
    expect(panel).toContain("const rows = detailRows(d,");
  });
});

describe("PR review rail", () => {
  it("says Clean once instead of three empty sections", () => {
    expect(rail).toContain("const quiet =");
    expect(rail).toContain('<EmptyState tone="ok"');
    expect(rail).not.toContain('Sec title="Nothing selected"');
  });
});

describe("Triage board PR card", () => {
  it("says Quiet so far, not No review activity yet", () => {
    expect(card).toContain("Quiet so far");
    expect(card).not.toContain("No review activity yet");
    expect(card).not.toContain(">No card<");
    expect(card).not.toContain("No tracker</span>");
  });
});
