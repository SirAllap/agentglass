/*
 * A repository git stopped halfway through, and the phone's total silence
 * about it.
 *
 * `treeState()` has probed `.git` for this since the beginning — it is how git
 * itself decides, and it is one stat per state. The phone's `loadTrees` copied
 * `branch.name`, `ahead` and `behind` off the tree and dropped `branch.state`,
 * so a checkout sitting on a half-finished rebase rendered exactly like a clean
 * one: a branch name, a dirty count, no banner, no way out. That is the single
 * situation the companion exists for — you walked away and something needs a
 * person — and it was the one it could not show.
 */
import { describe, expect, it } from "bun:test";
import { halt } from "../src/mobile/haltState.ts";
import type { GitTreeState } from "../../shared/types.ts";

const STOPPED: Exclude<GitTreeState, "clean">[] =
  ["rebasing", "merging", "cherry-picking", "reverting", "bisecting"];

describe("a repository stopped part-way", () => {
  it("says nothing about a clean one", () => {
    expect(halt({ state: "clean", conflicts: [] })).toBeNull();
  });

  it("treats a missing state as clean rather than as an emergency", () => {
    // `GitBranchInfo.state` is optional because it postdates the payload. An
    // older sidecar must not paint a red banner on every repository it serves.
    expect(halt({ conflicts: [] })).toBeNull();
    expect(halt(null)).toBeNull();
    expect(halt(undefined)).toBeNull();
  });

  it("has something to say, and a way out, for every state git can stop in", () => {
    // The rule over the type rather than over today's five: adding a state to
    // GitTreeState without giving it copy would leave a card reading
    // "undefined" with a dead button on it.
    for (const state of STOPPED) {
      const h = halt({ state, conflicts: [] })!;
      expect(h).not.toBeNull();
      expect(h.title.length).toBeGreaterThan(8);
      expect(h.title).not.toContain("undefined");
      expect(h.abortLabel.length).toBeGreaterThan(2);
      expect(h.sub.length).toBeGreaterThan(8);
    }
  });

  it("counts the conflicts in the words a person would use", () => {
    expect(halt({ state: "merging", conflicts: ["a"] })!.sub).toContain("1 file");
    expect(halt({ state: "merging", conflicts: ["a"] })!.sub).not.toContain("1 files");
    expect(halt({ state: "merging", conflicts: ["a", "b"] })!.sub).toContain("2 files");
  });

  it("will not offer to finish while anything is still conflicted", () => {
    // The server refuses in this state, and a button that always fails is
    // worse than one that is not offered.
    expect(halt({ state: "merging", conflicts: ["a"] })!.canContinue).toBe(false);
    expect(halt({ state: "merging", conflicts: [] })!.canContinue).toBe(true);
  });

  it("offers no way to finish a bisect, because there is not one", () => {
    // A bisect is a search, not a transaction: the next step is a verdict on
    // the checked-out commit, which means running the thing. Ending the search
    // is the only honest offer from a phone.
    const b = halt({ state: "bisecting", conflicts: [] })!;
    expect(b.continueLabel).toBeNull();
    expect(b.canContinue).toBe(false);
    // And it must not claim there is nothing left to do.
    expect(b.sub).not.toContain("waiting to be finished");
  });

  it("distinguishes the states rather than calling everything a merge", () => {
    // "Abandon the merge" on a stopped rebase is the wrong sentence about the
    // wrong operation, and the reader has no other source of truth on a phone.
    const titles = STOPPED.map((s) => halt({ state: s, conflicts: [] })!.title);
    expect(new Set(titles).size).toBe(STOPPED.length);
    expect(halt({ state: "rebasing", conflicts: [] })!.title.toLowerCase()).toContain("rebase");
    expect(halt({ state: "merging", conflicts: [] })!.title.toLowerCase()).toContain("merge");
  });

  it("passes the conflicted paths through for the list to render", () => {
    expect(halt({ state: "merging", conflicts: ["/r/a.ts", "/r/b.ts"] })!.conflicts)
      .toEqual(["/r/a.ts", "/r/b.ts"]);
  });
});
