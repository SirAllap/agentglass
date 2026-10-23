/*
 * The searches somebody ran with Enter, kept in this browser per repository.
 *
 * Two lists: the last RECENT_MAX distinct searches, most recent first, and the
 * ones pinned so they stay. A search is a string of the box (`#412`,
 * `author:ana`, `ORBIT-1042`); running one again is the same single Enter
 * request the box would have made, which the server answers from its cache
 * while it is fresh. Nothing here asks anybody for anything.
 *
 * Ceiling: the result count is the one the panel saw when the search ran, kept
 * as a hint beside the row. It is not refreshed until that search runs again,
 * and a person board (`author:ana`) has none.
 */

export const RECENT_MAX = 10;
export const SAVED_MAX = 20;
const KEY = "agentglass.pr.searches.v1:";

export interface RecentSearch { q: string; /** Result count when it was last run, if known. */ n?: number; at: number }
export interface SearchMemory { recent: RecentSearch[]; saved: string[] }

/** What storage may hold: anything, until it is checked. */
type Stored = { recent?: unknown; saved?: unknown };

export const EMPTY_MEMORY: SearchMemory = { recent: [], saved: [] };

/** One spelling per search: trimmed, inner whitespace collapsed. */
export function normalizeSearch(q: string): string {
  return q.trim().replace(/\s+/g, " ");
}

const same = (a: string, b: string) => normalizeSearch(a).toLowerCase() === normalizeSearch(b).toLowerCase();

/** A search was run: it goes first, an earlier copy is dropped, the list is capped. An empty box is not a search. */
export function noteSearch(mem: SearchMemory, q: string, now = Date.now(), n?: number): SearchMemory {
  const text = normalizeSearch(q);
  if (!text) return mem;
  const prior = mem.recent.find((r) => same(r.q, text));
  const entry: RecentSearch = { q: text, at: now, ...(n ?? prior?.n) !== undefined ? { n: n ?? prior?.n } : {} };
  return { ...mem, recent: [entry, ...mem.recent.filter((r) => !same(r.q, text))].slice(0, RECENT_MAX) };
}

/** The count a finished search found, put on its row. A search no longer remembered is not brought back for it. */
export function noteCount(mem: SearchMemory, q: string, n: number): SearchMemory {
  if (!mem.recent.some((r) => same(r.q, q))) return mem;
  return { ...mem, recent: mem.recent.map((r) => (same(r.q, q) ? { ...r, n } : r)) };
}

export function removeRecent(mem: SearchMemory, q: string): SearchMemory {
  return { ...mem, recent: mem.recent.filter((r) => !same(r.q, q)) };
}

/** "Clear recent" clears recent only: pinned searches stay. */
export function clearRecent(mem: SearchMemory): SearchMemory {
  return { ...mem, recent: [] };
}

export function isPinned(mem: SearchMemory, q: string): boolean {
  return mem.saved.some((s) => same(s, q));
}

/** Pin or unpin. Pinning needs text; the saved list is capped, the oldest pin giving way. */
export function togglePin(mem: SearchMemory, q: string): SearchMemory {
  const text = normalizeSearch(q);
  if (!text) return mem;
  if (isPinned(mem, text)) return { ...mem, saved: mem.saved.filter((s) => !same(s, text)) };
  return { ...mem, saved: [...mem.saved, text].slice(-SAVED_MAX) };
}

/** Has this text been searched (or pinned)? Then a pin button belongs beside the box. */
export function isRemembered(mem: SearchMemory, q: string): boolean {
  return !!normalizeSearch(q) && (isPinned(mem, q) || mem.recent.some((r) => same(r.q, q)));
}

/** Recent as the panel draws it: a pinned search is shown once, under Saved. */
export function recentRows(mem: SearchMemory): RecentSearch[] {
  return mem.recent.filter((r) => !isPinned(mem, r.q));
}

/** The count to show beside a saved search, if a run of it was seen. */
export function countOf(mem: SearchMemory, q: string): number | undefined {
  return mem.recent.find((r) => same(r.q, q))?.n;
}

export function loadMemory(repoKey: string): SearchMemory {
  try {
    const raw = localStorage.getItem(KEY + repoKey);
    if (!raw) return EMPTY_MEMORY;
    const p = JSON.parse(raw) as Stored | null;
    const recent = Array.isArray(p?.recent)
      ? (p!.recent as unknown[]).flatMap((r): RecentSearch[] => {
        const e = r as Partial<RecentSearch> | null;
        return e && typeof e.q === "string" && normalizeSearch(e.q) && typeof e.at === "number"
          ? [{ q: normalizeSearch(e.q), at: e.at, ...(typeof e.n === "number" ? { n: e.n } : {}) }] : [];
      }).slice(0, RECENT_MAX)
      : [];
    const saved = Array.isArray(p?.saved)
      ? (p!.saved as unknown[]).filter((s): s is string => typeof s === "string" && !!normalizeSearch(s)).map(normalizeSearch).slice(-SAVED_MAX)
      : [];
    return { recent, saved };
  } catch { return EMPTY_MEMORY; }
}

export function saveMemory(repoKey: string, mem: SearchMemory): void {
  try { localStorage.setItem(KEY + repoKey, JSON.stringify(mem)); } catch { /* private mode, or a browser that has said no */ }
}
