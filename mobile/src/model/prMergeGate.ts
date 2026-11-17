/*
 * The merge sheet's second opinion, from the desktop's own ladder.
 *
 * `mergeVerdict` answers "will GitHub take it". The desktop merge box also asks
 * `mergeBlockers` (shared/mergeBlockers.ts) what GitHub's state cannot see — a
 * lock, a draft, a conflict, a role without merge rights — and whether arming
 * "merge when green" is an honest offer. The phone asks the same two questions
 * of the same module rather than inventing a third answer.
 */
import type { PrDetail } from "../../../shared/types.ts";
import { autoMergeRefusal, mergeBlockers, mergeRefusal } from "../../../shared/mergeBlockers.ts";

export interface MergeGate {
  /** What takes the Merge button away, in one sentence, or null. */
  refusal: string | null;
  /** Why "Merge when green" would promise a merge that is not coming, or null. */
  autoRefusal: string | null;
}

export function mergeGate(d: PrDetail): MergeGate {
  const list = mergeBlockers({
    ...d,
    openThreads: (d.threads ?? []).filter((t) => !t.isResolved).length,
  });
  const hard = mergeRefusal(list, d.mergeState);
  return {
    refusal: hard ? `${hard.title}. ${hard.detail}`.trim() : null,
    autoRefusal: autoMergeRefusal(list),
  };
}
