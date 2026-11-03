import { describe, expect, test } from "bun:test";
import { chipAria, chipText, railLinks, rowWord, stackCounts, stackRows } from "../src/lib/prStackChip.ts";
import type { Stack } from "../src/lib/prStack.ts";

/* Two merged bases under three open pull requests, the shape of a schema change landed in steps. */
const stack = {
  position: 1, size: 3, letter: null, siblings: [], base: null, next: [], trunk: "main", broken: null, spine: [],
  tiers: [
    [{ kind: "merged", label: "", number: 1101 }],
    [{ kind: "merged", label: "", number: 1102 }],
    [{ kind: "cur", label: "1", number: 1103 }],
    [{ kind: "oth", label: "2", number: 1104 }],
    [{ kind: "off", label: "3", number: 1105 }],
    [{ kind: "missing", label: "?" }],
  ],
} as unknown as Stack;

describe("stack chip", () => {
  test("counts every numbered member, merged ones included, bottom first", () => {
    const rows = stackRows(stack, 1104);
    expect(rows.map((r) => r.number)).toEqual([1101, 1102, 1103, 1104, 1105]);
    expect(chipText(rows)).toBe("4/5");
    expect(chipAria(rows)).toBe("Stack, 4 of 5. Show the chain");
    expect(stackCounts(rows)).toEqual({ merged: 2, open: 3 });
  });

  test("a box with no pull request is not a row", () => {
    expect(stackRows(stack, 1103).some((r) => r.kind === "missing")).toBe(false);
  });

  test("the state word follows the column", () => {
    const row = (kind: "oth" | "merged" | "closed") => ({ number: 1, pos: 1, kind, me: false });
    expect(rowWord(row("merged"), undefined)).toEqual({ word: "merged", tone: "merged" });
    expect(rowWord(row("closed"), undefined).word).toBe("closed");
    expect(rowWord(row("oth"), { number: 1, state: "OPEN", draft: true, onBoard: true }).word).toBe("draft");
    expect(rowWord(row("oth"), { number: 1, state: "OPEN", draft: false, onBoard: true, lane: "land" })).toEqual({ word: "ready", tone: "ok" });
    expect(rowWord(row("oth"), { number: 1, state: "OPEN", draft: false, onBoard: true, lane: "blocked" }).tone).toBe("bad");
    expect(rowWord(row("oth"), undefined).word).toBe("open");
  });
});

describe("gutter rail", () => {
  const next = (n: number) => (n === 1 ? [2] : n === 2 ? [3] : []);
  const pos = (n: number) => n;
  test("links only neighbours that are next to each other in the lane", () => {
    const l = railLinks([1, 2, 9, 3], next, pos);
    expect([...l.keys()]).toEqual([1, 2]);
    expect(l.get(1)).toEqual({ pos: 1, down: true });
    expect(l.get(2)).toEqual({ pos: 2, down: false });
  });
  test("a middle card has a line down as well as up", () => {
    const l = railLinks([1, 2, 3], next, pos);
    expect(l.get(2)?.down).toBe(true);
    expect(l.get(3)?.down).toBe(false);
  });
  test("the order in the lane does not matter, only that they touch", () => {
    expect([...railLinks([3, 2, 1], next, pos).keys()].sort()).toEqual([1, 2, 3]);
  });
  test("a lane with no stack pair has no rail", () => {
    expect(railLinks([5, 6], next, pos).size).toBe(0);
  });
});
