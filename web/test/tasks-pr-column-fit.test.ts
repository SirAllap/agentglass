/*
 * The ClickUp table's PR and Who columns fit the widest cell in view, as pixels
 * decided once per change of the data.
 *
 * Measured in a browser on a board with a long chip ("#19407 +1" and the
 * related-link glyph, 106px wide): the PR track was a fixed 92px, so the chip
 * was cut mid-glyph at the column's edge; a card with six people drew three
 * faces and a "+3" that ran past a fixed 50px Who track.
 *
 * The first cure, `minmax(floor,max-content)` with every row a subgrid, fitted
 * them and cost the table its `content-visibility`: a headless run of 400 cards
 * over eight statuses spent 790 ms in layout while loading against 102 ms before,
 * and 15 ms against 2 on a resize. So the width is worked out from what the cells
 * hold (lib/tasksColumnFit.ts), and the rows are grids of their own again with
 * the heading's template. Read as source, like the rest of this view's guards.
 */
import { describe, expect, it } from "bun:test";
import { CELL_MAX_W, PR_FLOOR, WHO_FLOOR, prChipWidth, trackPx, whoCellWidth } from "../src/lib/tasksColumnFit.ts";
import type { CardPr } from "../src/lib/cardPrPick.ts";
import { pickCardPr } from "../src/lib/cardPrPick.ts";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const chip = await Bun.file(new URL("../src/components/CardPrChip.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();

const gridStart = src.indexOf("const cuGrid = (");
const gridEnd = src.indexOf('.join(" ");', gridStart) + '.join(" ");'.length;
const gridSrc = src.slice(gridStart, gridEnd).replace(/: boolean/g, "");
// eslint-disable-next-line no-new-func
const cuGrid: (a: boolean, b: boolean, c: boolean, d: boolean, e: boolean, pr?: number, who?: number) => string =
  new Function(`${gridSrc}\nreturn cuGrid;`)();

const rowStart = src.indexOf('<div role="row" tabIndex={0}');
const row = src.slice(rowStart, src.indexOf("{menu && (", rowStart));

// The metrics a 1500px desktop measured: 10.5px mono digits 6.3px, 9.5px sans 5.3px.
const M = { mono: 6.3, sans: 5.3 };
const pr = (number: number, extra: Partial<CardPr> = {}): CardPr =>
  ({ number, title: "Fix the thing", state: "OPEN", url: `https://github.com/acme/orbit/pull/${number}`, ...extra });

describe("the width of a chip", () => {
  it("is nothing when there is no chip", () => {
    expect(prChipWidth(pickCardPr([]), M)).toBe(0);
  });

  it("grows with the digits of the number and the count behind it", () => {
    const one = prChipWidth(pickCardPr([pr(482)]), M);
    const five = prChipWidth(pickCardPr([pr(19406)]), M);
    const plus = prChipWidth(pickCardPr([pr(19406), pr(19405)]), M);
    expect(five - one).toBeGreaterThanOrEqual(Math.floor(2 * M.mono)); // two more digits
    expect(five).toBeGreaterThan(one);
    expect(plus).toBeGreaterThan(five);
  });

  it("is wider for a card whose pull requests only name it, because of the link glyph and its count", () => {
    const own = prChipWidth(pickCardPr([pr(19406), pr(19405)]), M);
    const withRelated = prChipWidth(pickCardPr([pr(19406), pr(19405, { link: "mention" })]), M);
    expect(withRelated).toBeGreaterThan(own);
  });

  it("holds the chip the browser measured, within a few pixels", () => {
    // "#19407 +1" with the glyph measured 106px wide in a browser; this must not
    // come in under it, or the chip is cut again.
    const w = prChipWidth(pickCardPr([pr(19407), pr(19406), pr(19405, { link: "mention" })]), M);
    expect(w).toBeGreaterThanOrEqual(106);
    expect(w).toBeLessThan(CELL_MAX_W);
  });
});

describe("the width of the faces", () => {
  it("is nothing for nobody and one face for one", () => {
    expect(whoCellWidth(0, M)).toBe(0);
    expect(whoCellWidth(1, M)).toBe(19);
  });

  it("stops growing at three faces until there is a count to draw", () => {
    expect(whoCellWidth(3, M)).toBe(45);
    expect(whoCellWidth(4, M)).toBeGreaterThan(whoCellWidth(3, M));
    expect(whoCellWidth(7, M)).toBeGreaterThan(whoCellWidth(3, M));
  });
});

describe("the track", () => {
  it("never goes under the floor and never over the cap", () => {
    expect(trackPx(PR_FLOOR, 0)).toBe(PR_FLOOR);
    expect(trackPx(PR_FLOOR, 60)).toBe(PR_FLOOR);
    expect(trackPx(PR_FLOOR, 106)).toBe(106);
    expect(trackPx(PR_FLOOR, 9999)).toBe(CELL_MAX_W);
    expect(trackPx(WHO_FLOOR, 48.2)).toBe(WHO_FLOOR);
  });

  it("the table template carries the fit as pixels, with no spaces inside a track", () => {
    const t = cuGrid(true, false, false, false, false, trackPx(PR_FLOOR, 106), trackPx(WHO_FLOOR, 63)).split(" ");
    expect(t[1]).toBe("106px");
    expect(t[2]).toBe("63px");
    expect(cuGrid(true, false, false, false, false).split(" ").slice(1, 3)).toEqual(["92px", "50px"]);
    expect(cuGrid(false, false, false, false, false).split(" ")[2]).toBe("34px"); // no Who track at all
  });
});

describe("the rows stay cheap to lay out", () => {
  it("are grids of their own with the heading's template, not subgrids", () => {
    expect(row).toContain("gridTemplateColumns: grid");
    expect(src).not.toContain("SUBGRID");
    expect(src).not.toContain("subgrid");
  });

  it("keep the content-visibility the row class gives them", () => {
    expect(row).not.toContain("contentVisibility");
    expect(/\.agx-row\s*\{[^}]*content-visibility:\s*auto/.test(css)).toBe(true);
  });

  it("read the widest chip from the store, not from every row", () => {
    expect(src).toContain("useSyncExternalStore(onCardPrs, widestCardPrChip");
  });

  it("let the chip ellipsise past the cap", () => {
    expect(chip).toContain("max-w-full");
    expect(chip).toMatch(/tabular-nums font-mono leading-none truncate/);
  });
});
