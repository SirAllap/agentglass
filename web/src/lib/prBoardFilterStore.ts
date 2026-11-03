/*
 * The pull request board's live filter, one per repository, outside React.
 *
 * Why a store and not a `useState` in the panel: the agent door (`pr.filter.set`,
 * lib/uiActions.ts) has to change what the board filters by without the panel
 * being mounted or knowing who asked, and the panel, the deck and the door must
 * never disagree about the filter. Whoever reads uses `usePrFilter`; whoever
 * writes uses `setPrFilter`; the localStorage write is this file's.
 *
 * Kept in this browser per repository, as "agentglass.pr.filters" was. That key
 * held the old flat `{join, rules}`; it is read once, per repository, through
 * `lanesFromFlat` (same PRs kept) the first time a repository has no entry under
 * the new key, and left in place: an older build still reads it, and the new key
 * having an entry IS the "already imported" mark.
 *
 * Repositories are keyed by `owner/name`, which is all the agent door knows. The
 * old maps were keyed by the panel's `repo.key` ("github.com/owner/name"), so a
 * legacy entry is found by that suffix (`legacyEntry`).
 */
import { useCallback, useSyncExternalStore } from "react";
import { emptyLanes, lanesFromFlat, validateLaneFilter, type LaneFilter } from "../../../shared/prFilter.ts";
import { readFilterSet } from "../components/tasks/filters.ts";

export const PR_LANES_KEY = "agentglass.pr.laneFilters";
/** The old flat live filter, per repository. Read to import; never written again. */
export const LEGACY_FILTERS_KEY = "agentglass.pr.filters";

const readJson = (k: string): unknown => {
  try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; }
};
const writeJson = (k: string, v: unknown) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: it lasts until the page does */ }
};

const isMap = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** The value an old per-repository map holds for `owner/name`, whichever host prefix its key carried. */
export function legacyEntry(map: unknown, repo: string): unknown {
  if (!isMap(map)) return undefined;
  if (`github.com/${repo}` in map) return map[`github.com/${repo}`];
  const hit = Object.keys(map).find((k) => k.endsWith(`/${repo}`));
  return hit === undefined ? undefined : map[hit];
}

const cache = new Map<string, LaneFilter>();
const subs = new Map<string, Set<() => void>>();

function load(repo: string): LaneFilter {
  const own = readJson(PR_LANES_KEY);
  if (isMap(own) && repo in own) {
    const f = validateLaneFilter(own[repo]);
    return typeof f === "string" ? emptyLanes() : f;
  }
  const old = legacyEntry(readJson(LEGACY_FILTERS_KEY), repo);
  if (old === undefined) return emptyLanes();
  const flat = readFilterSet(old);
  const f = lanesFromFlat(flat.join, flat.rules);
  writeJson(PR_LANES_KEY, { ...(isMap(own) ? own : {}), [repo]: f });
  return f;
}

export function getPrFilter(repo: string): LaneFilter {
  let f = cache.get(repo);
  if (!f) { f = load(repo); cache.set(repo, f); }
  return f;
}

/** Replace the repository's filter. A filter that does not validate is refused with the reason and nothing changes. */
export function setPrFilter(repo: string, next: LaneFilter): string | null {
  const ok = validateLaneFilter(next);
  if (typeof ok === "string") return ok;
  const own = readJson(PR_LANES_KEY);
  writeJson(PR_LANES_KEY, { ...(isMap(own) ? own : {}), [repo]: ok });
  cache.set(repo, ok);
  subs.get(repo)?.forEach((cb) => cb());
  return null;
}

let listening = false;
/** Another window wrote the key: drop what was cached and tell everyone listening. */
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("storage", (e) => {
    if (e.key !== PR_LANES_KEY && e.key !== null) return;
    cache.clear();
    for (const set of subs.values()) set.forEach((cb) => cb());
  });
}

export function subscribePrFilter(repo: string, cb: () => void): () => void {
  listen();
  let set = subs.get(repo);
  if (!set) subs.set(repo, (set = new Set()));
  set.add(cb);
  return () => { set.delete(cb); };
}

const NONE = emptyLanes();
const noop = () => () => {};

export function usePrFilter(repo: string | null): readonly [LaneFilter, (f: LaneFilter) => void] {
  const sub = useCallback((cb: () => void) => (repo ? subscribePrFilter(repo, cb) : noop()), [repo]);
  const read = () => (repo ? getPrFilter(repo) : NONE);
  const f = useSyncExternalStore(sub, read, read);
  const set = useCallback((next: LaneFilter) => { if (repo) setPrFilter(repo, next); }, [repo]);
  return [f, set];
}

/** Tests only: forget what is cached and who listens. */
export function __resetPrFilterStore(): void {
  cache.clear();
  subs.clear();
}
