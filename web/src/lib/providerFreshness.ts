/*
 * How old a provider's answer is, said only when the age changes what it means.
 *
 * `ProviderStatus.at` has been set since the field was written — the ClickUp
 * snapshot's timestamp, or the card watcher's last run — and its own doc
 * comment says it exists "so the page can say 'as of' instead of implying it
 * just asked". No page said it. The field was written in three places and read
 * in none, which is the failure mode a status field is most prone to: the
 * server does the honest work and the screen quietly presents a cached verdict
 * as a live one.
 *
 * Two decisions live here rather than in the JSX, because both are judgements
 * and neither is obvious from a render:
 *
 * 1. WHEN it is worth saying. A row that was checked four seconds ago is not
 *    telling you anything by admitting it, and "checked just now" on four rows
 *    is four lines of noise on the one screen people open when something is
 *    already wrong. Under the window, this says nothing at all.
 *
 * 2. THAT IT IS A CLOCK TIME, not "3m ago". Settings stops re-polling the
 *    moment nothing is `pending`, so a relative age computed at render is
 *    frozen at render — a pane left open for half an hour would still read
 *    "3m ago", which is a staleness indicator that has itself gone stale. A
 *    clock time is true whenever it is read.
 */

/**
 * How fresh an answer has to be before its age is not worth mentioning.
 *
 * Two minutes, from the two things `at` can be: the ClickUp task snapshot,
 * whose cache TTL is 60s, and the card watcher, which runs on a three-minute
 * timer. One minute would put a healthy watcher permanently in the "worth
 * mentioning" bucket for no reason; two clears the snapshot's TTL and still
 * catches an answer that has genuinely stopped being refreshed.
 */
export const FRESH_MS = 120_000;

/** `14:32`, in the reader's own clock. */
function clock(at: number): string {
  const d = new Date(at);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The line to put under a provider's detail, or "" for no line.
 *
 * "" rather than null so the caller can render it without a conditional that
 * would have to decide the same thing a second time.
 */
export function checkedLine(at: number | undefined, now = Date.now()): string {
  if (!at || at > now) return "";
  if (now - at < FRESH_MS) return "";
  const age = now - at;
  const day = 86_400_000;
  // Past a day the clock time alone is ambiguous and reads as today's, which
  // is the one way this line could actively mislead.
  if (age >= day) {
    const days = Math.floor(age / day);
    return `Checked ${days} day${days === 1 ? "" : "s"} ago`;
  }
  return `Checked at ${clock(at)}`;
}
