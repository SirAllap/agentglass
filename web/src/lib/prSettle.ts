/*
 * When to ask the pull-request list again, after a response that said it was
 * not finished.
 *
 * Two decisions each right on their own read as a bug together. The board
 * fetches its own data and settles in about a second; the masthead reports the
 * LIST's state, and the list's state only changes when a response replaces it.
 * Nothing asked for another response until the twenty-second tick. Measured in
 * the real bundle: at t=1.0s the board was complete and correct while the
 * masthead still read "Loading pull requests…", and it went on reading that
 * until t=20.1s. The same `loading` flag gates the "nothing waiting on you →
 * show Mine" fallback, so that sat out the whole tick as well.
 *
 * A separate module because it is the one part of this that is a decision
 * rather than a wiring detail, and a decision is worth being able to test
 * without a browser.
 */

/** The background revalidation of a list nobody is waiting on. */
export const POLL_MS = 20_000;

/** How soon to collect on an unfinished answer. The board completes at about
 *  t=1.0s, so this is the first delay that is reliably after it. */
export const SETTLE_MS = 1_500;

/** Only the two fields that mean "there is more coming". */
export type Unfinished = { loading?: boolean; checksPending?: boolean };

export type Settle = {
  /** Milliseconds to wait before asking again; null when there is no more to
   *  come and anything already scheduled should be cancelled. */
  wait: number | null;
  /** What to pass back as `current` after the next unfinished response. */
  next: number;
};

/**
 * The delay before the next request, and the one after that.
 *
 * It doubles rather than repeating, and stops at the poll interval. A server
 * that settles — the measured case, and every ordinary one — is asked exactly
 * once more, 1.5s later. A server that is genuinely stuck is asked at 1.5s, 3s,
 * 6s, 12s and then no faster than it would have been polled anyway, instead of
 * every second and a half for as long as the view stays open.
 */
export function settleAfter(r: Unfinished, current: number = SETTLE_MS): Settle {
  if (!r.loading && !r.checksPending) return { wait: null, next: SETTLE_MS };
  return { wait: Math.min(current, POLL_MS), next: Math.min(current * 2, POLL_MS) };
}
