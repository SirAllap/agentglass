/*
 * "6 restarts in 10 min": Docker only reports a running total (`restarts`), so
 * the window is made client-side from the totals seen on earlier reads. Pure:
 * the panel keeps the history and passes it in.
 */
export const RESTART_WINDOW_MS = 10 * 60_000;

export interface RestartSample { at: number; total: number }

/** Add a reading; one sample per change, and samples older than the window (bar the newest one before it) are dropped. */
export function noteRestarts(history: readonly RestartSample[], at: number, total: number, windowMs = RESTART_WINDOW_MS): RestartSample[] {
  const last = history[history.length - 1];
  const next = last && last.total === total ? [...history] : [...history, { at, total }];
  // A total that went down means the container was recreated: start over.
  const fresh = last && total < last.total ? [{ at, total }] : next;
  const keepFrom = fresh.findIndex((s) => s.at >= at - windowMs);
  const from = keepFrom === -1 ? fresh.length - 1 : Math.max(0, keepFrom - 1);
  return fresh.slice(from);
}

/** Restarts since the oldest kept reading, or null when there is nothing to compare with. */
export function restartsInWindow(history: readonly RestartSample[], total: number): number | null {
  const first = history[0];
  if (!first || history.length < 2) return null;
  return Math.max(0, total - first.total);
}
