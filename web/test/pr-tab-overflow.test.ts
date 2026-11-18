import { describe, expect, test } from "bun:test";
import { fitTabs } from "../src/lib/prTabOverflow.ts";

describe("fitTabs", () => {
  const w = [80, 110, 70, 60, 80, 70];
  test("everything fits: every tab, no More", () => {
    expect(fitTabs(w, 500, 0, 60)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  test("too narrow: whole tabs from the left, the rest wait behind More", () => {
    expect(fitTabs(w, 300, 0, 60)).toEqual([0, 1]);
  });
  test("the open tab is always drawn, in its place", () => {
    expect(fitTabs(w, 300, 4, 60)).toEqual([0, 4]);
  });
  test("no room at all: only the open tab", () => {
    expect(fitTabs(w, 50, 2, 60)).toEqual([2]);
  });
  test("nothing measured yet gives every tab", () => {
    expect(fitTabs([], 0, 0, 60)).toEqual([]);
  });
});
