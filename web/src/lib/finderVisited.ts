/*
 * The folders the Finder has been in, for Ctrl+Shift+K ("Jump to a folder…").
 *
 * Strata keeps the same list (services/navigation_history.rs): each visit adds one
 * to a folder's rank, and a search weighs the rank by how recent the last visit
 * was (4x within the hour, 2x within a day, 0.5x within a week, 0.25x after), keeps
 * the last 1000 and shows 100. The ceiling of this version: the match is "every
 * word is somewhere in the path", not Strata's fuzzy scorer, so "dwn" does not find
 * Downloads; the ranking and the limits are the same.
 */
export interface Visit { path: string; rank: number; at: number }

const MAX_ENTRIES = 1000;
const MAX_RESULTS = 100;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** One more visit: the folder moves up in rank, and the list stays within its limit by dropping the least wanted. */
export function recordVisit(list: readonly Visit[], path: string, now: number): Visit[] {
  if (!path || path.startsWith("recent:")) return [...list];
  const old = list.find((v) => v.path === path);
  const rest = list.filter((v) => v.path !== path);
  const next = [{ path, rank: (old?.rank ?? 0) + 1, at: now }, ...rest];
  return next.length > MAX_ENTRIES ? next.sort((a, b) => weight(b, now) - weight(a, now)).slice(0, MAX_ENTRIES) : next;
}

const weight = (v: Visit, now: number): number => {
  const age = now - v.at;
  return v.rank * (age < HOUR ? 4 : age < DAY ? 2 : age < WEEK ? 0.5 : 0.25);
};

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

/** The folders that match, best first; `except` is the folder already open, which is no use to jump to. */
export function searchVisited(list: readonly Visit[], query: string, now: number, except?: string): Visit[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scored: [number, Visit][] = [];
  for (const v of list) {
    if (v.path === except) continue;
    const path = v.path.toLowerCase();
    if (!words.every((w) => path.includes(w))) continue;
    const name = nameOf(path);
    const bonus = words.length && name === words.join(" ") ? 1e6 : words.length && words.every((w) => name.includes(w)) ? 1e3 : 0;
    scored.push([weight(v, now) + bonus, v]);
  }
  return scored.sort((a, b) => b[0] - a[0] || b[1].at - a[1].at || (a[1].path < b[1].path ? -1 : 1)).slice(0, MAX_RESULTS).map(([, v]) => v);
}

/** What the empty list says (search.rs): nothing visited yet, or the query matched none of it. */
export const visitedEmpty = (query: string, found: number): string => (found > 0 ? "" : !query.trim() ? "No folder history yet" : "No matching folders");

const KEY = "agx.finder.visited";
export function loadVisited(): Visit[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((v): v is Visit => !!v && typeof v.path === "string" && typeof v.rank === "number" && typeof v.at === "number").slice(0, MAX_ENTRIES) : [];
  } catch { return []; }
}
export function saveVisited(list: readonly Visit[]): void { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* no storage: the list lives for this window only */ } }
