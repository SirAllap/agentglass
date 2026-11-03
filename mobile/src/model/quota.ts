/*
 * How much of the plan is used, as a phone reads it.
 *
 * `/usage/providers` answers the same `ProviderUsage[]` the dashboard's Usage
 * panel draws. What this file decides is which reading of a row the phone may
 * draw, and how it is worded.
 *
 * Both questions have one answer for both surfaces: the top-bar panel and this
 * sheet call `openCodePanelWindows`, so a percentage on the monitor and one in
 * your hand come from the same reading. And the number says USED, as the desk's
 * does; the headline is the window closest to its limit rather than the first
 * window in the list.
 *
 * Data, not JSX, for the reason dates.ts gives: a helper that lives inside a
 * screen is a helper no test can reach, because `react-native`'s entry point
 * cannot be parsed by the test runner.
 */
import { openCodePanelWindows, type PanelWindows } from "../../../shared/opencodePanel.ts";
import type { ProviderUsage, QuotaWindow } from "../../../shared/types.ts";

/** A window with the provider that reported it, so a headline can name both. */
export interface TightWindow {
  /** The provider's screen name ("Claude"), not its id. */
  provider: string;
  window: QuotaWindow;
  /** Whether this window is this PC's arithmetic rather than the plan's number. */
  estimated: boolean;
  /** When THAT reading was taken, carried here so the headline can date itself
   *  without the card searching the list back for the row it came from. */
  observedAt?: number;
}

/** The windows a row is drawn from, as the desk draws them. OpenCode Go's
 *  console reading wins while it is drawable; every other row is what the
 *  provider reported. Per-window estimates ride along, because a row can mix a
 *  console window with one this PC had to fill in. */
export function planWindows(row: ProviderUsage, now: number): PanelWindows {
  if (row.provider !== "opencode") return { windows: row.windows, estimate: false };
  return openCodePanelWindows(row, now);
}

/** The minutes of a plan that are this PC's arithmetic, the desk's rule: the
 *  windows whose console reset had passed, or every one when no console reading
 *  is drawable at all. */
export function estimatedWindows(plan: PanelWindows): Set<number> {
  const all = plan.estimate ? plan.windows.map((w) => w.minutes) : [];
  return new Set(plan.estimatedMinutes ?? all);
}

/** Whether any bar in a plan is the console's own number rather than this PC's
 *  arithmetic for it. */
function drawnFromConsole(row: ProviderUsage, plan: PanelWindows): boolean {
  const estimated = estimatedWindows(plan);
  return !!row.calibration && plan.windows.some((w) => !estimated.has(w.minutes));
}

/** When the reading a plan draws was taken. A console window is dated by the
 *  read, not by this PC's last step, which says nothing about that number. */
export function planReadAt(row: ProviderUsage, plan: PanelWindows): number | undefined {
  return drawnFromConsole(row, plan) ? row.calibration!.at : row.observedAt;
}

/** What a window has used, 0..100. Clamped rather than trusted: a provider
 *  that reports 103% used would otherwise draw past its track. */
export function usedOf(window: QuotaWindow): number {
  return Math.max(0, Math.min(100, window.usedPercent));
}

/**
 * The window closest to running out, across every provider.
 *
 * This is the one number the card exists to show. Providers that cannot report
 * are skipped rather than counted as empty: "nothing is close to its limit" and
 * "nobody would say" are different answers, and only the first one is a reason
 * to be careful with a long turn.
 *
 * Ties go to the window already found, which keeps the headline still while two
 * windows sit at the same percentage instead of swapping on every poll.
 *
 * A login the computer lists but is not signed in as is not in the running: the
 * headline answers "can I start a long one" with the account that would run it.
 */
export function tightestWindow(rows: ProviderUsage[] | null, now = Date.now()): TightWindow | null {
  let best: TightWindow | null = null;
  for (const row of rows ?? []) {
    if (!row.available || row.account?.active === false) continue;
    const plan = planWindows(row, now);
    const estimated = estimatedWindows(plan);
    const observedAt = planReadAt(row, plan);
    for (const window of plan.windows) {
      if (!best || window.usedPercent > best.window.usedPercent) {
        best = { provider: row.label, window, estimated: estimated.has(window.minutes), observedAt };
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

/** Where a row's numbers come from. The tag is the desk's own: "estimate · this
 *  PC" for arithmetic this machine did, the reading's source otherwise. */
export function sourceLine(row: ProviderUsage, plan: PanelWindows): string {
  const source = row.source ?? "";
  if (row.provider !== "opencode") return source;
  // "opencode stats" is the CLI's own total: planWindows has nothing to add.
  if (source && source !== "this PC" && source !== "console" && source !== "console key") return source;
  // A stored key is not evidence for the numbers in hand: a page read taken
  // before the key was saved would be credited to a read it never made.
  return drawnFromConsole(row, plan) ? "console" : "this PC estimate";
}

/** "read 4m ago", the half of the footer after the source. Empty when the row
 *  carries no date. */
export function readLine(at: number | undefined, now: number): string {
  if (!at) return "";
  const age = ageLabel(at, now);
  return age ? `read ${age.replace(/ old$/, " ago")}` : "read just now";
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

/** The window's name as a person says it: "5h" is the five-hour window. */
export function windowName(label: string): string {
  if (/^5h$/i.test(label)) return "5-hour";
  if (/^weekly$/i.test(label)) return "Weekly";
  return label;
}

/** The heading over one login's bars: "Work A · max". Null for a row that is
 *  not one of several logins. The id and storage never reach the phone. */
export function accountHeading(row: ProviderUsage): string | null {
  const a = row.account;
  if (!a) return null;
  return [a.label, a.plan].filter(Boolean).join(" · ");
}

/** How many providers are reporting, as opposed to how many rows: two logins
 *  of one provider are still one provider to name on a bar. */
export function providerCount(rows: ProviderUsage[]): number {
  return new Set(rows.map((r) => r.provider)).size;
}
