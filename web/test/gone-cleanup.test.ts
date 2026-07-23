import { describe, expect, it } from "bun:test";
import { partitionByWorktree, splitReadable, goneConfirmTitle, goneConfirmBody, preselected, fmtBytes, rescueKey, rescuePicks } from "../src/lib/goneCleanup.ts";
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

describe("goneConfirmTitle / goneConfirmBody", () => {
  const trunk = "origin/master";

  it("does not call the held ones 'more' when none are free", () => {
    // The shipped bug: "None of the 3 merged branches can be deleted on their
    // own" followed by "3 more are checked out in a worktree" reads as six
    // branches in a repo that has three.
    const held = [branch("a"), branch("b"), branch("c")];
    expect(goneConfirmTitle([], held, trunk)).toBe("Remove 3 worktrees and delete their branches?");
    const body = goneConfirmBody([], held, 5, trunk);
    expect(body).not.toContain("more are checked out");
    expect(body).toContain("All 3 merged branches are checked out in a worktree");
    expect(body).toContain("5 have no remote branch");
  });

  it("uses 'more' only when there is something for them to be more than", () => {
    expect(goneConfirmTitle([branch("a")], [branch("b")], trunk)).toBe("Delete 1 branch already merged into origin/master?");
    expect(goneConfirmBody([branch("a")], [branch("b")], 0, trunk)).toContain("1 more is checked out in a worktree");
  });

  it("says nothing about worktrees when none are held", () => {
    expect(goneConfirmTitle([branch("a"), branch("b")], [], trunk)).toBe("Delete 2 branches already merged into origin/master?");
    expect(goneConfirmBody([branch("a"), branch("b")], [], 0, trunk)).toBe("");
  });

  it("agrees in number for a single held branch", () => {
    expect(goneConfirmTitle([], [branch("a")], trunk)).toBe("Remove 1 worktree and delete its branch?");
    expect(goneConfirmBody([], [branch("a")], 0, trunk)).toContain("All 1 merged branch is checked out in a worktree");
  });

  it("the title is one line — it is what the dialog bolds", () => {
    // Body carries the rest. A title with newlines in it renders as a wall.
    for (const t of [goneConfirmTitle([branch("a")], [branch("b")], trunk), goneConfirmTitle([], [branch("a")], trunk)]) {
      expect(t).not.toContain("\n");
    }
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

describe("rescuePicks", () => {
  // The exact shape of the checkout that lost data: notes and screenshots that
  // exist nowhere else, mixed with build output that also lives in the main
  // checkout. Five of these were ticked, reported as copied, were not on disk
  // afterwards — and the checkout was deleted next.
  const WT = "/home/dev/orbit-WEB-1042";
  const real = report(WT, {
    entries: [
      entry("worktree.env", 181),
      entry(".specs/adversarial-findings-v11.md", 2902),
      entry(".specs/adversarial-findings-local.md", 3300),
      entry(".specs/implementation-plan.md", 5340),
      entry(".specs/pol-captures/cap-01-air-dashboard.png", 12345),
      entry(".specs/pol-captures/cap-03-dashboard-rendered.png", 137000),
      entry(".specs/pol-captures/cap-02-profile-overlay.png", 151465),
      entry(".specs/pol-captures/cap-05-console-table.png", 154278),
      entry(".specs/pol-captures/cap-04-with-profile.png", 251903),
      entry("tmp/pyrefly-exapi.txt", 103, "differs"),
      entry("src/app/dist/bundle/", 12_000_000, "differs"),
    ],
    identical: 20, skipped: 508,
  });

  it("asks for every ticked path, nested ones included", () => {
    // The regression. Nine entries pre-ticked, nine sent — not four.
    const ticked = new Set([...preselected(real)].map((p) => rescueKey(WT, p)));
    const picks = rescuePicks([real], ticked);
    expect(picks.get(WT)).toHaveLength(9);
    expect(picks.get(WT)).toContain(".specs/pol-captures/cap-04-with-profile.png");
    expect(picks.get(WT)).toContain("worktree.env");
    // And nothing that would overwrite the main checkout.
    expect(picks.get(WT)).not.toContain("tmp/pyrefly-exapi.txt");
  });

  it("keys are per worktree, so identical paths don't collide", () => {
    // Every worktree of a repo has a `worktree.env`. Ticking one must not tick
    // the other, and must not drop it either.
    const a = report("/w/a", { entries: [entry("worktree.env", 10)] });
    const b = report("/w/b", { entries: [entry("worktree.env", 10)] });
    const picks = rescuePicks([a, b], new Set([rescueKey("/w/b", "worktree.env")]));
    expect(picks.has("/w/a")).toBe(false);
    expect(picks.get("/w/b")).toEqual(["worktree.env"]);
  });

  it("an untouched worktree contributes nothing at all", () => {
    // Not an empty array — the caller skips on `!rels.length`, and an entry
    // with no paths would still print "keeping 0 files".
    expect(rescuePicks([real], new Set()).size).toBe(0);
  });
});
