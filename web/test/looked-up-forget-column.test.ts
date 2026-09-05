/*
 * The "forget this one" x on a Looked-up row used to be `position: absolute`,
 * drawn over the row's last two cells (the points count and the ↗ open link)
 * with only its opacity answering hover. It now has its own track in the
 * row's grid — reserved whenever the section can show it, empty when a row
 * has no need to draw it, same rule every other secondary control here
 * follows.
 *
 * These tests bite the grid's SHAPE — how many tracks `cuGrid` actually
 * returns, evaluated from the live source rather than a copy of its logic —
 * not a class name. A revert to an absolutely-positioned overlay would drop
 * the `forget` parameter and the extra track with it, which is what each
 * assertion below depends on.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

// Pull the real `cuGrid` body out of the source and make it callable, so the
// track count comes from the code that ships, not a re-typed expectation.
const gridStart = src.indexOf("const cuGrid = (");
const gridEnd = src.indexOf('.join(" ");', gridStart) + '.join(" ");'.length;
// Strip the TS param types `new Function` cannot parse; the logic itself is
// left untouched, so a change to the columns still shows up here.
const gridSrc = src.slice(gridStart, gridEnd).replace(/: boolean/g, "");
// eslint-disable-next-line no-new-func
const cuGrid: (who: boolean, squad: boolean, sprint: boolean, est: boolean, forget: boolean) => string =
  new Function(`${gridSrc}\nreturn cuGrid;`)();

const tracks = (s: string) => s.trim().split(/\s+/);

describe("the looked-up row's grid", () => {
  it("adds exactly one track when a row can be forgotten", () => {
    const without = tracks(cuGrid(false, false, false, false, false));
    const withForget = tracks(cuGrid(false, false, false, false, true));
    expect(withForget.length).toBe(without.length + 1);
  });

  it("the added track is real width, not a zero-width placeholder", () => {
    const withForget = tracks(cuGrid(false, false, false, false, true));
    expect(withForget.at(-1)).toBe("30px");
  });

  it("holds regardless of which optional columns are on", () => {
    const without = tracks(cuGrid(true, true, true, true, false));
    const withForget = tracks(cuGrid(true, true, true, true, true));
    expect(withForget.length).toBe(without.length + 1);
    expect(withForget.at(-1)).toBe("30px");
  });
});

describe("the table header tracks the same extra column", () => {
  const headStart = src.indexOf('${EYEBROW} sticky top-0');
  const headEnd = src.indexOf("</div>", headStart);
  const head = src.slice(headStart, headEnd);

  it("adds its own trailing cell only when the section can show the forget button", () => {
    expect(head).toContain("{onLooked && <span />}");
  });
});

describe("the forget button sits in the grid, not on top of it", () => {
  const rowStart = src.indexOf("function ClickUpRow(");
  const rowEnd = src.indexOf("\nfunction ", rowStart + 1);
  const row = src.slice(rowStart, rowEnd);

  const btnStart = row.indexOf("{onForget &&");
  const btnEnd = row.indexOf(")}", btnStart);
  const btn = row.slice(btnStart, btnEnd);

  it("is a real grid child, not an absolutely positioned overlay", () => {
    expect(btnStart).toBeGreaterThan(-1);
    expect(btn).not.toMatch(/className="[^"]*\babsolute\b[^"]*"/);
    expect(btn).not.toContain('position: "absolute"');
  });

  it("only its opacity moves on hover — same rule as the ↗ chip beside it", () => {
    expect(btn).toContain("agx-onrow");
    expect(btn).not.toContain("group-hover:opacity");
  });
});
