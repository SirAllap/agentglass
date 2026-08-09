/*
 * How much of the plan is left, as a phone reads it.
 *
 * `/usage/providers` answers the same `ProviderUsage[]` the dashboard's Usage
 * panel draws, so nothing about the numbers is decided here: the server already
 * talked to Anthropic (or read what the Codex CLI wrote), rounded the
 * percentages and named the windows. What this file decides is the phone's
 * question, which is a different one.
 *
 * The desk asks "how much have I used", because it has room for five bars and a
 * person sitting in front of them. A phone is looked at for two seconds on the
 * way somewhere, and the thing being asked is "have I got enough left to start
 * this". So every number that leaves this file is REMAINING, and the headline is
 * the window that runs out first rather than the first window in the list.
 *
 * Data, not JSX, for the reason dates.ts gives: a helper that lives inside a
 * screen is a helper no test can reach, because `react-native`'s entry point
 * cannot be parsed by the test runner.
 */
import type { ProviderUsage, QuotaWindow } from "../../../shared/types.ts";

/** A window with the provider that reported it, so a headline can name both. */
export interface TightWindow {
  /** The provider's screen name ("Claude"), not its id. */
  provider: string;
  window: QuotaWindow;
  /** When THAT provider was last asked, carried here so the headline can date
   *  itself without the card searching the list back for the row it came from. */
  observedAt?: number;
}

/** What is left of a window, 0..100. Clamped rather than trusted: a provider
 *  that reports 103% used would otherwise render a negative bar. */
export function remainingOf(window: QuotaWindow): number {
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

/**
 * The window closest to running out, across every provider.
 *
 * This is the one number the card exists to show. Providers that cannot report
 * are skipped rather than counted as empty: "nothing is close to its limit" and
 * "nobody would say" are different answers, and only the first one is a reason
 * to start a long turn.
 *
 * Ties go to the window already found, which keeps the headline still while two
 * windows sit at the same percentage instead of swapping on every poll.
 */
export function tightestWindow(rows: ProviderUsage[] | null): TightWindow | null {
  let best: TightWindow | null = null;
  for (const row of rows ?? []) {
    if (!row.available) continue;
    for (const window of row.windows) {
      if (!best || window.usedPercent > best.window.usedPercent) {
        best = { provider: row.label, window, observedAt: row.observedAt };
      }
    }
  }
  return best;
}

/**
 * The colour a level has earned, as one of the tones theme.ts already paints.
 *
 * The thresholds are the dashboard's (`usedColor` in web/src/lib/usageStore.ts)
 * and are deliberately not re-picked here: the phone and the desk are two
 * windows onto one plan, and a bar that is amber on the monitor and green in
 * your hand is a bug in whichever one you are not looking at.
 *
 * `crit` is spent on this, which is worth stating because Home otherwise keeps
 * that colour for an agent blocked on a person. A plan at 85% is the other way
 * the machine stops: the difference between "an agent is waiting for you" and
 * "an agent is about to be cut off" is not one a person needs at a glance.
 */
export function quotaTone(usedPercent: number): "crit" | "bad" | "good" {
  if (usedPercent >= 85) return "crit";
  if (usedPercent >= 60) return "bad";
  return "good";
}

/** "in 1h 44m" while it is soon, "Wed 3:00 PM" once it is not. The same two
 *  shapes the desk uses, for the same reason: a reset eleven hours out is read
 *  as a duration, and one three days out is read as a day. */
export function resetLabel(iso: string | null, now: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const ms = at - now;
  if (ms <= 0) return "now";
  if (ms < 24 * 3_600_000) {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    return hours >= 1 ? `in ${hours}h ${minutes}m` : `in ${minutes}m`;
  }
  const when = new Date(at);
  return `${when.toLocaleDateString([], { weekday: "short" })} ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/**
 * How old a reading is.
 *
 * Load-bearing, and more so here than on the desk. The server holds its
 * Anthropic reading for fifteen minutes and keeps showing the last good one for
 * up to a day while the endpoint answers 429, so a phone that drew the number
 * bare would present yesterday's percentage in the same type as a live one.
 * Under two minutes it says nothing at all: a precise age on a fresh number is
 * noise on a screen this size.
 */
export function ageLabel(observedAt: number | undefined, now: number): string {
  if (!observedAt) return "";
  const ms = now - observedAt;
  if (ms < 2 * 60_000) return "";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m old`;
  if (ms < 24 * 3_600_000) return `${Math.floor(ms / 3_600_000)}h old`;
  return `${Math.floor(ms / (24 * 3_600_000))}d old`;
}

/**
 * What the card should draw, decided away from the drawing.
 *
 * Four states, and collapsing any two of them is the bug this exists to
 * prevent. The one that matters most on a phone is `unreachable`: a card that
 * fell back to a blank bar when the wifi died would claim the plan is empty,
 * which is the single most expensive thing it could get wrong.
 *
 *   loading      the first answer has not landed yet
 *   unreachable  it landed and it was a failure, with nothing good held over
 *   empty        the machine answered, and no installed agent reports a quota
 *   rows         there is something to draw
 */
export function planState(
  loaded: boolean,
  rows: ProviderUsage[] | null,
): "loading" | "unreachable" | "empty" | "rows" {
  if (rows) return rows.length ? "rows" : "empty";
  return loaded ? "unreachable" : "loading";
}
