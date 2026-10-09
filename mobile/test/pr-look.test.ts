/*
 * How lists across repositories group.
 *
 * The lists showed one repository at a time behind a picker, so "is anything
 * waiting on me" was asked once per repository. They open on all of them now,
 * grouped; this holds the grouping rule. What a row says is prCard.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { flatten } from "../src/model/prLook.ts";

describe("grouping", () => {
  const groups = [
    { root: "/w/orbit", name: "orbit", items: [1, 2] },
    { root: "/w/lantern", name: "lantern", items: [] as number[] },
    { root: "/w/atlas", name: "atlas-api", items: [3] },
  ];
  test("a heading per repository, and none over an empty one", () => {
    expect(flatten(groups)).toEqual([
      { heading: "orbit", count: 2 }, { item: 1, root: "/w/orbit" }, { item: 2, root: "/w/orbit" },
      { heading: "atlas-api", count: 1 }, { item: 3, root: "/w/atlas" },
    ]);
  });
  test("one repository needs no heading: the chip already says which", () => {
    expect(flatten([groups[0]!])).toEqual([{ item: 1, root: "/w/orbit" }, { item: 2, root: "/w/orbit" }]);
  });
});
