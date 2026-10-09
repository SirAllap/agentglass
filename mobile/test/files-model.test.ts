/*
 * What the Files screen decides, asserted without a screen: what a search box
 * asks the computer, where Back goes from each state, which files count as
 * "changed on this branch", how a hit is cut around its match and how Find
 * steps through a file.
 */
import { describe, expect, test } from "bun:test";
import type { ChangeRow } from "../../shared/types.ts";
import {
  START, backTarget, changedFiles, changedLine, changedNote, changedUnder, diffParams, dirOf, findLabel, findMatches,
  groupHits, hitParts, hitSummary, nameResults, recentMatching, remembered, searchPlan, stepMatch, type FilesState,
} from "../src/model/files.ts";

const ROOT = "/work/orbit";
const row = (path: string, over: Partial<ChangeRow> = {}): ChangeRow => ({
  key: `${ROOT}\0${path}`, repoRoot: ROOT, branch: "orbit-1042-sync-retry", path, status: "modified", staged: "none",
  additions: 1, deletions: 1, binary: false, tooBig: false, changedAt: 0, ignored: false, outside: false, ...over,
});
const at = (over: Partial<FilesState>): FilesState => ({ ...START, ...over });

describe("search plan", () => {
  test("Name asks /files/find with the box, trimmed and encoded", () => {
    const p = searchPlan(ROOT, "  push ts ", "name");
    expect(p).toEqual({ kind: "find", path: `/files/find?root=${encodeURIComponent(ROOT)}&q=push%20ts` });
  });

  test("Text asks /files/grep, and not for one letter (the server answers nothing to it)", () => {
    expect(searchPlan(ROOT, "RETRIES", "text").kind).toBe("grep");
    expect(searchPlan(ROOT, "R", "text").kind).toBe("short");
    expect(searchPlan(ROOT, " R ", "text").kind).toBe("short");
  });

  test("an empty box asks nothing, except on Recent, which is local", () => {
    expect(searchPlan(ROOT, "  ", "name").kind).toBe("idle");
    expect(searchPlan(ROOT, "", "text").kind).toBe("idle");
    expect(searchPlan(ROOT, "Push", "recent")).toEqual({ kind: "recent", needle: "push" });
    expect(searchPlan(ROOT, "", "recent")).toEqual({ kind: "recent", needle: "" });
  });
});

describe("Back goes to the parent first", () => {
  test("from a file opened in its folder, to that folder", () => {
    const s = at({ rel: "src/sync", open: "src/sync/push.ts" });
    expect(backTarget(s)).toEqual(at({ rel: "src/sync", open: null }));
  });

  test("from a file opened by a link at the top, to the folder it lives in", () => {
    expect(backTarget(at({ rel: "", open: "src/sync/push.ts" }))?.rel).toBe("src/sync");
  });

  test("from a file opened from results, to the results, with the query kept", () => {
    const s = at({ rel: "src", open: "src/sync/push.ts", fromSearch: true, query: "RETRIES", mode: "text" });
    expect(backTarget(s)).toEqual(at({ rel: "src", open: null, fromSearch: false, query: "RETRIES", mode: "text" }));
  });

  test("a file opened by a link in goes straight back, not up through folders nobody visited", () => {
    const s = at({ rel: "src/sync/deep/er", open: "src/sync/deep/er/push.ts", arrived: true });
    expect(backTarget(s)).toBeNull();
  });

  test("the find bar closes before anything else", () => {
    const s = at({ rel: "src", open: "src/a.ts", finding: true });
    expect(backTarget(s)).toEqual({ ...s, finding: false });
  });

  test("a search clears before the folder goes up; Recent counts as a search", () => {
    expect(backTarget(at({ rel: "src/sync", query: "x" }))).toEqual(at({ rel: "src/sync" }));
    expect(backTarget(at({ rel: "src/sync", mode: "recent" }))).toEqual(at({ rel: "src/sync" }));
  });

  test("a folder goes up one level at a time, and only the top leaves", () => {
    expect(backTarget(at({ rel: "src/sync" }))?.rel).toBe("src");
    expect(backTarget(at({ rel: "src" }))?.rel).toBe("");
    expect(backTarget(at({ rel: "" }))).toBeNull();
  });
});

