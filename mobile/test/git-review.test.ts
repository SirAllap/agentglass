/*
 * Reading a commit, and what Push can do — the arithmetic behind the Git screens.
 *
 * Fixtures are the shape `/git/log`, `/git/branches` and `/git/commit-diff`
 * answer with, on an invented repository.
 */
import { describe, expect, test } from "bun:test";
import type { GitBranch, GitCommit, GitFileChange } from "../../shared/types.ts";
import { gapsIn } from "../src/model/expand.ts";
import {
  commitFiles, commitTotals, fileNav, gapOffset, parseRefs, pushState, relPath, switchWarning, toDiffFile,
  toggled, unpushedHashes, unwrappedWidth, viewedLabel, GUTTER_W, CHAR_W,
} from "../src/model/gitReview.ts";

const commit = (hash: string, refs = ""): GitCommit => ({
  hash: hash.padEnd(40, "0"), shortHash: hash.slice(0, 7), subject: `subject ${hash}`, author: "ada", date: "5m ago", refs,
});
const branch = (over: Partial<GitBranch>): GitBranch => ({
  name: "orbit-1042-sync-retry", current: true, upstream: null, track: "", date: "1m", subject: "x", ...over,
});
const change = (path: string, over: Partial<GitFileChange> = {}): GitFileChange => ({
  id: 0, timestamp: 0, source_app: "git", session_id: "unstaged", tool: "git",
  file_path: `/home/ada/orbit/${path}`, additions: 9, deletions: 3, status: "modified", staged: false, binary: false,
  hunks: [{ oldStart: 1, oldLines: 6, newStart: 1, newLines: 12, lines: [" keep", "+added", "-gone", " tail"] }],
  ...over,
});

describe("a commit's files", () => {
  test("paths are repo-relative", () => {
    const f = commitFiles("/home/ada/orbit", [change("src/sync/push.ts"), change("README.md")]);
    expect(f.map((x) => x.path)).toEqual(["src/sync/push.ts", "README.md"]);
    expect(commitTotals(f)).toEqual({ added: 18, removed: 6 });
  });
  test("a path outside the root is left as given, and a trailing slash on the root is fine", () => {
    expect(relPath("/home/ada/orbit/", "/home/ada/orbit/a.ts")).toBe("a.ts");
    expect(relPath("/home/ada/orbit", "/elsewhere/a.ts")).toBe("/elsewhere/a.ts");
    expect(relPath("/home/ada/orbit", "/home/ada/orbit-2/a.ts")).toBe("/home/ada/orbit-2/a.ts");
  });
});

describe("file n of N", () => {
  const paths = ["a", "b", "c"];
  test("the middle file has both neighbours", () => {
    expect(fileNav(paths, "b")).toEqual({ index: 1, label: "2 of 3", prev: "a", next: "c" });
  });
  test("the ends have one neighbour, so the arrow beyond them is dead", () => {
    expect(fileNav(paths, "a").prev).toBeNull();
    expect(fileNav(paths, "c").next).toBeNull();
  });
  test("a file that is not in the commit has no position, not position 0", () => {
    expect(fileNav(paths, "zzz")).toEqual({ index: -1, label: "", prev: null, next: null });
  });
});

describe("viewed ticks", () => {
  test("count only the files the commit has", () => {
    expect(viewedLabel(["a", "b"], new Set(["a", "gone.ts"]))).toBe("1 of 2 viewed");
  });
  test("toggling returns a new set and leaves the old one alone", () => {
    const one = new Set(["a"]);
    const two = toggled(one, "b");
    expect([...two]).toEqual(["a", "b"]);
    expect([...one]).toEqual(["a"]);
    expect([...toggled(two, "a")]).toEqual(["b"]);
  });
});

describe("the diff as the pull request screens read it", () => {
  test("lines carry the number of the side they exist on", () => {
    const f = toDiffFile("/home/ada/orbit", change("src/a.ts"));
    expect(f.path).toBe("src/a.ts");
    expect(f.hunks[0]?.header).toBe("@@ −1,6 +1,12 @@");
    expect(f.hunks[0]?.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["ctx", 1, 1], ["add", null, 2], ["del", 2, null], ["ctx", 3, 3],
    ]);
  });
  test("an untracked file reads as added", () => {
    expect(toDiffFile("/r", change("a", { status: "untracked" })).status).toBe("added");
  });
  test("the gap arithmetic of the PR diff finds the lines between two hunks", () => {
    const f = toDiffFile("/r", change("a", { hunks: [
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "+b"] },
      { oldStart: 30, oldLines: 2, newStart: 31, newLines: 2, lines: [" c", "-d"] },
    ] }));
    expect(gapsIn(f).map((g) => [g.before, g.from, g.to])).toEqual([[1, 3, 30], [2, 32, null]]);
  });
  test("context above a hunk is numbered on both sides, offset by what was added before it", () => {
    const hunks = [
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [" a", "+b", " c"] },
      { oldStart: 30, oldLines: 2, newStart: 31, newLines: 2, lines: [" x", " y"] },
    ];
    // Above hunk 1 a new-side line N is old-side N-1.
    expect(gapOffset(hunks, 1)).toBe(-1);
    // Below the last hunk the same: one line was added and never taken back.
    expect(gapOffset(hunks, 2)).toBe(-1);
    expect(gapOffset([], 0)).toBe(0);
  });
});

