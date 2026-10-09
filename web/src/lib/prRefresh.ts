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
export function rowPatch(d: PrDetail) {
  return {
    title: d.title, state: d.state, isDraft: d.isDraft, reviewDecision: d.reviewDecision,
    updatedAt: d.updatedAt, additions: d.additions, deletions: d.deletions,
    changedFiles: d.changedFiles, labels: d.labels, assignees: d.assignees,
    reviewers: d.reviewers,
    milestone: d.milestone, checks: d.checks, checksLoaded: true,
    /* The board files a card by these two, and a base that moved changes the
       first without touching `updatedAt`, so the detail can learn it first. An
       UNKNOWN is GitHub still computing: never a reason to forget a known one. */
    ...(d.mergeable !== "UNKNOWN" ? { mergeable: d.mergeable } : {}),
    ...(d.headSha ? { headSha: d.headSha } : {}),
  };
}

export function overlayDetail(rows: PrSummary[], d: PrDetail): PrSummary[] {
  const at = rows.findIndex((r) => r.number === d.number);
  if (at < 0) return rows;
  const r = rows[at];
  const patch = rowPatch(d);
  /* The detail also lands on every poll; a row that already says the same
     stays the same object, so the lists do not re-render for nothing. */
  if ((Object.keys(patch) as (keyof typeof patch)[]).every((k) => JSON.stringify(r[k]) === JSON.stringify(patch[k]))) return rows;
  const out = rows.slice();
  out[at] = { ...r, ...patch };
  return out;
}

/** How long an edit made in the detail keeps outranking a list that predates it. */
export const EDIT_HOLD_MS = 2 * 60_000;

export type EditLog = Map<number, { at: number; patch: ReturnType<typeof rowPatch> }>;

/**
 * A list answer that was read BEFORE an edit must not undo it.
 *
 * Measured on the board: a poll already in flight when a status, a label or a
 * reviewer was changed in the detail came back with the server's older rows and
 * replaced the overlay, so the card drew the value from before the edit until
 * the next poll. `fetchedAt` is when the server read the list; a row whose edit
 * is newer than that keeps the edit on top, and an answer read after the edit
 * is GitHub's own and wins. Rows nobody edited come back as the same objects.
 */
export function holdEdits(rows: PrSummary[], log: EditLog, fetchedAt: number, now = Date.now()): PrSummary[] {
  if (!log.size) return rows;
  let out = rows;
  for (const [n, e] of log) {
    if (now - e.at > EDIT_HOLD_MS) { log.delete(n); continue; }
    if (fetchedAt >= e.at) continue;
    const at = out.findIndex((r) => r.number === n);
    if (at < 0) continue;
    if (out === rows) out = rows.slice();
    out[at] = { ...out[at], ...e.patch };
  }
  return out;
}
