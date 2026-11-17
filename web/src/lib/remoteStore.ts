/*
 * One client store for remote reads: Jira, ClickUp, GitHub PRs and repos.
 *
 * Built by generalising cardTabCache's `swr` (the stale-while-revalidate
 * canon already in this codebase) into something keyed and shared across
 * every caller, instead of one parallel cache per feature.
 *
 * Entry per key (`jira:KEY`, `clickup:ID`, `pr:owner/name#N`, `git:repos`,
 * ...). `read`/`load` hand back the entry at once, from memory; a mount that
 * finds a fresh entry sends nothing. Concurrent callers for the same key
 * share one pending promise. A new value is merged into the old one with
 * `share()`: every sub-object that is still deep-equal to what was there
 * keeps its old reference, so a consumer that skips re-render on an
 * unchanged prop (React.memo, a selector) actually skips it, and a view
 * never blanks back to a skeleton on a refresh that changed nothing.
 *
 * Push (`writePush`, `markStale`) updates an entry without a request: a
 * frame that carries data (PR checks) merges straight in; a frame that only
 * says "this changed" (a Jira/ClickUp card note) marks the key stale, which
 * re-reads at once if something pinned is showing it, or on its next show
 * otherwise. There is no timer anywhere in this file: an entry past its TTL
 * is refetched the next time something actually asks for it, never on a
 * background interval while hidden.
 *
 * The board's own pull-request search and card thread are in here too now
 * (`card-prs:<cardKey>`, 5 min; `clickup-thread:<cardId>`, 2 min — see
 * TasksPanel.tsx), the last two readers `lib/cardTabCache.ts` (now deleted)
 * held apart.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { intervalWhileVisible, minuteBoundaryTick } from "./visibleInterval.ts";

export interface Entry<T> {
  /** The last good value, of any age, or `undefined` if nothing ever answered. */
  value: T | undefined;
  /** Epoch ms of the last successful load, or 0 if there has never been one. */
  at: number;
  /** The last load's failure, cleared by the next successful one. */
  error: string | undefined;
  /** A load is in flight right now. */
  loading: boolean;
}

interface Row {
  snapshot: Entry<unknown>;
  inflight?: Promise<unknown>;
  /** Aborts the shared request; its signal is the loader's argument. */
  ac?: AbortController;
  /** Views waiting on `inflight` right now. */
  waiters?: number;
  loader?: () => Promise<unknown>;
  ttl?: number;
}

const EMPTY: Entry<unknown> = { value: undefined, at: 0, error: undefined, loading: false };

const rows = new Map<string, Row>();
/** Recency order, oldest first, for the LRU; a pinned key is never evicted
 *  no matter where it sits. */
const order: string[] = [];
const pinned = new Map<string, number>();
const subs = new Map<string, Set<() => void>>();

const MAX_KEYS = 100;

function touch(key: string): void {
  const i = order.indexOf(key);
  if (i !== -1) order.splice(i, 1);
  order.push(key);
  evict();
}

function evict(): void {
  for (let i = 0; i < order.length && rows.size > MAX_KEYS; ) {
    const k = order[i]!;
    if (pinned.has(k)) { i++; continue; }
    order.splice(i, 1);
    rows.delete(k);
  }
}

function notify(key: string): void {
  const s = subs.get(key);
  if (s) for (const fn of s) fn();
}

function row(key: string): Row {
  let r = rows.get(key);
  if (!r) { r = { snapshot: EMPTY }; rows.set(key, r); }
  return r;
}

/** Deep structural merge: every sub-object/array of `next` that is
 *  deep-equal to its counterpart in `old` is replaced by the OLD reference,
 *  so unchanged branches never look changed to a `===`/memo comparison. A
 *  key `next` does not have is dropped, matching a normal replace. */
export function share<T>(old: T | undefined, next: T): T {
  if ((old as unknown) === (next as unknown)) return next;
  if (old === undefined || old === null || next === null || typeof old !== "object" || typeof next !== "object") return next;
  if (Array.isArray(old) !== Array.isArray(next)) return next;
  if (Array.isArray(next)) {
    const oldArr = old as unknown[];
    if (oldArr.length !== next.length) return next;
    let changed = false;
    const merged = next.map((v, i) => { const m = share(oldArr[i], v); if (m !== oldArr[i]) changed = true; return m; });
    return (changed ? merged : old) as unknown as T;
  }
  const oldObj = old as Record<string, unknown>;
  const nextObj = next as unknown as Record<string, unknown>;
  const nextKeys = Object.keys(nextObj);
  let changed = nextKeys.length !== Object.keys(oldObj).length;
  const merged: Record<string, unknown> = {};
  for (const k of nextKeys) {
    const m = share(oldObj[k], nextObj[k]);
    merged[k] = m;
    if (m !== oldObj[k]) changed = true;
  }
  return (changed ? merged : old) as T;
}

