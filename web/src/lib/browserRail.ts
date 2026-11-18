/*
 * What the Browser icon in the rail says: how many tabs are open, and whether
 * an agent is driving one.
 *
 * The browser panel knows both (its tab list and its per-tab agent activity),
 * so it publishes here when either changes and the workspace reads one
 * snapshot. Events only: nothing here polls, and nothing is sent anywhere.
 */
import { IDLE_RELEASE_MS, type Activity } from "./browserAgentActivity.ts";

export interface BrowserRailFacts { tabs: number; driven: boolean }

/** When the last ask on this tab was, or 0 when there was none. */
const lastAsk = (a: Activity[string]): number => a.lastAt ?? a.log[a.log.length - 1]?.at ?? 0;

/**
 * Whether an agent holds an open tab right now: it is mid-ask, or it has
 * asked something and neither finished nor been paused by the person, within
 * the idle window after which the browser lets go of its viewport. Activity
 * left behind by a closed tab is skipped: only an open tab can be driven, so
 * with no tab open this is always false. Pure.
 */
export function agentDrives(acts: Activity, now: number, open: readonly string[]): boolean {
  for (const id of open) {
    const a = acts[id];
    if (!a || a.paused || a.done) continue;
    if (a.working > 0) return true;
    const last = lastAsk(a);
    if (last && now - last <= IDLE_RELEASE_MS) return true;
  }
  return false;
}

/**
 * How many ms from `now` until `agentDrives` can turn false with no event:
 * the end of the earliest idle window among open tabs held only by a recent
 * ask. Null when no such window is running (a mid-ask tab ends with an event,
 * not a clock). The panel arms one timeout for it. Pure.
 */
export function nextDriveCheck(acts: Activity, now: number, open: readonly string[]): number | null {
  let next = Infinity;
  for (const id of open) {
    const a = acts[id];
    if (!a || a.paused || a.done || a.working > 0) continue;
    const last = lastAsk(a);
    if (last && now - last <= IDLE_RELEASE_MS) next = Math.min(next, last + IDLE_RELEASE_MS - now + 1);
  }
  return next === Infinity ? null : next;
}

/** The icon's tooltip words, or null when there is nothing to add. Pure. */
export function railTipFor(f: BrowserRailFacts): string | null {
  const parts = [f.tabs > 0 ? `${f.tabs} ${f.tabs === 1 ? "tab" : "tabs"}` : "", f.driven ? "an agent is driving" : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

let facts: BrowserRailFacts = { tabs: 0, driven: false };
const listeners = new Set<() => void>();

export const browserRailFacts = (): BrowserRailFacts => facts;

export function subscribeBrowserRail(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Replaces the snapshot only when a fact changed, so subscribers stay quiet. */
export function publishBrowserRail(next: BrowserRailFacts): void {
  if (next.tabs === facts.tabs && next.driven === facts.driven) return;
  facts = next;
  listeners.forEach((f) => f());
}
