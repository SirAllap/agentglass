import { describe, expect, it } from "bun:test";
import { partitionByWorktree, splitReadable, goneConfirmText, leftoversLine, preselected, fmtBytes } from "../src/lib/goneCleanup.ts";
import type { GitBranch, WorktreeLeftovers, LeftoverEntry } from "../../shared/types.ts";

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
  path, entries: [], more: 0, skipped: 0, identical: 0, ...over,
});
const entry = (path: string, bytes: number, vsMain: "absent" | "differs" = "absent"): LeftoverEntry =>
  ({ path, bytes, dir: path.endsWith("/"), vsMain });

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
    const { removable, refused } = splitReadable([b], map, [report("/code/repo-PROJ-1", { entries: [entry("a.env", 40)], skipped: 12 })]);
    expect(refused).toEqual([]);
    expect(removable).toHaveLength(1);
    expect(removable[0]!.report.entries.map((e) => e.path)).toEqual(["a.env"]);
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

describe("preselected", () => {
  it("ticks the small unique ones and leaves the big ones alone", () => {
    // The shape of a real worktree: notes nobody else has, beside build output
    // the main checkout also has a version of. No rule here knows what
    // `.specs` is — only "absent" and "small".
    const r = report("/code/repo-x", {
      entries: [
        entry(".specs/plan.md", 5340),
        entry(".specs/pol-captures/", 725_000),
        entry("tmp/", 5_500_000, "differs"),
        entry("src/app/dist/", 12_000_000, "differs"),
      ],
    });
    expect([...preselected(r)]).toEqual([".specs/plan.md", ".specs/pol-captures/"]);
  });

  it("never ticks something that would overwrite the main checkout", () => {
    // Even a tiny one. Copying over a file that is already there is the exact
    // accident the rescue exists to prevent, so it can only ever be deliberate.
    const r = report("/x", { entries: [entry("worktree.env", 181, "differs")] });
    expect(preselected(r).size).toBe(0);
  });

  it("does not tick something it could not measure", () => {
    const r = report("/x", { entries: [entry("weird", -1)] });
    expect(preselected(r).size).toBe(0);
  });

  it("leaves a large unique entry offered but unticked", () => {
    // Unique and huge: still worth showing — it might be a capture directory —
    // but not something to copy into the main checkout without being asked.
    const r = report("/x", { entries: [entry("recordings/", 900_000_000)] });
    expect(preselected(r).size).toBe(0);
    expect(r.entries).toHaveLength(1);
  });
});

describe("fmtBytes", () => {
  it("reads at a glance", () => {
    expect(fmtBytes(181)).toBe("181B");
    expect(fmtBytes(5340)).toBe("5.2K");
    expect(fmtBytes(725_000)).toBe("708K");
    expect(fmtBytes(12_000_000)).toBe("11M");
    expect(fmtBytes(-1)).toBe("?");
  });
});

describe("leftoversLine", () => {
  it("caps the list and counts the rest, including the server's own overflow", () => {
    const r = report("/code/repo-x", { entries: ["1", "2", "3", "4", "5", "6", "7"].map((n) => entry(n, 10)), more: 21, skipped: 508 });
    const line = leftoversLine(r, "repo-x");
    expect(line).toContain("    1\n");
    expect(line).not.toContain("    7\n");
    // 7 files, 6 shown, 1 left over here plus the 21 the server had already cut.
    expect(line).toContain("…and 22 more");
    expect(line).toContain("(+508 rebuildable");
  });

  it("distinguishes an empty checkout from one holding only caches", () => {
    expect(leftoversLine(report("/x"), "x")).toContain("empty");
    expect(leftoversLine(report("/x", { skipped: 9 }), "x")).toContain("9 rebuildable");
    expect(leftoversLine(report("/x", { identical: 20 }), "x")).toContain("20 already in the main checkout");
  });
});
