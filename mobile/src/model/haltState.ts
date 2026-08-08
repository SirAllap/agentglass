import type { GitTreeState } from "../../../shared/types.ts";

/**
 * A repository that git has stopped halfway through.
 *
 * `treeState()` on the server has reported this since the beginning — it is one
 * stat per state against `.git`, and it is how git itself decides. The phone
 * never read it. `loadTrees` copies `branch.name`, `ahead` and `behind` off the
 * tree and drops `branch.state` on the floor, so a checkout sitting on a
 * half-finished rebase looked exactly like a clean one: a branch name, a dirty
 * count, and no way out. The one place the phone is *for* — you left the desk
 * and something needs a person — and it was the one state it could not show.
 *
 * What makes it worth a module rather than a ternary in the view is that the
 * five states are not the same shape. Continuing a rebase and continuing a
 * bisect are different verbs; a bisect has no conflicts to resolve and nothing
 * to continue *to*; and until this change, aborting a bisect ran
 * `git merge --abort` and failed, because mergeAbort's fallthrough assumed
 * anything that was not a rebase, a cherry-pick or a revert was a merge.
 *
 * So: the decision as data, one place, tested.
 */

export interface HaltInput {
  state?: GitTreeState;
  /** Paths git reports as unmerged — `UU` and friends. */
  conflicts: readonly string[];
}

export interface Halt {
  state: Exclude<GitTreeState, "clean">;
  /** What is going on, in the user's words. */
  title: string;
  /** What happens if they do nothing. */
  sub: string;
  /** The label on the way out. Always available: abandoning is the move that
   *  is always safe and the one people reach for first. */
  abortLabel: string;
  /** The label on the way forward, or null where finishing is not a thing this
   *  state does. */
  continueLabel: string | null;
  /** Whether finishing is possible *now*, as opposed to in principle. */
  canContinue: boolean;
  conflicts: readonly string[];
}

const COPY: Record<Exclude<GitTreeState, "clean">, {
  title: string; abort: string; cont: string | null;
}> = {
  rebasing: { title: "Rebase stopped part-way", abort: "Abandon the rebase", cont: "Continue" },
  merging: { title: "Merge stopped part-way", abort: "Abandon the merge", cont: "Finish the merge" },
  "cherry-picking": { title: "Cherry-pick stopped part-way", abort: "Abandon it", cont: "Continue" },
  reverting: { title: "Revert stopped part-way", abort: "Abandon it", cont: "Continue" },
  // A bisect is a search, not a transaction: there is nothing to "continue" to
  // from a phone, because the next step is a verdict on the checked-out commit
  // and that means running the thing. Ending the search and going back to where
  // you started is the honest offer.
  bisecting: { title: "A bisect is still running", abort: "End the bisect", cont: null },
};

/**
 * What to say and what to offer, or null when there is nothing to say.
 *
 * Absent state is "clean" deliberately — `GitBranchInfo.state` is optional
 * because it postdates the payload, and treating a missing field as an
 * emergency would put a red banner on every repository served by an older
 * sidecar.
 */
export function halt(tree: HaltInput | null | undefined): Halt | null {
  const state = tree?.state;
  if (!state || state === "clean") return null;
  const copy = COPY[state];
  const conflicts = tree?.conflicts ?? [];
  return {
    state,
    title: copy.title,
    sub: conflicts.length
      ? `${conflicts.length} file${conflicts.length > 1 ? "s" : ""} still conflicted`
      : copy.cont
        ? "Nothing is conflicted — it is waiting to be finished"
        : "The tree is on a commit the search picked, not on your branch",
    abortLabel: copy.abort,
    continueLabel: copy.cont,
    // Every conflict has to be resolved first; the server refuses otherwise,
    // and a button that always fails is worse than one that is not offered.
    canContinue: copy.cont !== null && conflicts.length === 0,
    conflicts,
  };
}
