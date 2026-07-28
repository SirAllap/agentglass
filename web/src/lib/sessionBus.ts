/**
 * "A session changed" — one signal, every consumer.
 *
 * The sibling of `gitBus`. The server already broadcasts a `session` frame
 * every time it ingests an event, and the cockpit deliberately ignores it: its
 * Sessions panel owns a poll and re-reads on its own clock, which is fine when
 * the panel is a few feet from the machine.
 *
 * The companion cannot do that. A phone poll is a radio wake, so its interval
 * was tuned for battery rather than for truth, and the result was a screen that
 * was always a little bit wrong. This is how it finds out instead.
 *
 * Deliberately not coalesced here. The frame fires on every ingest — several a
 * second under a busy fleet — and how much of that a consumer wants is the
 * consumer's business: a list can wait a second, and an open conversation
 * cannot. Debouncing centrally would impose the slowest answer on everyone.
 */

const listeners = new Set<(sessionId: string) => void>();

/** Called by the live socket when the server reports a session rollup changed. */
export function sessionChanged(sessionId: string): void {
  for (const fn of listeners) {
    try { fn(sessionId); } catch { /* one bad listener must not stop the rest */ }
  }
}

export function subscribeSessionChanged(fn: (sessionId: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
