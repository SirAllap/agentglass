// How old a plan reading is, said out loud.
//
// The server keeps the last good numbers through a burst of 429s rather than
// blanking the meters, which means what is on screen can legitimately be a
// while behind. That is the right trade — a five-hour window moves by a
// fraction of a percent a minute, so a slightly old percentage is still a true
// answer and "Rate-limited" is not an answer at all. But showing an old number
// as though it were live is the other way to lie about it, so past the point
// where a refresh should have landed, the strip says how old it is.

/**
 * Anything under this is a normal cycle, not staleness.
 *
 * The server refreshes upstream every 15 minutes and the browser polls the
 * server every 5, so a reading can be a shade over 20 minutes old with nothing
 * whatsoever wrong. Labelling that would train you to ignore the label.
 */
export const STALE_AFTER_MS = 25 * 60_000;

/**
 * "8m", "3h", "2d" — or null while the reading is fresh enough that saying so
 * would be noise. Deliberately coarse: the point is "this stopped refreshing",
 * and a ticking seconds count in a status strip reads as an alarm.
 */
export function stalenessLabel(fetchedAt: number, now: number = Date.now()): string | null {
  const ms = now - fetchedAt;
  // A clock that has gone backwards (a resume, an NTP step) is not staleness.
  if (ms < STALE_AFTER_MS) return null;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
