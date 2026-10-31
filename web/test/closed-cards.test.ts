/*
 * The Closed tab is the board's cards, and each finished card says what is left on this computer. The line is
 * decided in lib/leftovers.ts; these pin its words, who gets it, and that the list no longer draws its own rows.
 */
import { describe, expect, test } from "bun:test";
import { leftoverLine, type LeftoverState } from "../src/lib/leftovers.ts";

const some = (items: number, bytes: number): LeftoverState => ({ kind: "some", items, bytes, groups: [{ group: "worktree", items, bytes }] });
const read = (f: string) => Bun.file(new URL(f, import.meta.url)).text();
const board = await read("../src/components/TriageBoard.tsx");
const list = await read("../src/components/ClosedList.tsx");
const card = await read("../src/components/PrCard.tsx");

describe("the line a finished card shows about this computer", () => {
  test("nothing left is a quiet sentence, not silence", () => {
    expect(leftoverLine({ kind: "none" }, false)?.text).toBe("No leftovers");
    expect(leftoverLine({ kind: "none" }, false)?.tone).toBe("none");
  });
  test("something left says how many and how big", () => {
    expect(leftoverLine(some(4, 221_000_000), false)).toMatchObject({ tone: "some" });
    expect(leftoverLine(some(4, 221_000_000), false)?.text).toMatch(/^Leftovers: 4 items · \d+/);
    expect(leftoverLine(some(1, 0), false)?.text).toBe("Leftovers: 1 item");
  });
  test("a running cleanup wins over what the inventory said", () => {
    expect(leftoverLine(some(4, 10), true)?.tone).toBe("run");
    expect(leftoverLine({ kind: "none" }, true)?.tone).toBe("run");
  });
  test("still reading, failed or never asked draws no claim", () => {
    expect(leftoverLine({ kind: "computing" }, false)).toBeNull();
    expect(leftoverLine({ kind: "unknown", why: "x" }, false)).toBeNull();
    expect(leftoverLine(undefined, false)).toBeNull();
  });
});

describe("the Closed tab is cards", () => {
  test("the list draws what it is given and no rows of its own", () => {
    expect(list).toContain("card(p)");
    expect(list).not.toMatch(/agx-cl-row|agx-cl-item|columnsFor/);
  });
  test("every closed card on the page asks the local inventory, whoever wrote it", () => {
    const at = board.indexOf("<ClosedList rows={rows}");
    const body = board.slice(at, board.indexOf("}} />", at));
    expect(body).toContain("root={root}");
    expect(body).not.toContain("closedOfPerson");
  });
  test("the card draws the line only when the view has one", () => {
    expect(card).toContain("cv.leftover && (");
  });
  test("the branch glyph in the route chips is the readable size, not the floor", () => {
    const at = card.indexOf("  const route = (");
    const route = card.slice(at, card.indexOf("\n  );\n", at));
    expect(route).not.toContain("<BranchIcon size={ICON.xs}");
    expect(route.match(/<BranchIcon size=\{ICON\.sm\} \/>/g)?.length).toBe(2);
  });
  test("the cleanup state of a card follows the run, not a timer", () => {
    expect(board).toContain("useCleaning(root, p.number)");
  });
});
