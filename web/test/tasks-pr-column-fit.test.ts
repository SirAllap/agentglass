/*
 * The ClickUp table's PR and Who columns size to the widest cell in view.
 *
 * Measured in a browser on a board with a long chip ("#19407 +1" and the
 * related-link glyph, 106px wide): the PR track was a fixed 92px, so the chip
 * was cut mid-glyph at the column's edge; a card with six people drew three
 * faces and a "+3" that ran past a fixed 50px Who track. The tracks are now
 * `minmax(floor,max-content)`, which only means "the widest cell" if the
 * heading and every row share ONE grid: each row used to be a grid of its own,
 * and a max-content track in a hundred grids is a hundred widths. So the rows
 * are subgrids of one table grid. Read as source, like the rest of this view's
 * guards.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const chip = await Bun.file(new URL("../src/components/CardPrChip.tsx", import.meta.url)).text();

const gridStart = src.indexOf("const cuGrid = (");
const gridEnd = src.indexOf('.join(" ");', gridStart) + '.join(" ");'.length;
const gridSrc = src.slice(gridStart, gridEnd).replace(/: boolean/g, "");
// eslint-disable-next-line no-new-func
const cuGrid: (a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) => string =
  new Function(`${gridSrc}\nreturn cuGrid;`)();

const rowStart = src.indexOf('<div role="row" tabIndex={0}');
const row = src.slice(rowStart, src.indexOf("{menu && (", rowStart));
const headStart = src.indexOf("${EYEBROW} sticky top-0");
const head = src.slice(headStart, src.indexOf("</div>", headStart));

describe("PR and Who columns fit their widest cell", () => {
  it("has a floor and no ceiling on the PR and Who tracks", () => {
    const t = cuGrid(true, false, false, false, false).split(" ");
    expect(t[1]).toBe("minmax(92px,max-content)");
    expect(t[2]).toBe("minmax(50px,max-content)");
    expect(cuGrid(true, true, true, true, true)).not.toMatch(/(^| )(92|50)px( |$)/);
  });

  it("keeps the floor when nothing is in the column", () => {
    // No Who track at all when nobody is assigned, and the PR floor is still there.
    const t = cuGrid(false, false, false, false, false).split(" ");
    expect(t[1]).toBe("minmax(92px,max-content)");
    expect(t).not.toContain("minmax(50px,max-content)");
  });

  it("draws the heading, the groups and the rows as subgrids of one table grid", () => {
    expect(src).toContain("gridTemplateColumns: `${grid} 0px`");
    expect(head).toContain("...SUBGRID");
    expect(row).toContain("...SUBGRID");
    expect((src.match(/\.\.\.SUBGRID, marginTop/g) ?? []).length).toBe(2);
    expect(row).not.toContain("gridTemplateColumns: grid");
    expect(head).not.toContain("gridTemplateColumns: grid");
  });

  it("turns off the row's content-visibility, which would make the subgrid a grid of its own", () => {
    expect(row).toContain('contentVisibility: "visible"');
  });

  it("caps the cell, and the chip ellipsises past the cap", () => {
    expect((row.match(/maxWidth: CELL_MAX_W/g) ?? []).length).toBe(2); // PR cell and Who cell
    expect(chip).toContain("max-w-full");
    expect(chip).toMatch(/tabular-nums font-mono leading-none truncate/);
  });
});
