// Searching every file of a review at once. The browser's Ctrl+F cannot: files
// fold when marked viewed and the diff is windowed, so half the matches are in
// nodes that do not exist. What is pinned here is the line arithmetic — a match
// reported on the wrong line sends you to the wrong place, which is worse than
// not finding it.
import { describe, expect, test } from "bun:test";
import type { FileChange } from "../../shared/types.ts";
import { excerpt, findInDiffs, groupByFile } from "../src/lib/diffFind.ts";

const file = (path: string, lines: string[], oldStart = 10, newStart = 10): { path: string; change: FileChange } => ({
  path,
  change: {
    id: 1, timestamp: 0, source_app: "", session_id: "", tool: "", file_path: path,
    additions: 0, deletions: 0,
    hunks: [{ oldStart, oldLines: lines.length, newStart, newLines: lines.length, lines }],
  } as FileChange,
});

describe("findInDiffs", () => {
  test("finds a word and reports the line it is on", () => {
    const f = file("a.py", [" import os", " def go():", "     return os.path"]);
    const m = findInDiffs([f], "os.path");
    expect(m).toHaveLength(1);
    expect(m[0]!.line).toBe(12);
    expect(m[0]!.side).toBe("RIGHT");
  });

  test("added and removed lines count on their own side", () => {
    // old: 10 ctx, 11 removed        new: 10 ctx, 11 added
    const f = file("a.py", [" ctx", "-gone target", "+here target"]);
    const m = findInDiffs([f], "target");
    expect(m.map((x) => [x.side, x.line])).toEqual([["LEFT", 11], ["RIGHT", 11]]);
  });

  test("a removed line does not advance the new-side count", () => {
    const f = file("a.py", [" a", "-b", " target"]);
    // new side: 10 = a, 11 = target — the removal is not there.
    expect(findInDiffs([f], "target")[0]!.line).toBe(11);
  });

  test("git's no-newline marker is not a line of the file", () => {
    const f = file("a.py", [" target", "\\ No newline at end of file"]);
    expect(findInDiffs([f], "newline")).toHaveLength(0);
  });

  test("case-insensitive, because nobody remembers the casing of a symbol", () => {
    const f = file("a.py", [" CallFacade"]);
    expect(findInDiffs([f], "callfacade")).toHaveLength(1);
  });

  test("one letter is not a search", () => {
    // Every line matches "a"; a result set nobody can walk is not an answer.
    const f = file("a.py", [" a", " b", " a"]);
    expect(findInDiffs([f], "a")).toHaveLength(0);
    expect(findInDiffs([f], "  ")).toHaveLength(0);
  });

  test("bounded, so a broad query cannot produce a list nobody can use", () => {
    const many = Array.from({ length: 40 }, () => " target");
    expect(findInDiffs([file("a.py", many)], "target", 10)).toHaveLength(10);
  });

  test("files keep the order they were given, matches the order they appear", () => {
    const a = file("a.py", [" target one", " x", " target two"]);
    const b = file("b.py", [" target three"]);
    expect(findInDiffs([b, a], "target").map((m) => m.path)).toEqual(["b.py", "a.py", "a.py"]);
  });

  test("a file with no diff loaded is skipped rather than throwing", () => {
    expect(findInDiffs([{ path: "a.py", change: undefined }], "target")).toEqual([]);
  });
});

describe("groupByFile", () => {
  test("consecutive matches in one file become one group", () => {
    const a = file("a.py", [" target", " target"]);
    const b = file("b.py", [" target"]);
    const g = groupByFile(findInDiffs([a, b], "target"));
    expect(g.map((x) => [x.path, x.matches.length])).toEqual([["a.py", 2], ["b.py", 1]]);
  });
});

describe("excerpt", () => {
  test("splits the line around the hit", () => {
    const m = findInDiffs([file("a.py", [" the target here"])], "target")[0]!;
    const e = excerpt(m);
    expect(e.hit).toBe("target");
    expect(e.before).toBe("the ");
    expect(e.after).toBe(" here");
  });

  test("a hit far along a long line is brought into view", () => {
    const long = " " + "x".repeat(400) + "target";
    const m = findInDiffs([file("a.py", [long])], "target")[0]!;
    const e = excerpt(m, 60);
    expect(e.hit).toBe("target");
    expect(e.before.startsWith("…")).toBe(true);
    expect(e.before.length).toBeLessThan(40);
  });
});
