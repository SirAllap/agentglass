import { useState, useCallback } from "react";
import type { StatsSummary } from "../../../shared/types.ts";
import { api } from "./api.ts";
import { usePoll } from "./usePoll.ts";

/**
 * How often to re-poll for a given window.
 *
 * /stats is a set of aggregates over every event in range, so its cost scales
 * with the window — an all-time view over months of backfilled history is a
 * full scan, an order of magnitude dearer than an hour's worth. Polling all of
 * them at the same live-feeling rate meant the widest views spent most of their
 * time re-deriving numbers that had barely moved. A month of history doesn't
 * change meaningfully between two four-second ticks; a fifteen-minute view
 * does, and keeps its rate. The live event feed arrives over the WebSocket
 * regardless, so the panel never looks frozen.
 */
function pollFor(windowMs: number): number {
  if (windowMs <= 3_600_000) return 4_000;         // ≤ 1h — should feel live
  if (windowMs <= 24 * 3_600_000) return 10_000;   // ≤ 24h
  if (windowMs <= 7 * 86_400_000) return 20_000;   // ≤ 7d
  return 30_000;                                    // 30d / all time
}

/** Poll /stats on an interval, optionally scoped to a provider. Pass
 *  `intervalMs` only to override the window-derived rate. */
export function useStats(windowMs: number, intervalMs?: number, provider = "") {
  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    return api
      .stats(windowMs, provider || undefined)
      .then((s) => {
        setStats(s);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [windowMs, provider]);

  const every = intervalMs ?? pollFor(windowMs);
  usePoll(true, load, every, true, `${windowMs}:${provider}`);

  return { stats, error };
}
