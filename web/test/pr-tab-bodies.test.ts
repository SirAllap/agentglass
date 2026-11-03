/**
 * The four tab bodies against the approved mockup. There is no renderer in this project, so a rule
 * about what a tab draws is asserted against the source of the function that draws it, sliced to its
 * own closing brace, comment lines stripped.
 */
import { describe, expect, it } from "bun:test";

const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const rail = await Bun.file(new URL("../src/components/FileRail.tsx", import.meta.url)).text();

/** A top-level function (or `export function`), from its signature to the closing brace at column 0. */
function body(src: string, signature: string): string {
  const at = src.indexOf(signature);
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end + 3).split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
}

describe("Files: the tree reads as the mockup's list", () => {
  const glyph = body(panel, "function statusGlyph(");
  const tree = body(panel, "function FileTree(");
  it("marks a file with the letter git uses", () => {
    for (const ch of ['"A"', '"D"', '"R"', '"C"', '"M"']) expect(glyph).toContain(`ch: ${ch}`);
    expect(glyph).not.toContain('"±"');
  });
  it("has a viewed tick on every row, and its counts", () => {
    expect(tree).toContain('role="checkbox"');
    expect(tree).toContain("onSeen?.(f.path)");
    expect(tree).toContain("+{f.additions}");
  });
  it("puts the keyboard legend on the toolbar with the mockup's words", () => {
    expect(panel).toContain("j/k files · n/p hunks · [ ] threads · x viewed · Ctrl+F search");
  });
  it("draws the rail's Merge in the dock's green, not the primary", () => {
    const merge = rail.slice(rail.indexOf('<Sec title="Merge">'));
    expect(merge).toContain('allClear ? "var(--success)" : "transparent"');
    expect(merge).not.toContain('allClear ? "var(--primary)" : "transparent"');
  });
});

describe("Conversation: the toolbar is the mockup's, every verb present", () => {
  const conv = body(panel, "function Conversation(");
  it("has order, person, steps, jump, mark read and digest", () => {
    expect(conv).toContain('label="Order"');
    expect(conv).toContain('aria-label="Filter by person"');
    expect(conv).toContain("Previous remark");
    expect(conv).toContain("Next remark");
    expect(conv).toContain("Jump to new");
    expect(conv).toContain("Mark read");
    expect(conv).toContain("Digest");
  });
  it("names the lanes All, People and Bots, always, and on the kit's track skin", () => {
    expect(conv).toContain('label="Whose remarks"');
    expect(conv).toContain("People ${humanCount}");
    expect(conv).toContain("Bots ${botCount}");
    expect(conv).not.toContain("`Humans ");
  });
  it("keeps a verb with nothing under it, disabled", () => {
    expect(conv).toContain("disabled={!atoms.length}");
    expect(conv).toContain("disabled={lanes.bots.length === 0}");
  });
  it("gives every remark a react button in its header", () => {
    const card = body(panel, "function Card(");
    expect(card).toContain('label="React"');
  });
});

describe("Checks: toolbar toggles, lanes, one bulk verb, a Log on the row", () => {
  const checks = body(panel, "export function Checks(");
  it("has the three toggles and the filter", () => {
    for (const w of ["Needs attention", "Show skipped", "Group by workflow", "Filter checks"]) expect(checks).toContain(w);
    expect(checks).toContain("setGrouped");
    expect(checks).toContain("setAttnOnly");
  });
  it("has Rerun failed once, beside the lanes, and says why there is no Rerun all", () => {
    expect(checks.match(/Rerun failed/g)?.length).toBe(1);
    expect(panel).toContain('The mockup also has "Rerun all".');
  });
  it("puts a Log button on a row that has a job, and the link to GitHub in the opened row", () => {
    expect(checks).toContain(">Log</Button>");
    expect(checks).toContain("Open on GitHub");
  });
});

describe("Commits: day words and one line per commit", () => {
  const tab = panel.slice(panel.indexOf('{tab === "commits" && d.commits.length > 0 && ('), panel.indexOf('{tab === "files" && d.files.length === 0'));
  it("heads a day in words, not in capitals", () => {
    expect(tab).toContain("commitDayLabel(");
    expect(tab).not.toContain("uppercase tracking-wider");
  });
  it("copies the hash from the row", () => {
    expect(tab).toContain("Copy the full hash");
  });
});
