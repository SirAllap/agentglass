/*
 * Re-asking the open pull request lists nobody is polling.
 *
 * `listPrs` (prs.ts) only does real work when a client asks `/prs/list`, and
 * even then its own 90s TTL decides whether the answer is refetched or handed
 * back from cache. `noteTalk` — the thing that turns a fresh read into a
 * `{type:"talk"}` broadcast — only runs from inside that same read. So with
 * only a phone connected, off the PRs tab, nothing ever asks again, and a new
 * human comment sits unnoticed until somebody happens to open the list.
 *
 * This module remembers which (root, filter) pairs a REAL client already
 * asked for through `listPrs` with `filter` mine/review and `state` open, and
 * on a tick re-asks each one that was asked inside the last 12 hours, as long
 * as at least one client is connected to hear the answer. It does not force
 * a refresh — `listPrs`'s own TTL still decides whether that costs a real
 * `gh` call — this only makes sure the ASK happens periodically.
 *
 * Ceiling, on purpose: it does not discover a repository nobody has opened.
 * A phone that never visits the PRs tab for a given checkout gets no live
 * talk notes for it, because there is nothing here to re-ask in the first
 * place.
 *
 * Wired from index.ts rather than importing `listPrs` here (or having prs.ts
 * import this module): prs.ts is imported by index.ts already, and this
 * module re-asking THROUGH prs.ts would be the same import cycle the
 * bundler cannot follow (see CLAUDE.md — a dynamic import between modules
 * that already import each other emits an undefined helper). index.ts records
 * each ask right where it already calls `listPrs` for `/prs/list`, and hands
 * the recorded pairs a plain callback that also goes through `listPrs`.
 */

/** How long a remembered ask keeps being worth re-asking. Half a working day:
 *  long enough that a phone that looked in the morning still gets an evening
 *  reply live, short enough that a checkout nobody has opened in a week stops
 *  costing a `gh` call every two minutes for ever. */
export const WATCH_TTL_MS = 12 * 60 * 60_000;

/** How often the tick runs, wired from index.ts. Minutes, not seconds: this is
 *  a backstop for an already-cheap TTL'd read, not the mechanism itself. */
export const WATCH_TICK_MS = 120_000;

type TrackedFilter = "mine" | "review";

interface Ask {
  root: string;
  filter: TrackedFilter;
  at: number;
}

const asks = new Map<string, Ask>();

const keyOf = (root: string, filter: TrackedFilter): string => `${root}\0${filter}`;

/** A real client asked `listPrs(root, filter, state)`. Remembered only when
 *  it is a shape worth re-asking later — `all` has no "should I be told about
 *  this" answer, and anything but `open` is a one-off look at history rather
 *  than the queue this feature watches. */
export function noteAsk(root: string, filter: string, state: string, now = Date.now()): void {
  if (state !== "open") return;
  if (filter !== "mine" && filter !== "review") return;
  asks.set(keyOf(root, filter), { root, filter, at: now });
}

/** Drop pairs nobody has asked for in over `WATCH_TTL_MS`, so a checkout
 *  abandoned last month does not cost a `gh` call every two minutes forever. */
function prune(now: number): void {
  for (const [k, a] of asks) if (now - a.at > WATCH_TTL_MS) asks.delete(k);
}

/**
 * One tick: with nobody connected, do nothing at all — there is no window to
 * hand a live notification to, so re-asking would only spend a `gh` call on
 * an answer that goes straight back into a cache. Otherwise, re-ask every
 * pair still inside its window.
 */
export function tick(now: number, liveClients: number, relist: (root: string, filter: TrackedFilter) => void): void {
  prune(now);
  if (liveClients <= 0) return;
  for (const a of asks.values()) relist(a.root, a.filter);
}

/** Only for tests: the map is process-wide. */
export function __resetWatch(): void { asks.clear(); }

/**
 * The real wiring. `setInterval(...).unref()` so a bare re-ask timer never
 * keeps the process open on its own, and never started under `bun test`:
 * a suite that leaves this running fires real `gh` calls on a schedule
 * nothing in the test asked for, against whatever pairs an earlier test left
 * behind in the process-wide map.
 */
export function startPrWatch(opts: {
  liveClients: () => number;
  relist: (root: string, filter: TrackedFilter) => void;
}): () => void {
  const timer = setInterval(() => tick(Date.now(), opts.liveClients(), opts.relist), WATCH_TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
