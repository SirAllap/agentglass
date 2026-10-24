import type { ProviderUsage } from "../../../shared/types.ts";

/*
 * After a switch the server drops the old login's numbers and the new login's
 * are not there yet. The plan strip used to disappear (an unavailable row is
 * skipped by the busiest-provider rule) and stayed gone until the next
 * five-minute poll; a meter that vanishes reads as "nothing used". So the last
 * strip stays on screen, marked with the existing "last read Xm ago" wording,
 * until the new login's own row arrives, and the window asks again a few times
 * soon after the switch.
 *
 * Pure decisions only; usageStore owns the timers and the fetch.
 *
 * Ceiling: the held numbers are the previous login's, drawn dimmed and dated.
 * They are not the new login's and are never recorded as pace samples.
 */

/** Past this the old login's numbers are no longer shown, whatever the age label says. */
export const HOLD_MAX_MS = 15 * 60_000;
/** Quick re-asks after a switch: three, doubling. Not a poll interval. */
export const RETRY_MS = [2_000, 4_000, 8_000] as const;

export type Hold = Map<string, { row: ProviderUsage; at: number }>;

const isCore = (u: ProviderUsage) => !u.account || u.account.active;

/** What is on screen at the moment of the switch: the available rows of the login in use, by provider. */
export function startHold(rows: ProviderUsage[] | null, now: number): Hold {
  const h: Hold = new Map();
  for (const r of rows ?? []) if (r.available && isCore(r)) h.set(r.provider, { row: r, at: now });
  return h;
}

/** A provider is released when its login in use has a reading, or when the hold is too old. */
export function settleHold(hold: Hold, rows: ProviderUsage[] | null, now: number): Hold {
  const next: Hold = new Map();
  for (const [p, h] of hold) {
    if (now - h.at >= HOLD_MAX_MS) continue;
    if ((rows ?? []).some((r) => r.provider === p && r.available && isCore(r))) continue;
    next.set(p, h);
  }
  return next;
}

/** The wait before attempt `n` (0-based), or null when none is left or nothing is held. */
export function retryDelay(hold: Hold, attempt: number): number | null {
  return hold.size > 0 ? RETRY_MS[attempt] ?? null : null;
}

const peak = (u: ProviderUsage) => u.windows.reduce((m, w) => Math.max(m, w.usedPercent), -1);

/** The row for the strip: the live one, else the busiest held one, flagged. */
export function stripRow(live: ProviderUsage | null, held: ProviderUsage[]): { u: ProviderUsage | null; held: boolean } {
  if (live?.available || !held.length) return { u: live, held: false };
  return { u: held.reduce((b, r) => (peak(r) > peak(b) ? r : b)), held: true };
}

/** Always minutes, at least one: a held strip is marked even when its numbers are seconds old. */
export function heldAgeLabel(observedAt: number | undefined, now: number): string {
  return `${Math.max(1, Math.floor((now - (observedAt ?? now)) / 60_000))}m`;
}
