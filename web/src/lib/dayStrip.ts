import type { UsageDay } from "../../../shared/types.ts";
import { api } from "./api.ts";

/** The chart's own height. Every state (loading, empty, data) fills exactly this,
 *  so the popover is the same size before and after the answer arrives. */
export const STRIP_HEIGHT = 34;

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

/** Weighted tokens where the server has them, the three that cost input otherwise. */
const dayTokens = (d: UsageDay): number => d.equiv_tokens ?? d.input_tokens + d.output_tokens + d.cache_creation_tokens;

export type StripState = "loading" | "empty" | "data";

/** `null` is "no answer yet". A failed fetch is set to `[]` by the caller, so
 *  it reads as empty rather than a strip that pulses for ever. */
export function stripState(days: UsageDay[] | null): StripState {
  if (days === null) return "loading";
  return days.some((d) => dayTokens(d) > 0) ? "data" : "empty";
}

/** Seven UTC days, oldest first, today last; a day the server has no row for is zero. */
export function dayCells(days: UsageDay[], now: number) {
  const byDay = new Map(days.map((d) => [d.day, dayTokens(d)]));
  return Array.from({ length: 7 }, (_, i) => {
    const t = new Date(now - (6 - i) * 86_400_000);
    const key = t.toISOString().slice(0, 10);
    return { key, wd: WEEKDAY[t.getUTCDay()]!, tokens: byDay.get(key) ?? 0 };
  });
}

/*
 * One shared answer. The chart used to fetch on mount, which is after the
 * popover has already been drawn: measured as the one box part that arrived
 * late. The top bar warms this while the strip is on screen, so by the time
 * the popover opens the answer is here; the last good answer is kept so a
 * reopen is instant, and each warm refreshes it.
 */
let last: UsageDay[] | null = null;
let inflight: Promise<UsageDay[]> | null = null;

/** Sheet totals subscribe: the answer lands after the first paint, and a total
 *  read once during render stayed blank for as long as the sheet was open. */
const watchers = new Set<() => void>();

export function subscribeDayStrip(fn: () => void): () => void {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

export const lastWeek = (): UsageDay[] | null => last;

export function warmDayStrip(): Promise<UsageDay[]> {
  inflight ??= api.usageDaily(7)
    .then((h) => {
      last = h.days;
      for (const fn of watchers) fn();
      return h.days;
    })
    .finally(() => { inflight = null; });
  return inflight;
}
