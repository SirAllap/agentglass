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

/**
 * "3h", "2d" — how long since something last moved.
 *
 * A genuine elapsed time rather than a calendar distance, which is why it does
 * not share `dueIn`'s machinery: a due date is a day somebody planned around
 * and this is a duration.
 *
 * Two spellings of an instant, because the two services answer differently and
 * neither is worth converting at the call site. GitHub sends an ISO string;
 * ClickUp sends epoch milliseconds, which reach here as a number.
 *
 * Measured rather than assumed, because the obvious worry turned out to be the
 * wrong one: `Date.parse("1787914800000")` is NaN, not a date in the year 1755
 * — only a bare four-digit string reads as a year. So the failure this union
 * prevents is not a wildly wrong duration, it is a SILENT one: every timestamp
 * on the card screen quietly blank, which reads as "this app does not show
 * those" rather than as a fault.
 */
export function since(when: string | number, now: number): string {
  const at = typeof when === "number" ? when : Date.parse(when);
  // Zero is ClickUp's "no date", not 1970. Both are useless to a reader and
  // the empty string is what the screens already draw for "unknown".
  if (!Number.isFinite(at) || at <= 0) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}
