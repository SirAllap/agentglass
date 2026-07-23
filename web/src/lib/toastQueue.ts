/**
 * The notch's toast lane: which note to show next, and which to give up on.
 *
 * A toast is a claim that something *just* happened. The lane plays one note at
 * a time for a fixed few seconds, so it can only ever drain at a fixed rate,
 * and anything arriving faster than that queues. Left unbounded that queue
 * stops being a feed and becomes a backlog: notes are shown minutes after the
 * thing they describe, and the notch narrates a past you already lived through.
 *
 * That was observed rather than theorised. A notification raised while Do Not
 * Disturb was on was still being toasted about two minutes later, behind a
 * queue of others released at the same moment.
 *
 * So the lane has a policy, and it lives here rather than inside the component
 * because it is the part worth testing:
 *
 *   - notes that went stale while queued are dropped, not shown late
 *   - the queue is capped, so a burst collapses instead of promising to play
 *     every item
 *   - urgent notes jump ahead of ordinary ones and are exempt from both
 *
 * That last rule is the point of the whole file. Since #138 a gate hold shares
 * this lane with Slack, and a gate hold has a stopped agent behind it: it must
 * not wait out a backlog of chatter, and it must never be discarded for being
 * late, because "late" still means someone is blocked.
 */

/** The queue only needs these two fields; the notch's own Note supplies the rest. */
export type Queueable = { at: number; urgent?: boolean };

/** A toast is for the transition. Past this, the history behind the notch is
 *  the right place for it, and it has one: nothing is lost by not toasting. */
export const STALE_MS = 10_000;

/** Past this the lane is a backlog, not a feed. Chosen against NOTE_MS: four
 *  notes is already about twenty seconds of talking. */
export const QUEUE_MAX = 4;

/**
 * Add a note, in place, and return the queue.
 *
 * Urgent notes are placed ahead of every ordinary one but behind other urgent
 * ones, so an agent waiting on you is never stuck behind a sticker, and two
 * blocked agents are still answered in the order they blocked.
 *
 * Trimming only ever discards ordinary notes. A queue that is all urgent is
 * allowed to exceed the cap: dropping one would mean silently declining to
 * mention that something is blocked.
 */
export function enqueue<T extends Queueable>(queue: T[], note: T, max = QUEUE_MAX): T[] {
  if (note.urgent) {
    const firstOrdinary = queue.findIndex((n) => !n.urgent);
    if (firstOrdinary < 0) queue.push(note);
    else queue.splice(firstOrdinary, 0, note);
  } else {
    queue.push(note);
  }

  // Oldest ordinary first: in a burst the newest are the ones still worth
  // saying, and the old ones are exactly what made the lane fall behind.
  while (queue.length > max) {
    const oldest = queue.findIndex((n) => !n.urgent);
    if (oldest < 0) break;
    queue.splice(oldest, 1);
  }
  return queue;
}

/**
 * Take the next note worth showing, discarding any that went stale while they
 * waited. Returns null when nothing is left to say.
 *
 * Staleness is measured from when the note was queued, not from when the thing
 * happened, because that is what the lane is responsible for: if a note sat
 * here for longer than a toast is worth, the lane failed it and showing it now
 * only misleads about when it arrived.
 */
export function dequeue<T extends Queueable>(queue: T[], now: number, staleMs = STALE_MS): T | null {
  for (;;) {
    const next = queue.shift();
    if (!next) return null;
    if (next.urgent || now - next.at <= staleMs) return next;
  }
}
