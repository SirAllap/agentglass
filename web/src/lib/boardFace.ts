/*
 * What the Board may say when it has no rows.
 *
 * Two empty arrays are four different things: a list nobody has asked for yet,
 * a list the server is still reading, a read that failed, and an answer that
 * really is "nothing". Only the last may be said as a sentence — "Nothing wants
 * anything from you, this is an answer, not a wait" — and the Board used to say
 * it for all four.
 *
 * Measured on a merge: every write drops the server's cached lists, so the
 * first read after it comes back as `{ prs: [], loading: true, fetchedAt: 0 }`
 * while the real read runs behind it. The board took that response for an
 * answer, REPLACED the rows it was showing with its empty array and went to
 * "nothing", and stayed there for the seconds the read took, under a masthead
 * that was reading "Loading pull requests…" at the same moment.
 *
 * A module of its own because both halves are decisions rather than wiring,
 * and a decision can be tested without a browser.
 */

/**
 * How soon the board asks again after a list said it was still reading.
 *
 * The table's own re-ask waits 1.5s, and it is that wait that kept a freshly
 * invalidated board blank for the whole of it even when the read behind it took
 * 400ms (measured, fake GitHub). The ask is to this server's cache and starts no
 * read of its own — `refreshList` joins the one in flight — so a short first
 * delay costs no GitHub request. It doubles from here, see prSettle.ts.
 */
export const BOARD_ASK_MS = 500;

/** The part of a list response the decision reads. `null` is a call that threw. */
export type ListRead = { prs: readonly unknown[]; loading?: boolean; error?: string } | null;

export type ListOutcome =
  /** Rows are in, or the list is truly empty: replace what is on screen. */
  | "answered"
  /** The server is still reading and has nothing yet: this is not an answer,
   *  so what is on screen stays and the board asks again. */
  | "reading"
  /** The read failed: what is on screen stays, and an empty board says so. */
  | "failed";

export function listOutcome(r: ListRead): ListOutcome {
  if (!r) return "failed";
  if (r.prs.length) return "answered";
  if (r.loading) return "reading";
  return r.error ? "failed" : "answered";
}

export type BoardFace =
  /** A skeleton: no answer yet, and no number to say. */
  | "waiting"
  /** Lanes. A refresh underneath them changes nothing on screen. */
  | "rows"
  /** Both lists are in, and the board's own filters hid every row of them. */
  | "filtered"
  /** A list could not be read. Not an empty answer, so it never says one. */
  | "failed"
  /** Both lists are in, and nothing wants anything from you. */
  | "empty";

export function boardFace(a: {
  /** A list is being asked for, or the server is still reading it. */
  reading: boolean;
  /** Rows are here, their check states are not — see `settling` on the board. */
  settling: boolean;
  /** Cards on the board, after the filters. */
  involved: number;
  /** A list could not be read on the last ask. */
  failed: boolean;
  /** Rows that came in and were hidden by the board's filters. */
  hidden: number;
}): BoardFace {
  if (a.settling) return "waiting";
  if (a.involved > 0) return "rows";
  if (a.reading) return "waiting";
  if (a.failed) return "failed";
  return a.hidden > 0 ? "filtered" : "empty";
}