describe("Wrap off needs a width to scroll across", () => {
  test("the longest line sets it, never less than the screen", () => {
    const f = toDiffFile("/r", change("a", { hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["+" + "x".repeat(100)] }] }));
    expect(unwrappedWidth(f, 360)).toBe(Math.ceil(GUTTER_W + 100 * CHAR_W + 16));
    expect(unwrappedWidth(null, 360)).toBe(360);
  });
});

describe("decorations", () => {
  test("the checked-out branch comes first, the remote HEAD alias is dropped", () => {
    expect(parseRefs("origin/x, HEAD -> x, origin/HEAD, tag: v1")).toEqual([
      { label: "x", kind: "head" }, { label: "origin/x", kind: "remote" }, { label: "v1", kind: "tag" },
    ]);
    expect(parseRefs("")).toEqual([]);
  });
});

describe("which commits no remote has", () => {
  test("everything above the first commit a remote carries", () => {
    const log = [commit("c0c2", "HEAD -> orbit-1042-sync-retry"), commit("43cd", "master, origin/master"), commit("9f00")];
    expect([...(unpushedHashes(log) ?? [])]).toEqual([log[0]!.hash]);
  });
  test("a log that never reaches a remote cannot be counted, and says so with null", () => {
    expect(unpushedHashes([commit("a1"), commit("a2")])).toBeNull();
  });
  test("an empty log has nothing unpushed", () => {
    expect(unpushedHashes([])?.size).toBe(0);
  });
});

describe("Push", () => {
  const log = [commit("c0c2", "HEAD -> orbit-1042-sync-retry"), commit("43cd", "master, origin/master")];

  test("a branch that was never pushed reads 0 ahead and is still pushable: the count comes from the log", () => {
    const s = pushState(branch({ upstream: null, track: "" }), log);
    expect(s).toMatchObject({ upstream: null, ahead: 1, canPush: true, label: "Push 1", chip: "1 to push" });
  });
  test("a branch with an upstream counts from its own tracking", () => {
    expect(pushState(branch({ upstream: "origin/x", track: "[ahead 3, behind 1]" }), null))
      .toMatchObject({ ahead: 3, canPush: true, label: "Push 3", chip: "3 to push" });
    expect(pushState(branch({ upstream: "origin/x", track: "" }), null))
      .toMatchObject({ ahead: 0, canPush: false, label: "Push", chip: null });
  });
  test("an upstream that is gone is treated as none: the remote branch was deleted", () => {
    expect(pushState(branch({ upstream: "origin/x", track: "[gone]" }), log).canPush).toBe(true);
  });
  test("before the log is read it will not guess", () => {
    expect(pushState(branch({}), null).canPush).toBe(false);
  });
  test("a never-pushed branch whose log stops short of a remote is pushable but unnumbered", () => {
    expect(pushState(branch({}), [commit("a1"), commit("a2")]))
      .toMatchObject({ ahead: null, canPush: true, label: "Push", chip: "not pushed" });
  });
  test("nothing unpushed, or no branch at all (detached), is not pushable", () => {
    expect(pushState(branch({}), [commit("43cd", "origin/master")]).canPush).toBe(false);
    expect(pushState(null, log).canPush).toBe(false);
  });
});

describe("switching branch with work in the tree", () => {
  test("clean tree: no question", () => expect(switchWarning(0, "main")).toBeNull());
  test("status not read yet: asks, because nobody has looked at the tree", () => {
    expect(switchWarning(null, "main")).toContain("has not read what is changed");
    expect(switchWarning(null, "main")).toContain("main");
  });
  test("dirty tree: says how many files and where", () => {
    expect(switchWarning(1, "main")).toContain("1 file has uncommitted changes");
    expect(switchWarning(3, "main")).toContain("3 files have uncommitted changes");
    expect(switchWarning(3, "main")).toContain("main");
  });
});
