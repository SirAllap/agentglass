/*
 * What the three issue filters count, added up across repositories.
 *
 * `IssueViewCounts` (shared/types.ts) is what `/issues/counts` answers with
 * per repository. Unlike the pull requests' two queues, "All" has a number
 * here: GitHub counts an issue search in one call whatever the state, so every
 * tab can carry one.
 */
import type { IssueViewCounts } from "../../../shared/types.ts";

/** Null for an empty list — "nobody answered" is not "everybody said zero",
 *  and the caller keeps the numbers already on screen for the first. */
export function sumIssueCounts(counts: IssueViewCounts[]): IssueViewCounts | null {
  if (!counts.length) return null;
  return counts.reduce((sum, c) => ({
    mine: sum.mine + c.mine,
    open: sum.open + c.open,
    all: sum.all + c.all,
  }), { mine: 0, open: 0, all: 0 });
}
