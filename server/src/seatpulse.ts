/*
 * THE LAST HOUR, PER AGENT — twelve buckets of five minutes.
 *
 * "Quiet for an hour" is a phrase you have to take on trust. Twelve bars that
 * fall off a cliff five minutes in are a thing you SEE, and the difference
 * between an agent thinking hard about one file and an agent that stopped is
 * exactly the difference between a full row and an empty tail. The board
 * already knows WHO is on the field; this is what each of them has been doing
 * while they were there.
 *
 * Counted from `events`, which is the record every hook already writes, so no
 * new collection and nothing to keep in sync. One query for the whole field
 * rather than one per agent: a dozen sessions is a dozen round trips through
 * SQLite for an answer one GROUP BY gives.
 *
 * Buckets, not a smooth line. A five-minute bucket is roughly the coarsest
 * grain at which "it went quiet" is still legible within the hour, and it
 * keeps the row to twelve marks, which fits beside a name in a side column
 * without becoming a chart nobody reads.
 */
import { db } from "./db.ts";

export const BUCKETS = 12;
export const BUCKET_MS = 5 * 60_000;
export const WINDOW_MS = BUCKETS * BUCKET_MS;

/* Named parameters, not positional. The first version had four `?` and was
   called with three arguments, which SQLite answers by binding nothing and
   returning no rows — an empty pulse that looks exactly like an idle agent.
   Names cannot be miscounted. */
const q = db.query<{ session_id: string; bucket: number; n: number }, { $from: number; $step: number; $ids: string }>(`
  SELECT session_id, CAST((timestamp - $from) / $step AS INTEGER) AS bucket, COUNT(*) AS n
    FROM events
   WHERE timestamp >= $from
     AND session_id IN (SELECT value FROM json_each($ids))
   GROUP BY session_id, bucket
`);

/**
 * Twelve counts per session, oldest first, zero-filled.
 *
 * Zero-filled on purpose: a bucket with no events is the fact worth drawing,
 * and leaving it out would draw a busy agent and a stopped one the same way.
 */
export function pulses(sessionIds: string[], now = Date.now()): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const want = [...new Set(sessionIds.filter(Boolean))];
  if (!want.length) return out;
  for (const id of want) out.set(id, new Array(BUCKETS).fill(0));
  const from = now - WINDOW_MS;
  try {
    for (const r of q.all({ $from: from, $step: BUCKET_MS, $ids: JSON.stringify(want) })) {
      const row = out.get(r.session_id);
      /* A row that lands outside the window is a clock that moved between the
         two arguments, not data: dropped rather than clamped into the first
         bucket, where it would read as activity that did not happen. */
      if (row && r.bucket >= 0 && r.bucket < BUCKETS) row[r.bucket] = r.n;
    }
  } catch (e) {
    /* An unreadable events table is an empty pulse rather than a broken view.
       But it is SAID: the first version swallowed a mis-bound query in
       silence, and a silent empty pulse reads as five idle agents. */
    console.error("[seatpulse] could not read the last hour:", e);
  }
  return out;
}

/** Whether a row has anything in its most recent buckets — "moving now",
 *  asked of the drawing rather than of a status word. */
export function movingNow(pulse: number[] | undefined, tail = 2): boolean {
  if (!pulse) return false;
  return pulse.slice(-tail).some((n) => n > 0);
}
