/*
 * The board has no view pills. Needs my review, Failing and Ready were filters
 * over cards already in hand; the lanes say the same (the first lane is what
 * needs a review, the red one is blocked, the green one can land), so the
 * filter, its state and its counts are gone. Open is the whole board.
 */
import { describe, expect, it } from "bun:test";
import { BOARD_IS_WIDE } from "../src/lib/prLanes.ts";

const read = (rel: string) => Bun.file(new URL(rel, import.meta.url)).text();
const board = await read("../src/components/TriageBoard.tsx");
const panel = await read("../src/components/PrPanel.tsx");
const lanes = await read("../src/lib/prLanes.ts");

describe("no board views", () => {
  it("the filter code is gone from the lanes, the board and the panel", () => {
    for (const src of [board, panel, lanes]) {
      expect(src).not.toMatch(/viewKeeps|viewIsWide|BoardView|boardViewCounts|\bsetBoardView\b/);
    }
    expect(panel).not.toContain("const VIEWS:");
    expect(board).not.toContain("view = \"all\"");
  });
  it("the panel pills are Open, Closed, Inbox and CI, and no lane pill", () => {
    for (const label of ["Open", "Closed", "Inbox", "CI"]) expect(panel).toContain(`label: "${label}"`);
    for (const gone of ["Needs my review", "Failing", "Ready"]) expect(panel).not.toContain(`label: "${gone}"`);
  });
});

describe("the board holds only the viewer's stake", () => {
  it("never reaches past the viewer's two queues", () => {
    expect(BOARD_IS_WIDE).toBe(false);
  });
  it("opening the board asks the list for the queue scope, never the repository's", () => {
    expect(panel).toContain('const scope = queuesOnlyRef.current ? "review" : filter;');
    expect(panel).toContain("api.prList(root, scope, stateSel, force, cursor, serverQuery)");
  });
});
