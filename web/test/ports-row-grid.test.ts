// The list has to look like a list.
//
// Flex sized every cell from its own contents, so a row carrying two badges
// put its checkout pill at a different x than a row carrying one — and
// pointing at a row made the action buttons appear and shove everything left.
// No single row was wrong; the column had no shape, which is the same defect
// the Source control lists had.
//
// Measured after the fix with a real browser: eleven rows, six columns, 0px of
// deviation in every one, and 0 cells moving on hover. This test is the
// cheaper guard that keeps it that way.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Importing the panel reaches api.ts, which reads `location` at module scope
// and throws under bun. The same shim every other web test here uses; without
// it the failure is a ReferenceError from a file this test never mentions.
(globalThis as unknown as { location: URL }).location ??= new URL("http://localhost:5173/");

const { PORT_GRID } = await import("../src/components/MachinePanel.tsx");

describe("a port row's columns are reserved, not negotiated", () => {
  /**
   * Splitting on whitespace tears `minmax(0, 1fr)` in half and reports seven
   * columns where there are six — the same mistake as splitting tmux's
   * `list-keys` output on spaces, and it fails the same way: confidently, with
   * a wrong answer rather than an error.
   */
  const cols = (() => {
    const out: string[] = [];
    let depth = 0, cur = "";
    for (const ch of PORT_GRID.trim()) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  })();

  test("every cell in the row has a column of its own", () => {
    // dot, port, name, flags, checkout, actions
    expect(cols).toHaveLength(6);
  });

  test("the badge and checkout columns are fixed, so they line up across rows", () => {
    // `auto` here is what let a row's contents decide where its neighbour
    // starts, which is exactly the thing being prevented.
    expect(cols[3]).toMatch(/^\d+px$/);
    expect(cols[4]).toMatch(/^\d+px$/);
  });

  test("the actions column exists whether or not the pointer is over the row", () => {
    /**
     * The one that stops the hover jump. A zero-width or conditional last
     * column would bring the defect straight back: the buttons would have
     * nowhere to go and would push the row's contents aside on appearing.
     */
    const actions = cols[5]!;
    expect(actions).toMatch(/^\d+px$/);
    expect(Number.parseInt(actions, 10)).toBeGreaterThan(0);
  });

  test("only the name column flexes", () => {
    // Everything else being fixed is what makes the columns agree; the name is
    // the one thing that should absorb a narrower window.
    expect(cols[2]).toContain("1fr");
    expect(cols.filter((c) => c.includes("fr"))).toHaveLength(1);
  });
});

/*
 * A fixed track is not a clip.
 *
 * The columns above stopped the row negotiating its own layout, and that held.
 * What it did not stop was a cell *painting outside* the track it was given: a
 * grid track sized `132px` will happily render a 190px child, and because these
 * cells are right-aligned the overflow goes leftwards, over the column before.
 *
 * That is what shipped. The checkout pill carried `max-w-[190px]` inside the
 * 132px checkout track, so a worktree name sat on top of the "on the network"
 * badge. Measured in a real browser at 1400px: the pill ran 1127→1298 while the
 * badge track ended at 1154 — 27px of one control drawn over another.
 *
 * The fix is on the cells, not the tracks, which is why it needs its own guard:
 * the columns can be perfectly correct while this is broken.
 */
const PANEL_SRC = readFileSync(new URL("../src/components/MachinePanel.tsx", import.meta.url), "utf8");
/**
 * Just the port row.
 *
 * Bounded at the next top-level declaration rather than run to the end of the
 * file, which is what it did first — and the moment a second row component was
 * added below it (LockRow), "the cells of the port row" quietly became "every
 * right-aligned cell in the panel" and the count assertion below failed on code
 * that was correct. A guard that widens as the file grows stops being a guard
 * about anything.
 */
const ROW = (() => {
  // Anchored on the declaration, not the parameter list, which grows: matching
  // the full signature meant `indexOf` returned -1 the first time a prop was
  // added, `slice(-1)` handed back the file's last character, and both
  // assertions below then passed judgement on a single newline. Throwing is the
  // point — a guard that cannot find its subject must say so, not report on
  // nothing.
  const from = PANEL_SRC.indexOf("function Row({");
  if (from < 0) throw new Error("MachinePanel no longer declares a Row component — this guard needs re-aiming");
  const rest = PANEL_SRC.slice(from);
  const next = rest.indexOf("\nfunction ", 1);
  return next < 0 ? rest : rest.slice(0, next);
})();

describe("nothing paints outside its column", () => {

  test("the checkout pill is capped by its column, not by a number", () => {
    // A px cap is how this broke: it is written next to the pill and read
    // nowhere near the track, so the two drift the moment either moves.
    expect(ROW).not.toMatch(/rounded-full max-w-\[\d+px\]/);
    expect(ROW).toContain("max-w-full");
  });

  test("every right-aligned cell that holds a pill clips rather than spills", () => {
    // justify-end plus no clipping is the exact recipe: content wider than the
    // track grows towards the column before it.
    //
    // Only the cells with pills in them. The actions column is right-aligned
    // too and holds three icon buttons of a known size — clipping it would hide
    // a button rather than prevent a collision, which is a worse answer than
    // the problem.
    const ends = [...ROW.matchAll(/className="flex items-center justify-end[^"]*"/g)];
    const withPills = ends.filter((m) => ROW.slice(m.index!, m.index! + 900).includes("rounded-full"));
    expect(withPills.length, "the badge cell and the checkout cell").toBe(2);
    for (const m of withPills) expect(m[0]).toContain("overflow-hidden");
  });
});
