/*
 * How much of the frame the board's scroll area gets, and what the chrome
 * around it is allowed to take.
 *
 * The mock (screens 28 and 45) leaves the board 74-77% of a 360x800 frame and
 * spends 52 on the bar, 45 on the lane strip and 44 on a header icon. The
 * screen it replaced spent a row on the search field, another on the Board/List
 * switch, a line on "Refreshed 9:41", and two more inside every lane on a title
 * and a drawer that said "Nothing hidden" — the cards got about 45%.
 *
 * ── why the numbers are computed rather than photographed ────────────────
 * There is no emulator in this repository's test path; the measurement that
 * matters here is arithmetic on the same constants the screens read, which is
 * why they live in src/model/boardChrome.ts instead of in five style objects.
 * A photograph proves today's phone; this stops the chrome from growing back.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BOARD_FRAME, boardShare, STRIP_H, VIEW_ROW_H } from "../src/model/boardChrome.ts";

const strip = readFileSync(new URL("../src/board/LaneStrip.tsx", import.meta.url), "utf8");
const lane = readFileSync(new URL("../src/board/LaneColumn.tsx", import.meta.url), "utf8");
const bar = readFileSync(new URL("../src/nav/TabBar.tsx", import.meta.url), "utf8");
const screen = readFileSync(new URL("../app/(tabs)/prs.tsx", import.meta.url), "utf8");
const active = readFileSync(new URL("../src/review/PrActiveFilters.tsx", import.meta.url), "utf8");

/** The four things the mock was measured at, minus what a phone draws. */
const share = (height: number, inset: number): number =>
  boardShare({ height, inset, inFlow: [BOARD_FRAME.statusBar, BOARD_FRAME.header, STRIP_H, BOARD_FRAME.nav] });

describe("the board's frame", () => {
  test("360x800 leaves the scroll area three quarters of the frame", () => {
    expect(share(800, 16)).toBeGreaterThanOrEqual(0.74);
    expect(share(800, 16)).toBeLessThanOrEqual(0.79);
  });

  test("390x844 leaves it the same share", () => {
    expect(share(844, 16)).toBeGreaterThanOrEqual(0.74);
    expect(share(844, 16)).toBeLessThanOrEqual(0.79);
  });

  test("the bar is 52, and the strip 45 under 44-high tabs", () => {
    expect(BOARD_FRAME.nav).toBe(52);
    expect(STRIP_H).toBe(45);
    expect(bar).toMatch(/export const BAR_HEIGHT = BOARD_FRAME\.nav/);
    expect(strip).toMatch(/height: STRIP_H,/);
    expect(strip).toMatch(/minHeight: STRIP_H - 1,/);
  });

  test("a lane draws no title row: the strip already says which lane it is", () => {
    // Two answers to "where am I" cost 48 points of cards and can disagree.
    expect(lane).not.toMatch(/>\s*\{lane\.label\}\s*</);
    // The row that is drawn is drawn only while it has something to say.
    expect(lane).toMatch(/const ruler = onSync !== undefined \|\| lane\.hidden\.length > 0;/);
    expect(lane).not.toMatch(/Nothing hidden/);
  });

  test("the refresh line is out of flow", () => {
    // It is a hint about a gesture, not a row of the list.
    expect(screen).toMatch(/position: "absolute"/);
    expect(screen).not.toMatch(/Refreshed \$\{clockOf/);
  });

  test("the saved-view row is out of the board's chrome: views live in the filter sheet", () => {
    // The mock's s28 has no row of view chips above the cards; s30 keeps them
    // in the sheet. 48 is the row of filters in force (`.factive`), which is
    // drawn only while a filter is on.
    expect(VIEW_ROW_H).toBe(48);
    expect(active).toMatch(/minHeight: VIEW_ROW_H/);
    expect(screen).not.toMatch(/Save this view<\/Text>/);
    // The sheet offers them only where they narrow something: a saved view is
    // the board's, and the grouped list has no board to narrow.
    expect(screen).toMatch(/views=\{showingBoard \? viewRow : undefined\}/);
  });

  test("the search field is collapsed until it is asked for", () => {
    expect(screen).toMatch(/searchOpen/);
  });
});
