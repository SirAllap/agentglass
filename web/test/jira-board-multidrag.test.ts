/**
 * Dragging one of several selected cards carries them all, and a card whose own steps refuse the column is still
 * named in the batch's last line instead of being dropped unseen (the drop used to filter it out before the batch
 * ever ran, so two selected cards in one column moved as one when the second had no step to the target).
 */
import { describe, expect, test } from "bun:test";
import { dragBatchIds, dropTargets } from "../src/components/jira/list/boardBatchModel.ts";

const order = ["a", "b", "c", "d"];

describe("dragBatchIds", () => {
  test("a selection of 2, drag started on one of them: both are in the batch, in board order", () => {
    expect(dragBatchIds(order, new Set(["c", "a"]), "c")).toEqual(["a", "c"]);
    expect(dragBatchIds(order, new Set(["c", "a"]), "a")).toEqual(["a", "c"]);
  });
  test("a card outside the selection goes alone", () => {
    expect(dragBatchIds(order, new Set(["a", "b"]), "d")).toEqual(["d"]);
  });
  test("a selection of one is just that card", () => {
    expect(dragBatchIds(order, new Set(["b"]), "b")).toEqual(["b"]);
  });
});

describe("dropTargets", () => {
  test("a refused card stays in the batch while another accepts, so its refusal is reported", () => {
    expect(dropTargets(["a", "b"], [true, false])).toEqual(["a", "b"]);
  });
  test("all refused sends nothing", () => {
    expect(dropTargets(["a", "b"], [false, false])).toEqual([]);
  });
});
