import type { PrDetail, PrSummary } from "../../../shared/types.ts";

/**
 * What the Refresh button asks GitHub for.
 *
 * On the list it means the lists. With one pull request open it means that
 * pull request: the button used to force every list, drop the check, behind
 * and card caches of every row, and go back to a board where each card
 * loaded again — measured as a full page of requests to re-read one.
 *
 * `list` covers the board's two lists as well; they are the same rows.
 */
export function refreshPlan(selected: number | null): { list: boolean; pr: number | null } {
  return selected == null ? { list: true, pr: null } : { list: false, pr: selected };
}

/**
 * The row for the pull request just re-read, brought up to date from its detail.
 *
 * The lists are not re-fetched after a detail refresh, so without this the
 * board would keep showing the state from before the press. Only the fields a
 * card draws and a detail also carries are taken; the rest of the row (its
 * scope, its worktree, its agent spend) is the list's and has not changed.
 * Rows of other pull requests are returned as they are, same array when none
 * matched, so nothing re-renders for a refresh of somebody else.
 */
export function overlayDetail(rows: PrSummary[], d: PrDetail): PrSummary[] {
  const at = rows.findIndex((r) => r.number === d.number);
  if (at < 0) return rows;
  const r = rows[at];
  const patch = {
    title: d.title, state: d.state, isDraft: d.isDraft, reviewDecision: d.reviewDecision,
    updatedAt: d.updatedAt, additions: d.additions, deletions: d.deletions,
    changedFiles: d.changedFiles, labels: d.labels, assignees: d.assignees,
    milestone: d.milestone, checks: d.checks, checksLoaded: true,
  };
  /* The detail also lands on every poll; a row that already says the same
     stays the same object, so the lists do not re-render for nothing. */
  if ((Object.keys(patch) as (keyof typeof patch)[]).every((k) => JSON.stringify(r[k]) === JSON.stringify(patch[k]))) return rows;
  const out = rows.slice();
  out[at] = { ...r, ...patch };
  return out;
}
