/*
 * The count column of the Jira sidebar's starred rows: one GET /jira/view-count per visible row, asked when the row first
 * appears, two at a time. A board the server has not read yet is asked again on a short backoff (a few tries, then it waits for the
 * next appearance); a view whose search changed is asked again once (`forgetViewCount`). No timer polls a count.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type { ViewCount } from "./jiraTree.ts";

export const NOT_READ = "Not read yet";
/** Waits before asking again for a board not read yet: 2 s, 4 s, 8 s, 16 s, then no more. */
export const COUNT_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000] as const;

const forgets = new Set<(id: string) => void>();
/** A view's search changed (edit, save): every mounted count column asks its count once more. */
export function forgetViewCount(id: string): void { for (const f of forgets) f(id); }

/** The wait before the next try after `tries` "not read yet" answers, or null when the backoff is spent. */
export function countRetryMs(tries: number): number | null { return COUNT_BACKOFF_MS[tries] ?? null; }

/** At most this many count requests in flight from one sidebar; the server holds the same ceiling. */
export const COUNT_CONCURRENCY = 2;

/**
 * A queue that runs at most `limit` asks at once. An id no longer wanted when its turn comes is handed to `dropped` and never
 * asked, so a row that left the list costs nothing.
 */
export function countPool(limit: number, ask: (id: string) => Promise<void>, wanted: (id: string) => boolean, dropped: (id: string) => void) {
  let queue: string[] = [];
  let running = 0;
  let live = true;
  const pump = (): void => {
    while (live && running < limit && queue.length) {
      const id = queue.shift()!;
      if (!wanted(id)) { dropped(id); continue; }
      running++;
      void ask(id).catch(() => {}).finally(() => { if (!live) return; running--; pump(); });
    }
  };
  return {
    add(ids: readonly string[]): void { queue.push(...ids); pump(); },
    stop(): void { live = false; queue = []; running = 0; },
    get running(): number { return running; },
  };
}

/* The last count the site gave for each view, kept for the window's life: a row that is read again, or whose read failed, shows it dimmed instead of a bare dash. */
const last = new Map<string, { n: number; more: boolean }>();
const staleOr = (id: string): ViewCount => { const l = last.get(id); return l ? { ...l, stale: true } : "err"; };

export function useJiraViewCounts(ids: readonly string[], enabled: boolean): Record<string, ViewCount> {
  const [counts, setCounts] = useState<Record<string, ViewCount>>(() => Object.fromEntries(ids.flatMap((id) => { const l = last.get(id); return l ? [[id, { ...l, stale: true }]] : []; })));
  const [tick, setTick] = useState(0);
  const asked = useRef(new Set<string>());
  const tries = useRef(new Map<string, number>());
  const wanted = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const live = useRef<{ ctl: AbortController; pool: ReturnType<typeof countPool> } | null>(null);
  const key = ids.join("\n");
  wanted.current = new Set(ids);

  useEffect(() => {
    const f = (id: string) => { asked.current.delete(id); tries.current.delete(id); setTick((n) => n + 1); };
    forgets.add(f);
    return () => { forgets.delete(f); };
  }, []);

  /* The requests live as long as the sidebar is on: a changed id list neither cancels them nor asks the pending ones again. */
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    const ask = (id: string): Promise<void> => api.jiraViewCount(id, ctl.signal).then((r) => {
      if (ctl.signal.aborted) return;
      const got: ViewCount | null = r.ok && typeof r.count === "number" ? { n: r.count, more: !!r.more } : null;
      if (got) last.set(id, got);
      setCounts((c) => ({ ...c, [id]: got ?? staleOr(id) }));
      if (r.ok || r.error !== NOT_READ) { tries.current.delete(id); return; }
      const n = tries.current.get(id) ?? 0;
      const wait = countRetryMs(n);
      if (wait === null) return;
      tries.current.set(id, n + 1);
      timers.current.set(id, setTimeout(() => { timers.current.delete(id); asked.current.delete(id); setTick((t) => t + 1); }, wait));
    }, () => { if (!ctl.signal.aborted) setCounts((c) => ({ ...c, [id]: staleOr(id) })); });
    const pool = countPool(COUNT_CONCURRENCY, ask, (id) => wanted.current.has(id), (id) => { asked.current.delete(id); });
    live.current = { ctl, pool };
    return () => {
      ctl.abort();
      pool.stop();
      live.current = null;
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
      asked.current.clear();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !live.current) return;
    const fresh = ids.filter((id) => !asked.current.has(id));
    for (const id of fresh) asked.current.add(id);
    live.current.pool.add(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, tick]);
  return counts;
}
