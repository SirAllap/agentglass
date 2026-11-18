/*
 * The board's own extras on top of the shared card selection (jira/list/boardBatchModel.ts): Shift+click's range
 * within a column, and the line a batch move ends with. `toggleSelected`/`EMPTY_SELECTION` are the shared module's
 * own and already covered in jira-selection.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { batchResultLine, rangeSelected } from "../src/components/jira/list/boardBatchModel.ts";

describe("rangeSelected", () => {
  const order = ["a", "b", "c", "d", "e"];
  test("forward: anchor to the later id, inclusive", () => {
    expect([...rangeSelected(order, "b", "d")]).toEqual(["b", "c", "d"]);
  });
  test("backward: the same range, direction does not matter", () => {
    expect([...rangeSelected(order, "d", "b")].sort()).toEqual(["b", "c", "d"]);
  });
  test("anchor and id the same: just the one card", () => {
    expect([...rangeSelected(order, "c", "c")]).toEqual(["c"]);
  });
  test("the anchor is gone from this column: falls back to just the id clicked", () => {
    expect([...rangeSelected(order, "gone", "c")]).toEqual(["c"]);
  });
});

describe("batchResultLine", () => {
  test("every card moved: the plain count", () => {
    expect(batchResultLine(3, [])).toBe("3 moved");
  });
  test("one refused: named, with its own reason", () => {
    expect(batchResultLine(2, [{ key: "ORBIT-1042", reason: "no transition" }])).toBe("2 moved · 1 could not (ORBIT-1042: no transition)");
  });
  test("more than one refused: each named", () => {
    const failed = [{ key: "ORBIT-1", reason: "No step to Done" }, { key: "ORBIT-2", reason: "Needs details — use Move to…" }];
    expect(batchResultLine(1, failed)).toBe("1 moved · 2 could not (ORBIT-1: No step to Done; ORBIT-2: Needs details — use Move to…)");
  });
  test("none moved: zero is still said plainly", () => {
    expect(batchResultLine(0, [{ key: "ORBIT-9", reason: "No step to Done" }])).toBe("0 moved · 1 could not (ORBIT-9: No step to Done)");
  });
});
