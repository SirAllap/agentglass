import { describe, expect, test } from "bun:test";
import { chipAria, chipText, forkMark, loneNote, railLinks, rowWord, stackCounts, stackRows } from "../src/lib/prStackChip.ts";
import { stackOf, type Stack } from "../src/lib/prStack.ts";

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
    expect(chipText(rows)).toBe("L4 · 5 PRs");
    expect(chipAria(rows)).toBe("Stack, level 4, 5 pull requests. Show the chain");
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

describe("siblings on one base", () => {
  /* #1042 on main; #1043 and #1044 both target its branch. A fork, not a chain. */
  const prs = [
    { number: 1042, headRefName: "orbit/thing-base", baseRefName: "main", state: "OPEN" as const },
    { number: 1043, headRefName: "orbit/thing-a", baseRefName: "orbit/thing-base", state: "OPEN" as const },
    { number: 1044, headRefName: "orbit/thing-b", baseRefName: "orbit/thing-base", state: "OPEN" as const },
  ];
  test("both children read L2 · 3 PRs, the root L1", () => {
    const at = (n: number) => chipText(stackRows(stackOf(n, prs)!, n));
    expect([at(1042), at(1043), at(1044)]).toEqual(["L1 · 3 PRs", "L2 · 3 PRs", "L2 · 3 PRs"]);
    expect(chipAria(stackRows(stackOf(1044, prs)!, 1044))).toBe("Stack, level 2, 3 pull requests. Show the chain");
  });
  test("a straight chain still counts every step", () => {
    const chain = [prs[0]!, prs[1]!, { number: 1044, headRefName: "orbit/thing-c", baseRefName: "orbit/thing-a", state: "OPEN" as const }];
    expect([1042, 1043, 1044].map((n) => chipText(stackRows(stackOf(n, chain)!, n)))).toEqual(["L1 · 3 PRs", "L2 · 3 PRs", "L3 · 3 PRs"]);
  });
});

describe("gutter rail", () => {
  const next = (n: number) => (n === 1 ? [2] : n === 2 ? [3] : []);
  const pos = (n: number) => n;
  test("links only neighbours that are next to each other in the lane", () => {
    const l = railLinks([1, 2, 9, 3], next, pos);
    expect([...l.keys()]).toEqual([1, 2]);
    expect(l.get(1)).toEqual({ pos: 1, down: true, to: null });
    expect(l.get(2)).toEqual({ pos: 2, down: false, to: 1 });
  });
  test("a middle card has a line down as well as up", () => {
    const l = railLinks([1, 2, 3], next, pos);
    expect(l.get(2)?.down).toBe(true);
    expect(l.get(3)?.down).toBe(false);
  });
  test("the order in the lane does not matter, only that they touch", () => {
    expect([...railLinks([3, 2, 1], next, pos).keys()].sort()).toEqual([1, 2, 3]);
  });
  test("a fork: each child hangs on the base, and no sibling hangs on a sibling", () => {
    /* #1042 is the base of #1043 and #1044. */
    const kids = (n: number) => (n === 1042 ? [1043, 1044] : []);
    const l = railLinks([1042, 1043, 1044], kids, pos);
    expect(l.get(1043)?.to).toBe(1042);
    expect(l.get(1044)?.to).toBe(1042);
    expect(l.get(1042)?.to).toBeNull();
    expect([...l.values()].some((v) => v.to === 1043 || v.to === 1044)).toBe(false);
    expect(l.get(1044)?.down).toBe(false);
  });
  test("a fork child with a foreign card between it and the base draws no line", () => {
    const kids = (n: number) => (n === 1042 ? [1043, 1044] : []);
    const l = railLinks([1042, 1043, 9, 1044], kids, pos);
    expect([...l.keys()]).toEqual([1042, 1043]);
  });
  test("children above their base hang on it too", () => {
    const kids = (n: number) => (n === 1042 ? [1043, 1044] : []);
    const l = railLinks([1043, 1044, 1042], kids, pos);
    expect([l.get(1043)?.to, l.get(1044)?.to]).toEqual([1042, 1042]);
  });
  test("a lane with no stack pair has no rail", () => {
    expect(railLinks([5, 6], next, pos).size).toBe(0);
  });
});

describe("fork and lone marks", () => {
  test("the root of a fork says how many children", () => {
    expect(forkMark([1043, 1044])).toBe("2 children");
    expect(forkMark([1043])).toBeNull();
    expect(forkMark([])).toBeNull();
  });
  test("a card alone in its column says what it hangs on and who its sibling is", () => {
    expect(loneNote(1042, [1044])).toBe("on #1042 · sibling #1044");
    expect(loneNote(1042, [])).toBe("on #1042");
    expect(loneNote(null, [1044])).toBeNull();
  });
  test("a grandchild reads one level below its parent, not its aunt", () => {
    const prs = [
      { number: 1, headRefName: "o/root", baseRefName: "main", state: "OPEN" as const },
      { number: 2, headRefName: "o/a", baseRefName: "o/root", state: "OPEN" as const },
      { number: 3, headRefName: "o/b", baseRefName: "o/root", state: "OPEN" as const },
      { number: 4, headRefName: "o/c", baseRefName: "o/b", state: "OPEN" as const },
    ];
    const s = stackOf(4, prs)!;
    expect(chipText(stackRows(s, 4))).toBe("L3 · 4 PRs");
    expect(s.base).toMatchObject({ kind: "pr", number: 3 });
  });
});