/** The entry as it stands, without loading anything. */
export function peek<T>(key: string): Entry<T> {
  return (rows.get(key)?.snapshot ?? EMPTY) as Entry<T>;
}

/** Fetch unless fresh. Returns the cached value at once (no request) when
 *  one exists and is younger than `ttl`; otherwise starts (or joins) one
 *  load and resolves when it lands. `ttl` of 0 always forces a load. */
export function load<T>(key: string, loader: (signal: AbortSignal) => Promise<T>, ttl: number): Promise<T> {
  return start(key, loader, ttl).promise;
}

/** `load`, plus a way for ONE waiter to stop waiting. `cancel` drops only this caller's
 *  wait; the shared request is aborted (via the signal the loader got) only when no other
 *  view is waiting on it, so another view reading the same key never sees an AbortError. */
export function loadCancellable<T>(key: string, loader: (signal: AbortSignal) => Promise<T>, ttl: number): { promise: Promise<T>; cancel: () => void } {
  const { promise, cancel } = start(key, loader, ttl);
  return { promise, cancel };
}

function start<T>(key: string, loader: (signal: AbortSignal) => Promise<T>, ttl: number): { promise: Promise<T>; cancel: () => void } {
  const r = row(key);
  touch(key);
  r.loader = loader as unknown as () => Promise<unknown>;
  r.ttl = ttl;
  const snap = r.snapshot as Entry<T>;
  const fresh = snap.value !== undefined && snap.at > 0 && Date.now() - snap.at < ttl;
  if (fresh) return { promise: Promise.resolve(snap.value as T), cancel: () => {} };
  let p = r.inflight as Promise<T> | undefined;
  if (!p) {
    if (!snap.loading) { r.snapshot = { ...snap, loading: true }; notify(key); }
    const ac = new AbortController();
    r.ac = ac;
    r.waiters = 0;
    p = loader(ac.signal).then(
      (v) => {
        const cur = rows.get(key);
        if (cur && cur.inflight === p) {
          cur.inflight = undefined; cur.ac = undefined;
          cur.snapshot = { value: share(cur.snapshot.value as T, v), at: Date.now(), error: undefined, loading: false };
          notify(key);
        }
        return v;
      },
      (e: unknown) => {
        const cur = rows.get(key);
        if (cur && cur.inflight === p) {
          cur.inflight = undefined; cur.ac = undefined;
          cur.snapshot = { ...cur.snapshot, error: e instanceof Error ? e.message : String(e), loading: false };
          notify(key);
        }
        throw e;
      },
    );
    r.inflight = p;
  }
  r.waiters = (r.waiters ?? 0) + 1;
  let left = false;
  const leave = () => { if (left) return; left = true; if (r.inflight === p) r.waiters = Math.max(0, (r.waiters ?? 1) - 1); };
  p.then(leave, leave);
  return { promise: p, cancel: () => { const last = !left && r.inflight === p && (r.waiters ?? 0) <= 1; leave(); if (last) r.ac?.abort(); } };
}

/** Merge data a push frame already carries (e.g. PR checks) straight into
 *  the entry: no request. Fields `patch` does not name are left as they
 *  are — this is a merge of a partial update, never a replace. */
export function writePush<T extends object>(key: string, patch: Partial<T>): void {
  // A push is as much an access as a load; without `touch` a key only ever
  // written through here (never load()ed) never enters the LRU's recency
  // order and is never evicted. Row created first, same as `load`, so the
  // size check inside `touch`'s `evict()` already sees this key counted.
  const r = row(key);
  touch(key);
  const next = { ...(r.snapshot.value as T | undefined ?? (patch as T)), ...patch } as T;
  r.snapshot = { value: share(r.snapshot.value as T | undefined, next), at: Date.now(), error: undefined, loading: false };
  notify(key);
}

/** A push frame said only "this changed", no data: make the entry due. A
 *  key something pinned is showing re-reads at once with its own loader;
 *  otherwise nothing happens until it is shown (loaded) again. */
export function markStale(key: string): void {
  const r = rows.get(key);
  if (!r) return;
  r.snapshot = { ...r.snapshot, at: 0 };
  if (pinned.has(key) && r.loader) void load(key, r.loader, r.ttl ?? 0);
  else notify(key);
}

/** Same as `markStale`, named for a caller invalidating rather than
 *  announcing a change (e.g. after a local write). */
export const invalidate = markStale;

/** Drops one entry entirely — unlike `markStale`, nothing is left to paint.
 *  For a caller giving up a key on purpose (a test reset, a card closed for
 *  good), never for an ordinary push. */
