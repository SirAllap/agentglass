/*
 * The card open in the dock wears the same accent border as a picked card, so a Ctrl+click on a second card read as
 * "two picked" while the set held one, and a drag moved only the card it started on. The first Ctrl/Shift+click
 * now takes the open card in with it.
 */
import { describe, expect, test } from "bun:test";
import { seedWithOpen } from "../src/components/jira/list/selectionModel.ts";
import { dragBatchIds } from "../src/components/jira/list/boardBatchModel.ts";

describe("seedWithOpen", () => {
  test("an empty set takes the open card in", () => {
    expect([...seedWithOpen(new Set(), "ORBIT-11", "ORBIT-12")]).toEqual(["ORBIT-11"]);
  });
  test("a set that already has cards is left as it is", () => {
    expect([...seedWithOpen(new Set(["ORBIT-14"]), "ORBIT-11", "ORBIT-12")]).toEqual(["ORBIT-14"]);
  });
  test("no open card, or the clicked card is the open one: unchanged", () => {
    expect(seedWithOpen(new Set(), null, "ORBIT-12").size).toBe(0);
    expect(seedWithOpen(new Set(), "ORBIT-12", "ORBIT-12").size).toBe(0);
  });
  test("open ORBIT-11, Ctrl+click ORBIT-12, drag ORBIT-12: both move", () => {
    const s = new Set(seedWithOpen(new Set(), "ORBIT-11", "ORBIT-12")); s.add("ORBIT-12");
    expect(dragBatchIds(["ORBIT-11", "ORBIT-12", "ORBIT-13"], s, "ORBIT-12")).toEqual(["ORBIT-11", "ORBIT-12"]);
  });
});
