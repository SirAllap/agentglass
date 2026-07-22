import { describe, expect, it } from "bun:test";
import { partitionByWorktree, splitReadable, goneConfirmText, leftoversLine } from "../src/lib/goneCleanup.ts";
import type { GitBranch, WorktreeLeftovers } from "../../shared/types.ts";

/**
 * The bulk "delete N merged" path, pinned at the two points where it decides
 * something irreversible.
 *
 * The first version of `splitReadable` was written inline as
 * `byPath.get(path)?.error ?? true`, which is `true` whenever the server
 * succeeded — so every branch held by a worktree was refused with "no answer
 * from the server" while the server was answering fine. The type checker was
 * happy and the server's own tests all passed; the only thing that catches it
 * is handing the decision a successful report and asking what it decided.
 */
const branch = (name: string): GitBranch => ({
  name, current: false, upstream: null, track: "[gone]", date: "", subject: "", mergedIntoTrunk: true,
});
const report = (path: string, over: Partial<WorktreeLeftovers> = {}): WorktreeLeftovers => ({
  path, files: [], more: 0, skipped: 0, ...over,
});

describe("partitionByWorktree", () => {
  it("puts a branch with a worktree on the held side", () => {
    const a = branch("PROJ-1"), b = branch("PROJ-2");
    const { free, held } = partitionByWorktree([a, b], new Map([["PROJ-2", "/code/repo-PROJ-2"]]));
    expect(free.map((x) => x.name)).toEqual(["PROJ-1"]);
    expect(held.map((x) => x.name)).toEqual(["PROJ-2"]);
  });

  it("an empty map means nothing is held", () => {
    // The state this map is built from is only populated by the Worktrees tab,
    // so an empty one used to be the normal case from the Branches tab — and it
    // silently sent every branch down the delete-directly path that fails.
    const { free, held } = partitionByWorktree([branch("PROJ-1")], new Map());
    expect(free).toHaveLength(1);
    expect(held).toHaveLength(0);
  });
});

describe("splitReadable", () => {
  const b = branch("PROJ-1");
  const map = new Map([["PROJ-1", "/code/repo-PROJ-1"]]);

  it("treats a successful report as removable", () => {
    // THE regression. A good report has no `error` field at all.
    const { removable, refused } = splitReadable([b], map, [report("/code/repo-PROJ-1", { files: ["a.env"], skipped: 12 })]);
    expect(refused).toEqual([]);
    expect(removable).toHaveLength(1);
    expect(removable[0]!.report.files).toEqual(["a.env"]);
  });

  it("an empty checkout is still removable", () => {
    // No files and no error: nothing to lose, and it must not read as a failure
    // just because the list is empty.
    const { removable, refused } = splitReadable([b], map, [report("/code/repo-PROJ-1")]);
    expect(refused).toEqual([]);
    expect(removable).toHaveLength(1);
  });

  it("refuses a checkout that reported an error", () => {
    const { removable, refused } = splitReadable([b], map, [report("/code/repo-PROJ-1", { error: "could not read that checkout" })]);
    expect(removable).toEqual([]);
    expect(refused[0]!.why).toBe("could not read that checkout");
  });

  it("refuses a branch with no report at all", () => {
    // A path the server never answered for. Silence is not consent.
    const { removable, refused } = splitReadable([b], map, []);
    expect(removable).toEqual([]);
    expect(refused[0]!.why).toBe("no answer from the server");
  });

  it("refuses a branch whose worktree path is unknown", () => {
    const { removable, refused } = splitReadable([b], new Map(), [report("/code/repo-PROJ-1")]);
    expect(removable).toEqual([]);
    expect(refused).toHaveLength(1);
  });
});

describe("goneConfirmText", () => {
  const trunk = "origin/master";

  it("does not call the held ones 'more' when none are free", () => {
    // The shipped bug: "None of the 3 merged branches can be deleted on their
    // own" followed by "3 more are checked out in a worktree" reads as six
    // branches in a repo that has three.
    const held = [branch("a"), branch("b"), branch("c")];
    const text = goneConfirmText([], held, 5, trunk);
    expect(text).not.toContain("more are checked out");
    expect(text).toContain("All 3 merged branches are checked out in a worktree");
    expect(text).toContain("5 have no remote branch");
  });

  it("uses 'more' only when there is something for them to be more than", () => {
    const text = goneConfirmText([branch("a")], [branch("b")], 0, trunk);
    expect(text).toContain("Delete 1 branch already merged into origin/master?");
    expect(text).toContain("1 more is checked out in a worktree");
  });

  it("says nothing about worktrees when none are held", () => {
    const text = goneConfirmText([branch("a"), branch("b")], [], 0, trunk);
    expect(text).toBe("Delete 2 branches already merged into origin/master?");
  });

  it("agrees in number for a single held branch", () => {
    const text = goneConfirmText([], [branch("a")], 0, trunk);
    expect(text).toContain("All 1 merged branch is checked out in a worktree");
    expect(text).toContain("Remove that worktree and delete the branch?");
  });
});

describe("leftoversLine", () => {
  it("caps the list and counts the rest, including the server's own overflow", () => {
    const r = report("/code/repo-x", { files: ["1", "2", "3", "4", "5", "6", "7"], more: 21, skipped: 508 });
    const line = leftoversLine(r, "repo-x");
    expect(line).toContain("    1\n");
    expect(line).not.toContain("    7\n");
    // 7 files, 6 shown, 1 left over here plus the 21 the server had already cut.
    expect(line).toContain("…and 22 more");
    expect(line).toContain("(+508 rebuildable");
  });

  it("distinguishes an empty checkout from one holding only caches", () => {
    expect(leftoversLine(report("/x"), "x")).toContain("empty");
    expect(leftoversLine(report("/x", { skipped: 9 }), "x")).toContain("nothing but 9 rebuildable");
  });
});