export function forgetKey(key: string): void {
  rows.delete(key);
  const i = order.indexOf(key);
  if (i !== -1) order.splice(i, 1);
  pinned.delete(key);
  notify(key);
}

/** `forgetKey` for every entry whose key starts with `prefix` — one
 *  feature's module (e.g. `jira-links:`) forgetting all of its own cards
 *  without reaching into another feature's keys. */
export function forgetPrefix(prefix: string): void {
  for (const k of [...rows.keys()]) if (k.startsWith(prefix)) forgetKey(k);
}

/** Force a reload right now, same as the Refresh button: `load(key, loader, 0)`. */
export function refresh<T>(key: string): Promise<T> | undefined {
  const r = rows.get(key);
  if (!r?.loader) return undefined;
  return load(key, r.loader as () => Promise<T>, 0);
}

/** A key an open tab is showing is never evicted while pinned — counted, so
 *  two mounted sections pinning the same key (the side pane and the full
 *  Pull requests view, say) don't unpin each other's hold on it. Call from
 *  a section's own mount effect, `unpin` from its cleanup. */
export function pin(key: string): void { pinned.set(key, (pinned.get(key) ?? 0) + 1); touch(key); }
export function unpin(key: string): void {
  const n = (pinned.get(key) ?? 1) - 1;
  if (n <= 0) pinned.delete(key); else pinned.set(key, n);
  evict();
}
function subscribe(key: string, fn: () => void): () => void {
  let s = subs.get(key);
  if (!s) { s = new Set(); subs.set(key, s); }
  s.add(fn);
  return () => { s!.delete(fn); if (s!.size === 0) subs.delete(key); };
}

/**
 * The hook a side-pane section uses: paints the entry at once (fresh or
 * stale, or empty on a key never read), pins the key for as long as this
 * component is mounted so the LRU never evicts what is on screen, and loads
 * on mount / whenever `key` or `ttl` changes — which, for a remount, is the
 * same key, a fresh (already-cached) entry, and zero requests.
 */
export function useRemote<T>(key: string | null, loader: () => Promise<T>, ttl: number): Entry<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  useEffect(() => {
    if (key === null) return;
    pin(key);
    void load(key, () => loaderRef.current(), ttl).catch(() => {});
    return () => { unpin(key); };
  }, [key, ttl]);
  const snap = () => (key === null ? (EMPTY as Entry<T>) : peek<T>(key));
  return useSyncExternalStore(
    (fn) => (key === null ? () => {} : subscribe(key, fn)),
    snap,
    snap, // server render: no subscription runs, so the snapshot is just read once
  );
}

/** One shared minute ticker for "Updated N min ago" labels, instead of one
 *  `setInterval` per label. Returns a counter that changes on every tick;
 *  the value itself carries no meaning, only its change does. */
let tickCount = 0;
let ticking: (() => void) | undefined;
const tickSubs = new Set<() => void>();
export function useMinuteTick(): number {
  return useSyncExternalStore(
    (fn) => {
      tickSubs.add(fn);
      if (!ticking) ticking = minuteBoundaryTick(() => { tickCount++; for (const f of tickSubs) f(); });
      return () => {
        tickSubs.delete(fn);
        if (tickSubs.size === 0 && ticking) { ticking(); ticking = undefined; }
      };
    },
    () => tickCount,
    () => tickCount, // server render: no interval runs, so the snapshot is just read once
  );
}

/** "just now" under a minute, else "Updated N min ago"; "" for an entry that has never loaded. */
export function ageLabel(at: number, now: number = Date.now()): string {
  if (!at) return "";
  const mins = Math.floor((now - at) / 60_000);
  return mins < 1 ? "just now" : `Updated ${mins} min ago`;
}

/** Test/reload seam: every entry, pin and subscriber, gone. */
export function resetRemoteStore(): void {
  rows.clear();
  order.length = 0;
  pinned.clear();
  subs.clear();
  tickCount = 0;
  if (ticking) { ticking(); ticking = undefined; }
  tickSubs.clear();
}

/** The cache key of one Jira card's detail: the card pane reads and writes it, and a "read again" elsewhere must drop the same one. */
export const jiraDetailKey = (key: string): string => `jira:${key}`;

/** A card's `card` push frame said this card changed. Marks its held reads stale: a pane showing it re-reads at once, any other tab re-reads when next shown, and nothing is requested for a card nobody holds. */
export function cardChanged(tracker: "jira" | undefined, id: string, label: string): void {
  if (tracker === "jira") { markStale(jiraDetailKey(id)); markStale(jiraDetailKey(label)); }
  for (const q of new Set([id, label])) markStale(`card-find:${tracker ?? "clickup"}:${q}`);
}
