import { describe, expect, test } from "bun:test";
import { abandonLost, discardLostLine, dirtyTracked, hardResetLost, resolvedFiles, conflictQuestion, conflictSquares, holdBlocks, lostList, nextStep, onlyHereLine, resetLost, placesLabel, settledLine, type ConflictRow } from "../src/lib/gitDangerModal.ts";

const rows: ConflictRow[] = [
  { rel: "src/a.ts", places: 2, settled: 2, open: false },
  { rel: "src/b.ts", places: 3, settled: 1, open: true },
  { rel: "lock.json", places: null, settled: null, open: true },
];

describe("hold", () => {
  test("held or disabled blocks the press", () => {
    expect(holdBlocks(true)).toBe(true);
    expect(holdBlocks(false, true)).toBe(true);
    expect(holdBlocks(false)).toBe(false);
  });
});

describe("lost", () => {
  test("caps the names and counts the rest", () => {
    const l = lostList(["a", "b", "c", "d", "e", "f"], "file");
    expect(l.shown).toHaveLength(4);
    expect(l.more).toBe(2);
    expect(l.line).toBe("6 files you answered here go.");
  });
  test("one and none read right", () => {
    expect(lostList(["a"], "file").line).toBe("1 file you answered here goes.");
    expect(lostList([], "file").line).toContain("Nothing");
  });
  test("abandon says there is no undo only when something is lost", () => {
    expect(abandonLost(["a"]).body).toContain("no undo");
    expect(abandonLost([]).body).toContain("not answered anything");
  });
});

describe("lost lists read the real state", () => {
  test("resolved = files git has settled, by anyone", () => {
    expect(resolvedFiles(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
    expect(resolvedFiles(["a"], ["a"])).toEqual([]);
  });
  test("abandon body does not repeat the lost line", () => {
    const l = abandonLost(["a"]);
    expect(l.body).not.toContain(l.line);
  });
  test("discard says what goes", () => {
    expect(discardLostLine("a.ts", 3)).toBe("3 uncommitted changes in a.ts go.");
    expect(discardLostLine("a.ts", 1)).toBe("1 uncommitted change in a.ts go.");
    expect(discardLostLine("a.ts", 0)).toContain("Uncommitted changes in a.ts");
  });
  test("hard reset lists commits and dirty files, even with no commits", () => {
    const r = hardResetLost(["c3 Add"], ["x.ts"])!;
    expect(r.items).toEqual(["c3 Add", "x.ts"]);
    expect(hardResetLost([], ["x.ts"])!.line).toBe("1 uncommitted file is overwritten.");
    expect(hardResetLost([], [])).toBeNull();
    expect(hardResetLost(null, ["x.ts"])!.line).toContain("not counted");
  });
  test("dirtyTracked skips untracked and dedupes", () => {
    const t = { staged: [{ file_path: "/r/a", status: "modified" }], unstaged: [{ file_path: "/r/a", status: "modified" }, { file_path: "/r/n", status: "untracked" }] };
    expect(dirtyTracked(t, (c) => c.file_path.slice(3))).toEqual(["a"]);
  });
});

describe("conflict", () => {
  test("question leads with the count", () => {
    expect(conflictQuestion(3)).toBe("Which side wins in 3 files?");
    expect(conflictQuestion(1)).toBe("Which side wins in 1 file?");
    expect(conflictQuestion(0)).toContain("Every conflict");
  });
  test("squares and counts agree", () => {
    expect(conflictSquares(rows, "src/b.ts")).toEqual(["settled", "current", "open"]);
    expect(settledLine(rows)).toBe("1 of 3 files settled");
  });
  test("places per file", () => {
    expect(rows.map(placesLabel)).toEqual(["2/2", "1/3", ""]);
  });
  test("next step", () => {
    expect(nextStep({ left: 0, fileAnswered: 0, fileTotal: 0, commitWord: "commit" })).toContain("Review");
    expect(nextStep({ left: 2, fileAnswered: 1, fileTotal: 3, commitWord: "commit" })).toContain("2 open places");
    expect(nextStep({ left: 2, fileAnswered: 3, fileTotal: 3, commitWord: "commit" })).toContain("Resolve this file");
    expect(nextStep({ left: 2, fileAnswered: 0, fileTotal: 0, commitWord: "commit" })).toBe("Pick a file on the left.");
  });
});

describe("resetLost / onlyHereLine", () => {
  const log = [
    { hash: "c3c3c3c", shortHash: "c3c3c3", subject: "Add thing" },
    { hash: "b2b2b2b", shortHash: "b2b2b2", subject: "Fix thing" },
    { hash: "a1a1a1a", shortHash: "a1a1a1", subject: "Start" },
  ];
  test("lists commits newer than the target", () => {
    const r = resetLost(log, "b2b2b2")!;
    expect(r.items).toEqual(["c3c3c3 Add thing"]);
    expect(r.line).toContain("1 commit is dropped");
  });
  test("target not in window gives null", () => expect(resetLost(log, "ffffff")).toBeNull());
  test("target at tip drops no commits", () => expect(resetLost(log, "c3c3c3")!.items).toEqual([]));
  test("only-here wording", () => {
    expect(onlyHereLine(2)).toContain("2 commits on it are on no other branch");
    expect(onlyHereLine(0)).toContain("also on another");
  });
});

import { partiallyStaged as _ps, hardResetShows as _hs, hardResetLost as _hl } from "../src/lib/gitDangerModal.ts";
import { test as _t, expect as _e } from "bun:test";
_t("review: partly staged files are named", () => { _e(_ps(["a", "b"], ["b", "c"])).toEqual(["b"]); _e(_ps(["a"], [])).toEqual([]); });
_t("hard reset line shows when commits unknown and tree clean", () => { _e(_hs(_hl(null, []), null)).toBe(true); _e(_hs(_hl([], []), [])).toBe(false); });
