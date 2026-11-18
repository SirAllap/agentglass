/*
 * The pure selection set behind bulk picking (x, the row's own checkbox, the bulk bar): selectionModel.ts.
 */
import { describe, expect, test } from "bun:test";
import { EMPTY_SELECTION, toggleSelected } from "../src/components/jira/list/selectionModel.ts";

describe("toggleSelected", () => {
  test("adds an id that is not there", () => {
    const next = toggleSelected(EMPTY_SELECTION, "1042");
    expect([...next]).toEqual(["1042"]);
  });

  test("removes an id that is there, leaving the rest", () => {
    const some = toggleSelected(toggleSelected(EMPTY_SELECTION, "1042"), "1050");
    const next = toggleSelected(some, "1042");
    expect([...next]).toEqual(["1050"]);
  });

  test("never mutates the set it was given", () => {
    const start = toggleSelected(EMPTY_SELECTION, "1042");
    toggleSelected(start, "1050");
    expect([...start]).toEqual(["1042"]);
  });
});
