/**
 * Whether to keep the Codex quota reading fresh by running a tiny turn.
 *
 * Off by default, and the setting says why in the UI: this spends a small
 * amount of the quota it measures. Anthropic needs no such thing (its endpoint
 * is live) and Antigravity would gain nothing (it writes no quota down), so
 * this is a Codex switch however generally it is worded.
 */
const KEY = "agentglass.usageRefresh";

/** Fifteen minutes. Below this a page reload is a reload, not a reason to
 *  spend a request — and reloading is a habit, not an event. */
const FLOOR_MS = 15 * 60_000;

export function usageRefreshOn(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

const listeners = new Set<() => void>();

export function setUsageRefreshOn(on: boolean): void {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private mode */ }
  for (const fn of listeners) fn();
}

export function subscribeUsageRefresh(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Whether a reading of this age is worth spending a request on. */
export function shouldRefresh(observedAt: number | undefined, now = Date.now()): boolean {
  if (!observedAt) return true;
  return now - observedAt >= FLOOR_MS;
}
