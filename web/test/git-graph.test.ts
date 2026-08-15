/*
 * The commit graph's lane bookkeeping.
 *
 * Worth its own suite because every case below is a shape a real repository
 * makes constantly — a fork, a merge, a branch that ends — and because getting
 * one wrong does not throw: it draws a line that comes from nowhere, which
 * reads as the app being broken rather than as an off-by-one.
 */
import { describe, expect, it } from "bun:test";
import { GRAPH_H, graphWidth, laneColour, laneX, layoutGraph, linkPath, LANE_COLOURS } from "../src/lib/gitGraph.ts";

/** A linear history, newest first, as git hands it over. */
const chain = (...hashes: string[]) =>
  hashes.map((h, i) => ({ hash: h, parents: hashes[i + 1] ? [hashes[i + 1]!] : [] }));

describe("a straight history", () => {
  it("puts every commit in one lane", () => {
    const rows = layoutGraph(chain("c", "b", "a"));
    expect(rows.map((r) => r.dot)).toEqual([0, 0, 0]);
    expect(rows.every((r) => r.width === 1)).toBe(true);
  });

  it("draws one straight line through each row, and none out of the last", () => {
    const rows = layoutGraph(chain("c", "b", "a"));
    expect(rows[0]!.links).toEqual([{ from: 0, to: 0, lane: 0 }]);
    // `a` is a root: its line ends rather than continuing into nothing.
    expect(rows[2]!.links).toEqual([]);
  });

  it("marks nothing as a merge", () => {
    expect(layoutGraph(chain("c", "b", "a")).some((r) => r.merge)).toBe(false);
  });
});

describe("a merge", () => {
  /*
   *   m      merge of b and c
   *   |\
   *   b |
   *   | c
   *   |/
   *   a
   */
  const history = [
    { hash: "m", parents: ["b", "c"] },
    { hash: "b", parents: ["a"] },
    { hash: "c", parents: ["a"] },
    { hash: "a", parents: [] },
  ];

  it("is drawn hollow — a merge is the one commit whose content is not its own", () => {
    expect(layoutGraph(history)[0]!.merge).toBe(true);
  });

  it("opens a second lane for the branch it brought in", () => {
    const rows = layoutGraph(history);
    expect(rows[0]!.dot).toBe(0);
    expect(rows[0]!.width).toBe(2);
    // Two lines leave the merge row: one down its own lane, one into the new one.
    expect(rows[0]!.links.map((l) => l.to).sort()).toEqual([0, 1]);
  });

  it("closes the lane again when the two sides meet at their shared parent", () => {
    const rows = layoutGraph(history);
    // The row for `c` is where lane 1 bends back into lane 0's `a`.
    const c = rows[2]!;
    expect(c.dot).toBe(1);
    expect(c.links.some((l) => l.from === 1 && l.to === 0)).toBe(true);
    // And by the root there is one lane left.
    expect(rows[3]!.links).toEqual([]);
  });
});

describe("branches that pass by", () => {
  it("keeps a line for every branch that is not this commit", () => {
    /* The ordinary case on a busy repository: a row whose dot is in lane 0 and
       thirty other branches crossing it on their way down. Those lines are most
       of the drawing, and they come from the lane state rather than from the
       commit — which is the bookkeeping this suite exists to hold. */
    const rows = layoutGraph([
      { hash: "x", parents: ["w"] },
      { hash: "y", parents: ["w"] },   // a second tip, opens lane 1
      { hash: "w", parents: [] },
    ]);
    expect(rows[1]!.dot).toBe(1);
    // While `y` is drawn, lane 0 is still waiting for `w`: it must be drawn
    // passing through, or the line under `x` stops dead for one row.
    expect(rows[1]!.links.some((l) => l.from === 0 && l.to === 0)).toBe(true);
  });

  it("reuses a lane that has been freed rather than growing to the right", () => {
    // Two independent chains, the first ending before the second starts. Without
    // reuse the graph creeps sideways for the life of the repository.
    const rows = layoutGraph([
      { hash: "b", parents: [] },
      { hash: "d", parents: [] },
    ]);
    expect(rows[1]!.dot).toBe(0);
  });
});

describe("what the column costs", () => {
  it("is sized to the widest row on screen", () => {
    const rows = layoutGraph([
      { hash: "m", parents: ["b", "c"] },
      { hash: "b", parents: [] },
      { hash: "c", parents: [] },
    ]);
    expect(graphWidth(rows)).toBeGreaterThan(0);
  });

  it("is capped, because forty lanes is the wall of pipes this replaces", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ hash: `t${i}`, parents: [] }));
    // Every one of those is a tip, so the layout opens forty lanes...
    expect(layoutGraph(many).at(-1)!.width).toBeLessThanOrEqual(40);
    // ...and the column still refuses to eat the commit message.
    expect(graphWidth(layoutGraph(many))).toBeLessThanOrEqual(9 * 11);
  });
});

describe("colour", () => {
  it("repeats rather than inventing hues", () => {
    // Six is enough to tell two ADJACENT lines apart, which is the only job.
    expect(laneColour(0)).toBe(LANE_COLOURS[0]!);
    expect(laneColour(LANE_COLOURS.length)).toBe(LANE_COLOURS[0]!);
  });
});

describe("the drawing, which now lives outside the card", () => {
  it("spans the full row height, so one row's lines meet the next row's", () => {
    /*
     * The whole promise of moving the graph into a gutter. Inside the card it
     * was cut by a border and 4px of gap, five hundred times; outside, the only
     * thing keeping the lanes joined is that every path starts at the top edge
     * and ends at the bottom one. A path that stopped short would leave a comb
     * of dashes down the page, which is worse than the ASCII it replaced.
     */
    const straight = linkPath({ from: 0, to: 0, lane: 0 }, 8);
    expect(straight).toBe(`M${laneX(0)} 0 V${GRAPH_H}`);

    const bend = linkPath({ from: 0, to: 2, lane: 0 }, 8);
    expect(bend.startsWith(`M${laneX(0)} 0 V`)).toBe(true);
    expect(bend.endsWith(`V${GRAPH_H}`)).toBe(true);
  });

  it("runs vertically and STEPS across, rather than leaning corner to corner", () => {
    /* A row is thirty pixels tall and eleven wide per lane, so a bezier drawn
       corner to corner is nine degrees off vertical — with ten of them on screen
       you cannot tell which lane a line left and which it arrived in. Straight,
       step, straight reads as one line changing column. */
    const d = linkPath({ from: 1, to: 3, lane: 1 }, 8);
    expect(d).toContain("C");                       // the step itself
    expect((d.match(/V/g) ?? []).length).toBe(2);   // a straight run at each end
  });

  it("pins a lane past the cap to the edge instead of drawing off the page", () => {
    const far = linkPath({ from: 30, to: 30, lane: 0 }, 8);
    expect(far).toBe(`M${laneX(8)} 0 V${GRAPH_H}`);
  });
});