describe("changed on this branch", () => {
  test("working tree first, a file in both listed once as the working tree has it", () => {
    const list = changedFiles(ROOT,
      [row("src/sync/config.ts"), row("src/sync/todo.txt", { status: "untracked" })],
      [row("src/sync/push.ts", { additions: 9, deletions: 3, commit: { hash: "c0c2de1", subject: "s", author: "ada", at: 1 } }),
        row("src/sync/config.ts", { commit: { hash: "9a632b8", subject: "s", author: "ada", at: 1 } })]);
    expect(list.map((c) => [c.path, c.committed])).toEqual([
      ["src/sync/config.ts", false], ["src/sync/todo.txt", false], ["src/sync/push.ts", true],
    ]);
  });

  test("another checkout's rows and ignored files are left out", () => {
    const list = changedFiles(ROOT, [row("a.ts", { repoRoot: "/work/other" }), row("b.ts", { ignored: true }), row("c.ts")], []);
    expect(list.map((c) => c.path)).toEqual(["c.ts"]);
  });

  test("opened on a folder inside the checkout, paths are relative to it and what is outside is dropped", () => {
    const list = changedFiles(`${ROOT}/src`, [row("src/sync/push.ts"), row("docs/sync.md")], []);
    expect(list.map((c) => [c.path, c.repoPath, c.repoRoot])).toEqual([["sync/push.ts", "src/sync/push.ts", ROOT]]);
  });

  test("a folder lists its own changes, the top lists all", () => {
    const list = changedFiles(ROOT, [row("src/sync/a.ts"), row("src/b.ts"), row("docs/c.md")], []);
    expect(changedUnder(list, "").length).toBe(3);
    expect(changedUnder(list, "src").map((c) => c.path)).toEqual(["src/sync/a.ts", "src/b.ts"]);
    expect(changedUnder(list, "src/sync").map((c) => c.path)).toEqual(["src/sync/a.ts"]);
    expect(changedUnder(list, "sr").length).toBe(0);
  });

  test("a row says where it is and how much, in the mock's words", () => {
    const [wt, nw, cm] = changedFiles(ROOT,
      [row("src/sync/config.ts"), row("src/sync/todo.txt", { status: "untracked" })],
      [row("src/sync/push.ts", { additions: 9, deletions: 3 })]);
    expect(changedLine(wt!)).toBe("src/sync · +1 −1");
    expect(changedLine(nw!)).toBe("src/sync · new");
    expect(changedLine(cm!)).toBe("src/sync · +9 −3 · committed");
    expect(changedNote(wt)).toBe("Modified since last commit");
    expect(changedNote(cm)).toBe("Changed on this branch");
    expect(changedNote(nw)).toBe("New, not committed");
    expect(changedNote(undefined)).toBeNull();
  });

  test("See diff opens the commit's diff for a committed file and the working tree's otherwise", () => {
    const [wt, cm] = changedFiles(ROOT, [row("a.ts")], [row("b.ts", { commit: { hash: "c0c2de1", subject: "s", author: "ada", at: 1 } })]);
    expect(diffParams(wt!)).toEqual({ root: ROOT, path: "a.ts" });
    expect(diffParams(cm!)).toEqual({ root: ROOT, path: "b.ts", hash: "c0c2de1" });
  });
});

describe("search results", () => {
  const hit = (rel: string, line: number, text: string, at: number) => ({ rel, line, text, at, len: 7 });

  test("hits are gathered by file in the order the server found them", () => {
    const g = groupHits([hit("src/sync/config.ts", 1, "x", 0), hit("src/sync/push.ts", 1, "x", 0), hit("src/sync/push.ts", 3, "y", 0)]);
    expect(g.map((x) => [x.name, x.dir, x.hits.length])).toEqual([["config.ts", "src/sync", 1], ["push.ts", "src/sync", 2]]);
  });

  test("the summary counts, and says when the server stopped counting", () => {
    expect(hitSummary(3, 2, false)).toBe("3 matches in 2 files");
    expect(hitSummary(1, 1, false)).toBe("1 match in 1 file");
    expect(hitSummary(200, 41, true)).toBe("200+ matches in 41+ files");
    expect(hitSummary(0, 0, false)).toBe("No matches");
  });

  test("a hit loses its indentation and the match moves with it", () => {
    expect(hitParts({ text: "    for (let i = RETRIES;", at: 17, len: 7 })).toEqual({ before: "for (let i = ", match: "RETRIES", after: ";" });
  });

  test("a match reported past the end of a cut line is clamped, not thrown", () => {
    expect(hitParts({ text: "abc", at: 99, len: 7 })).toEqual({ before: "abc", match: "", after: "" });
    expect(hitParts({ text: "abc", at: 1, len: 99 })).toEqual({ before: "a", match: "bc", after: "" });
  });

  test("name results put places before files", () => {
    expect(nameResults(["src/sync/push.ts"], ["src/sync", "docs"])).toEqual([
      { rel: "docs", dir: true }, { rel: "src/sync", dir: true }, { rel: "src/sync/push.ts", dir: false },
    ]);
  });

  test("dirOf", () => {
    expect(dirOf("src/sync/push.ts")).toBe("src/sync");
    expect(dirOf("README.md")).toBe("");
  });
});

describe("recents", () => {
  test("the file just opened goes first, once", () => {
    expect(remembered(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(remembered(["a"], "z")).toEqual(["z", "a"]);
  });

  test("capped", () => {
    const many = Array.from({ length: 60 }, (_, i) => `f${i}`);
    expect(remembered(many, "new").length).toBe(30);
  });

  test("the box filters them, case-insensitively", () => {
    expect(recentMatching(["src/Push.ts", "docs/a.md"], "push")).toEqual(["src/Push.ts"]);
    expect(recentMatching(["a", "b"], "")).toEqual(["a", "b"]);
  });
});

describe("find in file", () => {
  const lines = ["import { RETRIES } from './config';", "for (;;) { retries++ }", "nothing here"];

  test("every match in reading order, ignoring case", () => {
    expect(findMatches(lines, "retries")).toEqual([{ line: 0, at: 9, len: 7 }, { line: 1, at: 11, len: 7 }]);
  });

  test("two matches on one line, not overlapping", () => {
    expect(findMatches(["aaaa"], "aa")).toEqual([{ line: 0, at: 0, len: 2 }, { line: 0, at: 2, len: 2 }]);
  });

  test("an empty query matches nothing, and the list is capped", () => {
    expect(findMatches(lines, "")).toEqual([]);
    expect(findMatches(["a".repeat(2000)], "a").length).toBe(500);
  });

  test("next and previous go round the ends", () => {
    expect(stepMatch(0, 3, 1)).toBe(1);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(0);
  });

  test("the counter", () => {
    expect(findLabel(1, 5, "x")).toBe("2 of 5");
    expect(findLabel(0, 0, "x")).toBe("No match");
    expect(findLabel(0, 0, "")).toBe("");
    expect(findLabel(0, 500, "x")).toBe("1 of 500+");
    // A file cut to its first 60k characters: a miss says so.
    expect(findLabel(0, 0, "x", 60_000)).toBe("No match in the first 60k");
    expect(findLabel(1, 5, "x", 60_000)).toBe("2 of 5");
  });
});
