/*
 * The ClickUp table: no per-row "open" column, and one hairline per column
 * boundary. The rules were drawn before two columns only, and the rows drew
 * short segments that did not meet the heading's, so the table looked
 * unfinished. Read as source, like the rest of this view's guards.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

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

  it("puts the shared rule on every column after the first, in heading and rows", () => {
    // PR, Who, Squad, Sprint, Cmts, Due, Est, Pts
    expect((head.match(/style=\{COL_RULE\}|\.\.\.COL_RULE/g) ?? []).length).toBe(8);
    expect((row.match(/style=\{COL_RULE\}|\.\.\.COL_RULE/g) ?? []).length).toBe(8);
  });

  it("draws the rule from the house token, once", () => {
    const def = src.slice(src.indexOf("const COL_RULE"), src.indexOf("};", src.indexOf("const COL_RULE")));
    expect(def).toContain("borderLeft: LINE");
    expect(head + row).not.toContain("borderLeft: LINE");
  });
});
