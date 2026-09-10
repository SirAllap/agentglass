/*
 * WHICH PANES ARE A SEAT — asked without importing the seat.
 *
 * `lantern.ts` has to know whether a row on the board IS the orchestrator, and
 * `seat.ts` reads the board: importing one from the other is a cycle. So this
 * is a leaf over the two tables, the same shape as `seatrole.ts` beside it.
 *
 * WHY THE PANE AND NOT THE SESSION. `isSeatSession` answers by session id, and
 * a session id is not stable enough to rest this on: an orchestrator that is
 * resumed, restarted or re-adopted carries a new one, and the board also
 * carries hook rows for the same pane under whatever the tmux window is called.
 * The failure that came of it is precise — the seat was woken, hourly, by a
 * finding about ITSELF: "orchestrator is waiting for your next prompt — 1h",
 * which is not a change in the field, it is the chair sitting in the chair.
 *
 * A pane is the one fact this app already rests liveness on, and it is the
 * same pane whatever the session inside it is called.
 */
import { db } from "./db.ts";
import { SEAT_ROLE } from "./seatmark.ts";

const adopted = db.query<{ p: string }, []>(
  `SELECT adopted_pane AS p FROM seat WHERE ended_at IS NULL AND adopted_pane <> ''`);
const opened = db.query<{ p: string }, [string]>(
  `SELECT pane_id AS p FROM named_agent WHERE ended_at IS NULL AND name LIKE ?`);

/** Every pane an orchestrator is sitting in right now, by either door: a seat
 *  this app opened, or a session that adopted the chair. */
export function seatPanes(): Set<string> {
  const out = new Set<string>();
  try {
    for (const r of adopted.all()) if (r.p) out.add(r.p);
    for (const r of opened.all(`${SEAT_ROLE}-%`)) if (r.p) out.add(r.p);
  } catch { /* before the tables exist, nobody is seated */ }
  return out;
}
