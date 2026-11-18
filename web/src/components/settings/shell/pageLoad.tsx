import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";
import { shouldFetch, type SlotRole } from "../../../lib/settingsReady.ts";

/**
 * How a Settings page says what it is still reading, so the shell can keep it out of sight until it
 * can paint once (see lib/settingsReady.ts), and the shared cache those reads go through, so a page
 * opened a second time, or hovered in the nav first, paints with its last values at once and updates
 * them in place.
 */

/** Where a page block's reads report: the shell's map of what each pane is still waiting for. */
export interface PageLoadSink { report: (owner: string, key: string, on: boolean) => void }
export const PageLoad = createContext<PageLoadSink | null>(null);
const SlotOwner = createContext<string | null>(null);

/**
 * Declare that this page is still reading `key`. Reported in a layout effect, so the shell knows
 * before the first paint; outside the shell (a test, a preview) it does nothing.
 */
export function usePageLoading(key: string, loading: boolean) {
  const sink = useContext(PageLoad);
  const owner = useContext(SlotOwner);
  // Per caller: two rows reading the same key each hold the page until their own read answers.
  const id = `${key}#${useId()}`;
  useLayoutEffect(() => {
    if (!sink || !owner || !loading) return;
    sink.report(owner, id, true);
    return () => sink.report(owner, id, false);
  }, [sink, owner, id, loading]);
}

type Entry = { value?: unknown; failed?: boolean; at: number };
const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
const fetchers = new Map<string, () => Promise<unknown>>();
const pageKeys = new Map<string, Set<string>>();

const notify = (key: string) => listeners.get(key)?.forEach((f) => f());
function put(key: string, e: Entry) { entries.set(key, e); notify(key); }

/** Read `key` now unless a fresh value is cached or a read is already out (`force` skips the freshness check). */
function run(key: string, force = false): Promise<void> {
  const out = inFlight.get(key);
  if (out) return out;
  const fetcher = fetchers.get(key);
  if (!fetcher || (!force && !shouldFetch(entries.get(key), false, Date.now()))) return Promise.resolve();
  const p = fetcher().then(
    (value) => put(key, { value, at: Date.now() }),
    // A failed revalidation keeps the last good value on screen; only a first read that failed says so.
    () => { const old = entries.get(key); put(key, old && "value" in old ? { ...old, at: Date.now() } : { failed: true, at: Date.now() }); },
  ).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * Register a read a page makes, under the page's nav id, at module scope. The nav warms it on hover
 * or focus, and `useSettingsData` reads it through the cache.
 */
export function registerRead<T>(page: string, key: string, fetcher: () => Promise<T>) {
  fetchers.set(key, fetcher);
  (pageKeys.get(page) ?? pageKeys.set(page, new Set()).get(page)!).add(key);
}

export function hasReads(page: string): boolean { return !!pageKeys.get(page)?.size; }

/** Warm every read `page` registered. */
export function prefetchPage(page: string) { pageKeys.get(page)?.forEach((k) => { void run(k); }); }

/**
 * A page's read through the shared cache (stale-while-revalidate): the last value is returned at once
 * and a fresh read goes out behind it. Declares the read to the shell only while there is no value
 * and no failure yet, so a cached page is ready on its first render.
 */
export function useSettingsData<T>(key: string, enabled = true): { data: T | undefined; failed: boolean; reload: () => Promise<void>; set: (v: T) => void } {
  const subscribe = useCallback((f: () => void) => {
    const s = listeners.get(key) ?? listeners.set(key, new Set()).get(key)!;
    s.add(f);
    return () => { s.delete(f); };
  }, [key]);
  const entry = useSyncExternalStore(subscribe, () => entries.get(key), () => entries.get(key));
  useEffect(() => { if (enabled) void run(key); }, [key, enabled]);
  const data = entry?.value as T | undefined;
  const failed = !!entry?.failed;
  usePageLoading(key, enabled && data === undefined && !failed);
  const reload = useCallback(() => run(key, true), [key]);
  const set = useCallback((v: T) => put(key, { value: v, at: Date.now() }), [key]);
  return { data, failed, reload, set };
}

/** Test seam: forget every cached value. */
export function clearSettingsCache() { entries.clear(); inFlight.clear(); }

/**
 * One page block in the column. A block on screen draws as if the wrapper were not there; the page
 * asked for sits out of sight at full column width, so it lays out and reads, and nothing on screen
 * moves until the shell swaps it in.
 */
/* Zero tall and clipped as well as hidden: a hidden page taller than the one on screen would still
   lengthen the scroller and move its thumb. Its own layout runs at full column width inside. */
const PENDING = { position: "absolute", top: 0, left: 0, right: 0, height: 0, overflow: "hidden", visibility: "hidden", pointerEvents: "none" } as const;
const SHOWN = { display: "contents" } as const;

export function PageSlot({ role, owner, children }: { role: SlotRole; owner: string; children: ReactNode }) {
  if (role === "none") return null;
  const pending = role === "pending";
  // React 18 has no `inert` prop; an empty string sets the attribute.
  return (
    <SlotOwner.Provider value={owner}>
      <div data-page-slot={role} aria-hidden={pending || undefined} {...(pending ? { inert: "" } : {})}
        style={pending ? PENDING : SHOWN}>
        {children}
      </div>
    </SlotOwner.Provider>
  );
}

/**
 * The quiet placeholder for a page that is taking longer than the hold: section heading bars and row
 * blocks in the page's own surfaces. `height` is the page's height the last time it was on screen, so
 * the swap does not move what is under it. No spinner; the shimmer is off under reduced motion.
 */
export function PageSkeleton({ height }: { height?: number }) {
  return (
    <div data-page-skeleton aria-busy="true" aria-label="Loading this page" className="agx-page-skel px-6 py-6"
      style={{ minHeight: height }}>
      <div className="mx-auto w-full max-w-[1132px] flex gap-8">
        <div className="min-w-0 w-[720px] max-w-full flex flex-col gap-6">
          {[3, 2, 4].map((rows, i) => (
            <div key={i} className="flex flex-col gap-2">
              <span className="agx-skel-bar" style={{ width: 140, height: 12 }} />
              <div className="agx-skel-card">
                {Array.from({ length: rows }, (_, j) => <span key={j} className="agx-skel-row" />)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
