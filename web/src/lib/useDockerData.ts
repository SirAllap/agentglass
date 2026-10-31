/*
 * The Docker view's data, kept current by Docker's own events instead of a
 * timer. The server watches `docker events`, so a change arrives as a message;
 * this hook turns each message into one fetch and nothing else asks.
 *
 * Fetches coalesce: events come in bursts (a compose `up` is a dozen), and a
 * burst must cost one request in flight and at most one behind it, not twelve.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { DockerCapability, DockerLiveScope, DockerOverview, DockerStat } from "../../../shared/types.ts";
import { api } from "./api.ts";
import { noteOverview } from "./dockerCount.ts";
import { mergeStats } from "./dockerView.ts";
import { useDockerLive } from "./useDockerLive.ts";

export function useDockerData(active: boolean) {
  const [ov, setOv] = useState<DockerOverview | null>(null);
  const [good, setGood] = useState<DockerOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [liveDown, setLiveDown] = useState(false);
  const [stats, setStats] = useState<Record<string, DockerStat>>({});
  const [cap, setCap] = useState<DockerCapability | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /* How many times each list has changed since the panel opened. A measurement
     that Docker does not push (disk, volume sizes) reads this to know when its
     figures went stale, so it is asked again on the event and never on a timer. */
  const [changed, setChanged] = useState<Record<DockerLiveScope, number>>({ containers: 0, images: 0, volumes: 0, networks: 0 });
  const known = useRef<ReadonlySet<string>>(new Set());
  const inflight = useRef<Promise<void> | null>(null);
  const trailing = useRef<boolean | null>(null);

  const fetchOverview = useCallback(async (fresh: boolean) => {
    try {
      const o = await api.dockerOverview(fresh);
      setOv(o); setFailed(false); noteOverview(o);
      if (o.available) {
        setGood(o); setLiveDown(false);
        known.current = new Set(o.containers.map((c) => c.id));
      }
    } catch {
      setFailed(true); noteOverview(null);
    }
  }, []);

  const loadOverview = useCallback((fresh = false): Promise<void> => {
    if (inflight.current) { trailing.current = trailing.current || fresh; return inflight.current; }
    const run = (async () => {
      let next: boolean | null = fresh;
      while (next !== null) {
        trailing.current = null;
        await fetchOverview(next);
        next = trailing.current;
      }
    })().finally(() => { inflight.current = null; });
    inflight.current = run;
    return run;
  }, [fetchOverview]);

  const loadStats = useCallback(async () => {
    try { setStats(mergeStats((await api.dockerStats()).stats, known.current)); }
    catch { /* stats are best-effort */ }
  }, []);

  const loadAll = useCallback(async (fresh = false) => { await loadOverview(fresh); await loadStats(); }, [loadOverview, loadStats]);

  const loadCapability = useCallback(() => {
    api.dockerCapability().then(setCap).catch(() => { /* the overview's error still shows */ });
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadAll(); loadCapability();
  }, [active, loadAll, loadCapability]);

  useDockerLive(active, {
    onChanged: (scope) => { setChanged((c) => ({ ...c, [scope]: c[scope] + 1 })); void loadOverview(); },
    onStats: (s) => setStats(mergeStats(s, known.current)),
    onDown: () => setLiveDown(true),
    onUp: () => { void loadAll(true); },
    onReconnect: () => { void loadAll(true); },
  });

  // The freshness label reads the clock when it renders. No timer: it renders when
  // the feed speaks, and again here when the window comes back after a quiet spell.
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!active) return;
    const on = () => { if (!document.hidden) repaint(); };
    window.addEventListener("focus", on);
    document.addEventListener("visibilitychange", on);
    return () => { window.removeEventListener("focus", on); document.removeEventListener("visibilitychange", on); };
  }, [active]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await loadAll(true); } finally { setRefreshing(false); }
  }, [loadAll]);

  return { ov, good, failed, liveDown, stats, cap, refreshing, changed, refresh, reload: loadOverview, loadCapability };
}
