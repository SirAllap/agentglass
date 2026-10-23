/*
 * How old the list on screen is, and whether GitHub has stopped answering.
 *
 * The bar's age text used to read "just now / 2m" and nothing else. Two things
 * it could not say: that the rows are old because the app is saving requests
 * (or cannot make them), and that GitHub's hourly budget is gone. Pure, so the
 * thresholds are asserted rather than eyeballed.
 *
 * Under FRESH_MS the age reads as before. Between FRESH_MS and STALE_MS it
 * still does (the list is merely not new). Past STALE_MS it turns amber and
 * says "updated 40 min ago". While GitHub says the budget is spent it says so,
 * with the time it comes back, and that replaces the age: the rows are cached
 * and nothing is being asked.
 */
import type { PrRate } from "../../../shared/types.ts";

export const FRESH_MS = 5 * 60_000;
export const STALE_MS = 15 * 60_000;

export type FreshTone = "fresh" | "aging" | "stale" | "limited";
export interface Freshness { tone: FreshTone; text: string; title: string }

/** 19:40, on a 24-hour clock whatever the locale. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** The age the bar has always shown: "just now", "2m", "3h", "1d". */
export function shortAge(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** "40 min ago", "2 h ago", "1 d ago" — the long form, for the amber text. */
export function longAge(ms: number): string {
  const m = Math.max(0, ms) / 60_000;
  if (m < 60) return `${Math.max(1, Math.round(m))} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

/** "4,210 of 5,000 left, resets 19:40", or null when GitHub has not said. */
export function budgetLine(rate: PrRate | undefined | null): string | null {
  if (!rate || !rate.limit) return null;
  const left = `${rate.remaining.toLocaleString("en-US")} of ${rate.limit.toLocaleString("en-US")} left`;
  return rate.resetAt ? `${left}, resets ${clock(rate.resetAt)}` : left;
}

/** The red-ish message while the budget is spent, or null. */
export function limitMessage(rate: PrRate | undefined | null, now = Date.now()): string | null {
  if (!rate?.limited || rate.resetAt <= now) return null;
  return `GitHub limit reached · retry at ${clock(rate.resetAt)}`;
}

/** What the bar's age text says. Null before anything was read. */
export function freshness(dataAt: number, rate: PrRate | undefined | null, now = Date.now()): Freshness | null {
  const limited = limitMessage(rate, now);
  if (limited) {
    return {
      tone: "limited", text: limited,
      title: `GitHub's hourly request budget is used up, so nothing is being asked until ${clock(rate!.resetAt)}. The cards show what was read last${dataAt ? ` (${longAge(now - dataAt)})` : ""}.`,
    };
  }
  if (!dataAt) return null;
  const age = now - dataAt;
  if (age >= STALE_MS) {
    return {
      tone: "stale", text: `updated ${longAge(age)}`,
      title: "Cached to save GitHub requests — this list was last read from GitHub that long ago. Press refresh to read it again.",
    };
  }
  return {
    tone: age < FRESH_MS ? "fresh" : "aging", text: shortAge(age),
    title: `Last read from GitHub ${age < 90_000 ? "just now" : longAge(age)}.`,
  };
}

/** The refresh button's tooltip: what it does, then the budget when known. */
export function refreshTitle(base: string, rate: PrRate | undefined | null): string {
  const line = budgetLine(rate);
  return line ? `${base}\n${line}` : base;
}
