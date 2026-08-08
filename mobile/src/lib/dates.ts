/*
 * Dates as a person reads them.
 *
 * Pure, and in its own file for a reason that is not tidiness: anything a test
 * imports must not reach `react-native`, whose entry point is Flow-typed and
 * which the test runner cannot parse. A helper living inside a screen is a
 * helper nothing can check.
 */

/**
 * "in 3d", "2d late", "today" — a due date is only ever read as a distance.
 *
 * The wire carries a LOCAL CALENDAR DATE (`2026-08-31`), already converted from
 * the provider's epoch by the server, and the trap is treating it as an
 * instant. `Date.parse("2026-08-31")` is midnight UTC, so subtracting `now`
 * puts a card due today into "1d late" for anybody west of UTC from mid-morning
 * on, and into "tomorrow" for anybody east of it late at night — wrong every
 * day, quietly, in a number people plan around.
 *
 * So this compares CALENDARS: the card's date against the device's, both
 * normalised the same way.
 */
export function dueIn(
  date: string | null | undefined,
  today: Date,
): { text: string; late: boolean } | null {
  if (!date) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parts) return null;
  const at = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  const here = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((at - here) / 86_400_000);
  if (days < 0) return { text: `${-days}d late`, late: true };
  // Today counts as late because it is the last day it is not: a card due at
  // 09:00 has hours left and is still the first one to look at.
  if (days === 0) return { text: "today", late: true };
  if (days === 1) return { text: "tomorrow", late: false };
  return { text: `in ${days}d`, late: false };
}

/** "3h", "2d" — how long since something last moved. Takes an ISO instant,
 *  which is what GitHub answers with, and is a genuine elapsed time rather than
 *  a calendar distance. */
export function since(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}
