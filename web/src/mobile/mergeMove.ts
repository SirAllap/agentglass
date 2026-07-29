import type { PrMergeState } from "../../../shared/types.ts";

/**
 * What to do about a pull request that will not merge.
 *
 * The footer had one button and two states: "Squash & merge" when GitHub said
 * CLEAN, and a disabled "Blocked" the rest of the time with the reason printed
 * above it. The reason is good — a greyed-out primary with no explanation is
 * the commonest lie a review UI tells, and this screen already knew that. But
 * for half the states the reason names something the phone could have *done*,
 * and offered nothing:
 *
 *   BEHIND    "the base branch has moved — update the branch first", and
 *             `prUpdateBranch` has been in the client all along.
 *   BLOCKED   waiting on a review or a required check. Nothing to do now, but
 *             arming auto-merge is exactly the move for someone who is not at
 *             their desk and will not be back to press a button.
 *   UNSTABLE  a check is failing; re-running it is one call away.
 *
 * That is the difference between a companion and a status page: the same
 * sentence, with the next move attached.
 *
 * DIRTY is the honest "not from here". Resolving a conflict against a base
 * branch is a job for the machine with the checkout on it, and pretending
 * otherwise would put someone in a bad place with no editor.
 */

export type MergeMove =
  | { kind: "merge"; label: string }
  | { kind: "update"; label: string }
  | { kind: "auto"; label: string }
  | { kind: "rerun"; label: string }
  | { kind: "none"; label: string };

export interface MergeInput {
  state: PrMergeState;
  isDraft: boolean;
  /** Whether auto-merge is already armed, so the offer is not made twice. */
  autoMerge?: boolean;
  /** Whether any check has actually failed, as opposed to merely not passed. */
  anyFailing?: boolean;
}

/**
 * Why it will not merge, in a sentence.
 *
 * Use `whyBlocked` rather than reaching in here directly: GitHub's UNSTABLE
 * covers both "a check failed" and "a check has not finished", and the fixed
 * string said the first of those while the button offered the move for the
 * second. A reason that contradicts the action under it is worse than no
 * reason, because someone acts on the sentence.
 */
export const MERGE_WHY: Record<PrMergeState, string> = {
  CLEAN: "Nothing is standing in the way",
  BLOCKED: "A required review or check has not passed",
  BEHIND: "The base branch has moved — update the branch first",
  DIRTY: "There are conflicts with the base branch",
  UNSTABLE: "A check is failing",
  DRAFT: "This is a draft",
  HAS_HOOKS: "A repository hook is blocking the merge",
  UNKNOWN: "GitHub has not finished working it out",
};

export function whyBlocked(pr: MergeInput): string {
  if (pr.state === "UNSTABLE" && !pr.anyFailing) return "A check has not finished yet";
  if (pr.state === "BLOCKED" && pr.anyFailing) return "A check is failing";
  return MERGE_WHY[pr.state];
}

/**
 * The one thing worth putting on the primary button.
 *
 * Ordered by what unblocks soonest, not by what is most dramatic: a branch that
 * is merely behind is one call from mergeable, so that beats arming auto-merge
 * even though auto-merge is the more impressive-sounding offer.
 */
export function mergeMove(pr: MergeInput): MergeMove {
  // A draft is a decision somebody made, and undrafting from the merge button
  // would be a surprise. The ⋯ sheet has that verb.
  if (pr.isDraft) return { kind: "none", label: "Draft" };
  if (pr.state === "CLEAN") return { kind: "merge", label: "Squash & merge" };
  if (pr.state === "BEHIND") return { kind: "update", label: "Update branch" };
  if (pr.state === "DIRTY") return { kind: "none", label: "Conflicts" };
  // Already armed: saying so beats offering to arm it again.
  if (pr.autoMerge) return { kind: "none", label: "Merging when green" };
  // Only where a check is the story. `anyFailing` on its own was short-
  // circuiting every remaining state, so a repository hook blocking the merge
  // offered "Re-run checks" over a sentence about hooks — re-running would not
  // have touched it.
  if (pr.state === "BLOCKED" || pr.state === "UNSTABLE") {
    // Something is red rather than merely unfinished. Arming auto-merge on a
    // failing run would only wait for the failure.
    return pr.anyFailing
      ? { kind: "rerun", label: "Re-run checks" }
      : { kind: "auto", label: "Merge when green" };
  }
  return { kind: "none", label: "Blocked" };
}
