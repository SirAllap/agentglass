/*
 * Stale-while-revalidate for what a card's tabs read on their own: its pull
 * requests (a GitHub search) and its thread (a ClickUp read).
 *
 * Measured against a wrapped fetch: coming back to the window after a minute
 * makes the board re-read itself, its tasks arrive as new objects, and the
 * card's effects keyed on those objects ran again — the pull request list was
 * emptied, "No pull request names this card yet." showed, and the same search
 * went out a second time. Five trips out of the window and back on one open
 * card were five searches and five clears; closing a card and opening it again
 * was another. Both are budgeted calls (ClickUp about a hundred a minute per
 * token, GitHub five thousand an hour), and neither answer changes that fast.
 *
 * So an answer is kept per card and painted at once, whatever its age. It is
 * never cleared while a newer one is being fetched. It is asked for again only
 * when it is older than its TTL, when someone presses that card's Refresh, or
 * after a write made here (`stale`, which keeps the old answer on screen and
 * only says it is due). Identical requests in flight share one promise.
 *
 * The ceiling: two minutes for a thread and five for pull requests is how late
 * a comment posted elsewhere, or a pull request opened for the card, can show
 * when the card is simply left open — Refresh on the card is the way round it.
 * Answers are not persisted; a restart starts cold.
 */

export type Swr<T> = {
  /** The last good answer, of any age, or `undefined` if there never was one. */
  peek(key: string): T | undefined;
  /** Whether an answer exists and is inside its TTL. */
  fresh(key: string): boolean;
  /** Fetch unless fresh (or `force`). Concurrent calls for a key share one fetch. */
  load(key: string, fetcher: () => Promise<T>, opts?: { force?: boolean }): Promise<T>;
  /** Keep the answer for painting but make it due at the next `load`. */
  stale(key: string): void;
  clear(): void;
};

export function swr<T>(ttlMs: number, keep: (v: T) => boolean, now: () => number = Date.now): Swr<T> {
  const seen = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();
  const fresh = (key: string) => {
    const e = seen.get(key);
    return !!e && now() - e.at < ttlMs;
  };
  return {
    peek: (key) => seen.get(key)?.value,
    fresh,
    load(key, fetcher, opts) {
      const hit = seen.get(key);
      if (hit && !opts?.force && fresh(key)) return Promise.resolve(hit.value);
      const going = inflight.get(key);
      if (going) return going;
      const p = fetcher()
        .then((value) => { if (keep(value)) seen.set(key, { at: now(), value }); return value; })
        .finally(() => { inflight.delete(key); });
      inflight.set(key, p);
      return p;
    },
    stale(key) {
      const e = seen.get(key);
      if (e) seen.set(key, { at: -Infinity, value: e.value });
    },
    clear() { seen.clear(); inflight.clear(); },
  };
}

/** Pull requests: a GitHub search per card, five minutes. */
export const PRS_TTL_MS = 5 * 60_000;
/** The thread: a ClickUp read per card, two minutes. */
export const THREAD_TTL_MS = 2 * 60_000;

/**
 * What a card's effect does when it opens: hand over the cached answer at
 * once (`cached` true), then fetch only if it is due and hand over that.
 * `onValue` is not called with nothing, so a caller that had an answer never
 * goes back to empty while the next one is on its way.
 */
export function paintThenRevalidate<T>(
  cache: Swr<T>, key: string, fetcher: () => Promise<T>, onValue: (v: T, cached: boolean) => void,
  opts?: { force?: boolean },
): Promise<void> {
  const hit = cache.peek(key);
  if (hit !== undefined) onValue(hit, true);
  if (hit !== undefined && !opts?.force && cache.fresh(key)) return Promise.resolve();
  return cache.load(key, fetcher, opts).then((v) => {
    // A failed revalidation is not stored; the answer on screen stays.
    if (hit !== undefined && cache.peek(key) === hit) return;
    onValue(v, false);
  });
}
