/*
 * The ClickUp table: no per-row "open" column, and one hairline per column
 * boundary, at the same x in the heading and in every row (measured in a
 * browser: 7 rules, identical x, 0px inset). The rules were drawn before two columns only, and the rows drew
 * short segments that did not meet the heading's, so the table looked
 * unfinished. Read as source, like the rest of this view's guards.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();

const gridStart = src.indexOf("const cuGrid = (");
const gridEnd = src.indexOf('.join(" ");', gridStart) + '.join(" ");'.length;
const gridSrc = src.slice(gridStart, gridEnd).replace(/: boolean/g, "");
// eslint-disable-next-line no-new-func
const cuGrid: (a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) => string =
  new Function(`${gridSrc}\nreturn cuGrid;`)();

const headStart = src.indexOf("${EYEBROW} sticky top-0");
const head = src.slice(headStart, src.indexOf("</div>", headStart));
const rowStart = src.indexOf('<div role="row" tabIndex={0}');
const row = src.slice(rowStart, src.indexOf("{menu && (", rowStart));

describe("the ClickUp table", () => {
  it("has no 40px open-button track", () => {
    expect(cuGrid(true, true, true, true, false)).not.toContain("40px");
    expect(cuGrid(true, true, true, true, false).split(" ").length).toBe(9);
  });

  it("draws no per-row open link", () => {
    expect(row).not.toContain("target=\"_blank\"");
    expect(row).not.toContain("↗</a>");
  });

  it("puts one rule on every column boundary, in heading and rows, and none twice", () => {
    // Task|PR is the frozen Task cell's own edge; Who, Squad, Sprint, Cmts,
    // Due, Est, Pts each draw the one on their left. PR draws none: a second
    // line there was the double rule between TASK and PR.
    expect((head.match(/agx-colrule/g) ?? []).length).toBe(7);
    expect((row.match(/agx-colrule/g) ?? []).length).toBe(7);
    expect(head).toMatch(/<span className="text-center" style=\{COL_RULE\}>PR<\/span>/);
    expect(row).not.toMatch(/agx-colrule[^\n]*\n[^\n]*prPick/);
  });

  it("gives heading and rows one grid, one gap and one right inset", () => {
    expect(head).toContain("gridTemplateColumns: grid, gap: 16");
    expect(row).toContain("gridTemplateColumns: grid, gap: 16");
    expect(src).toContain("`pr-4 ${EYEBROW} sticky top-0");
    expect(row).toMatch(/className="agx-row [^"]*\bpr-4\b/);
    // the rows carry no vertical padding of their own: the cells do, so a
    // rule stretches the full height of the row
    expect(row.match(/className="agx-row [^"]*"/)![0]).not.toMatch(/\bpy-/);
  });

  it("draws the rule as a pseudo-element in the gap, never a border on the cell", () => {
    const def = src.slice(src.indexOf("const COL_RULE"), src.indexOf("};", src.indexOf("const COL_RULE")));
    expect(def).not.toMatch(/border|margin|LINE/);
    expect(head + row).not.toContain("borderLeft");
    expect(css).toMatch(/\.agx-colrule::before\s*\{[^}]*left: -8px;[^}]*top: 0;[^}]*bottom: 0;[^}]*width: 1px/);
  });

  it("makes the frozen Task cell the Task|PR rule, at the gap middle, heading and rows alike", () => {
    for (const sel of [".agx-stick", ".agx-stick-head"]) {
      const at = css.indexOf(`\n${sel} {`);
      const block = css.slice(at, css.indexOf("}", at));
      expect(block).toContain("margin-right: -8px");
      expect(block).toContain("padding-right: 8px");
      expect(block).toContain("align-self: stretch");
      expect(block).toContain("box-shadow: 1px 0 0 var(--surface-line)");
    }
  });
});
