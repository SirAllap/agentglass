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
    // The card's verdict header reads this, not `reviewDecision`.
    ...(d.humanReview ? { humanReview: d.humanReview } : {}),
    /* The card's "N open" chip: resolving a thread in the detail left it saying
       "1 open" until the next list read (9.8 s against a stub GitHub). Pending
       own-review threads are not in the detail's list, so this can read one
       lower than the list's count until the next read. */
    ...(Array.isArray(d.threads) ? { openThreads: { open: d.threads.filter((t) => !t.isResolved).length, more: !!d.truncated?.threads } } : {}),
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

/**
 * A reopened pull request, written into the lists it left.
 *
 * `overlayDetail` only patches a row the list already has, and a closed pull
 * request is in no open list, so the card came back only after a list read
 * (3 s against a stub GitHub with a 1.2 s list) while the detail said Open.
 * The row is built from the detail and HELD for a short while: a list read
 * that began before the reopen must not take it away again, and one that began
 * after is GitHub's own. Only the author's own pull requests are held: whose
 * review queue it belongs to is not something the detail knows, and those
 * still wait for the read.
 */
export const REOPEN_HOLD_MS = 30_000;
/** Keyed `${root}#${number}`: another repository's pull request of the same number is not this one. `at` is the SERVER's stamp of the reopen; `t` only measures how long it has been held. */
export type Reopened = Map<string, { n: number; root: string; at: number; t: number; row: PrSummary }>;
export const reopenKey = (root: string, n: number) => `${root}#${n}`;

export function reopenedRow(d: PrDetail): PrSummary | null {
  if (!d.viewerDidAuthor) return null;
  return {
    number: d.number, author: d.author, headRefName: d.headRefName, baseRefName: d.baseRefName, url: d.url,
    ...rowPatch(d), state: "OPEN",
  } as unknown as PrSummary;
}

/**
 * `rows` with every held reopen the read behind them cannot have seen.
 *
 * `startedAt` is the server's stamp of when that read was sent and `e.at` the
 * server's stamp of the reopen: both on ONE clock, so a browser clock that is
 * off (a remote or mobile client) cannot decide it. A read with no stamp
 * (0 / missing) is not proven newer, so the row stays. The browser's clock is
 * used only to let a held row expire.
 */
export function holdReopened(rows: PrSummary[], held: Reopened, startedAt: number | undefined, root: string, now = Date.now()): PrSummary[] {
  let out = rows;
  for (const [k, e] of held) {
    if (now - e.t > REOPEN_HOLD_MS) { held.delete(k); continue; }
    if (e.root !== root) continue;
    if ((startedAt ?? 0) >= e.at || out.some((r) => r.number === e.n)) continue;
    out = [e.row, ...out];
  }
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

/*
 * A merge that landed, told to both views at once.
 *
 * Measured on the board: after merging in the detail the card stayed in "ready
 * to land" for as long as the board's own poll took (about a minute), and the
 * detail itself read "Open / Ready to merge" for 3-4 s until its re-read came
 * back. The merge response is the freshest thing either view knows, so it is
 * written to both, and a read that started before it (still saying OPEN) does
 * not get to undo it. GitHub's answer after LANDED_HOLD_MS is its own again.
 */
export const LANDED_HOLD_MS = 2 * 60_000;

/** Pull request number -> when its merge response arrived. */
export type Landed = Map<number, number>;

export function landedDetail(d: PrDetail, at: string, by?: string): PrDetail {
  return { ...d, state: "MERGED", mergedAt: at, mergedBy: by || d.mergedBy || null, updatedAt: at, autoMerge: null };
}

/** What an OPEN list may show: nothing that has stopped being open (a close or
 *  a merge written from the detail), and nothing whose merge we just saw land
 *  even when a read that began before it still lists it. */
export function dropLanded(rows: PrSummary[], landed: Landed, now = Date.now()): PrSummary[] {
  for (const [n, at] of landed) if (now - at > LANDED_HOLD_MS) landed.delete(n);
  return rows.some((r) => r.state !== "OPEN" || landed.has(r.number))
    ? rows.filter((r) => r.state === "OPEN" && !landed.has(r.number))
    : rows;
}

/** A detail read that says OPEN for a pull request whose merge we just saw land. */
export function staleOpen(d: PrDetail, landed: Landed, now = Date.now()): boolean {
  const at = landed.get(d.number);
  return at !== undefined && now - at <= LANDED_HOLD_MS && d.state === "OPEN";
}

/**
 * Run `fn` unless one is already running under this lock, and release the lock
 * whether it resolved or threw. A React state flag cannot be this: two presses
 * in the same tick both read it false. The lock is a ref (`{ current }`), read
 * and set synchronously before the first await.
 */
export async function once<T>(lock: { current: boolean }, fn: () => Promise<T>): Promise<T | undefined> {
  if (lock.current) return undefined;
  lock.current = true;
  try { return await fn(); } finally { lock.current = false; }
}
