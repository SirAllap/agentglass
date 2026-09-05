// When a failed read is worth interrupting somebody about.
//
// The board used to put an amber strip across itself on ANY failed poll: "ClickUp
// did not answer in time — showing what was last read". It was true about the
// request and wrong about the situation. Reported as arriving often and meaning
// nothing — "I don't even know what it means… everything seems fine… it causes
// worry or confusion" — and it was right to be read that way: the rows on
// screen were minutes old and correct, and the next poll was seconds away.
//
// One slow request is noise. A board that has stopped being read is news. The line
// between them is age, measured against how often this board is polled rather than
// against a constant, because the built-in board is deliberately polled slowly and
// must not be accused of staleness at the same age as a fast one.

export type ReadState =
  /** Nothing failed. */
  | "fine"
  /** A read failed and it does not matter yet: rows on screen, recently read. A word
   *  in the header, beside the age it is about. */
  | "retrying"
  /** What is on screen cannot be trusted — nothing at all, or old enough that the
   *  board may have moved on without it. */
  | "stale";

/** The floor under the age test. Four polls of a fast board is two minutes, which is
 *  well inside "it is about to fix itself"; nobody should be told a board is stale
 *  before ten minutes have passed. */
export const STALE_FLOOR_MS = 10 * 60_000;

/** How many polls in a row have to come to nothing before it is news. */
export const STALE_POLLS = 4;

export function staleAfterMs(pollMs: number): number {
  return Math.max(STALE_POLLS * Math.max(0, pollMs), STALE_FLOOR_MS);
}

export function readState(o: {
  /** What the last read said went wrong, if anything. */
  error?: string;
  /** When the answer on screen was read. */
  at?: number;
  /** How many rows are on screen. */
  rows: number;
  /** How often this board re-reads itself. */
  pollMs: number;
  now?: number;
}): ReadState {
  if (!o.error) return "fine";
  // Nothing on screen: there is no "last answer" to fall back on, so the failure IS
  // the whole state of the panel and it has to say so.
  if (o.rows <= 0) return "stale";
  const at = o.at ?? 0;
  if (!at) return "stale";
  const age = (o.now ?? Date.now()) - at;
  return age < staleAfterMs(o.pollMs) ? "retrying" : "stale";
}
