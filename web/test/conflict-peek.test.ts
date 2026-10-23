import { describe, expect, it } from "bun:test";
import { peekRows } from "../src/lib/conflictPeek.ts";

const block = (index: number, line: number, ours: string[], theirs: string[]) => ({
  index, line, ours, theirs, ourLabel: "HEAD", theirLabel: "orbit-1042",
});
const text = (from: number, n: number) => ({ kind: "text" as const, from, lines: Array.from({ length: n }, (_, i) => `line ${from + i}`) });

describe("peekRows", () => {
  it("shows a conflict with two lines of context and a gap for the rest", () => {
    const rows = peekRows({
      segments: [text(1, 10), { kind: "conflict", index: 0 }, text(16, 10)],
      blocks: [block(0, 11, ["mine"], ["yours"])],
    });
    expect(rows.map((r) => r.kind)).toEqual([
      "gap", "ctx", "ctx", "marker", "ours", "marker", "theirs", "marker", "ctx", "ctx", "gap",
    ]);
    expect(rows[0]).toEqual({ kind: "gap", hidden: 8 });
    expect(rows[1]).toMatchObject({ n: 9, text: "line 9" });
    expect(rows[4]).toMatchObject({ n: 12, text: "mine" });
    expect(rows[6]).toMatchObject({ n: 14, text: "yours" });
  });

  it("does not show the lines between two close conflicts twice", () => {
    const rows = peekRows({
      segments: [{ kind: "conflict", index: 0 }, text(5, 3), { kind: "conflict", index: 1 }],
      blocks: [block(0, 1, ["a"], ["b"]), block(1, 8, ["c"], ["d"])],
    });
    const ctx = rows.filter((r) => r.kind === "ctx").map((r) => (r as { n: number }).n);
    expect(ctx).toEqual([5, 6, 7]);
    expect(rows.some((r) => r.kind === "gap")).toBe(false);
  });

  it("keeps the base side when git wrote one", () => {
    const rows = peekRows({
      segments: [{ kind: "conflict", index: 0 }],
      blocks: [{ ...block(0, 1, ["a"], ["b"]), base: ["o"] }],
    });
    expect(rows.map((r) => r.kind)).toEqual(["marker", "ours", "marker", "base", "marker", "theirs", "marker"]);
  });

  it("is empty for a file with no conflicts", () => {
    expect(peekRows({ segments: [], blocks: [] })).toEqual([]);
  });
});
