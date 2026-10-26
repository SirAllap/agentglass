import type { ViewId } from "../components/workspace/views.ts";

/**
 * The count a rail icon wears, and whether the person wants it.
 *
 * Only two views carry a number today, each the count of things that want
 * the person (not the size of a backlog): agents stopped on them, reminders
 * that fired. Pull requests carry none, and no row is drawn for a view that has no number to hide. The choice is
 * stored as the list of views whose count is hidden, so a view added later
 * starts counted.
 */
export const COUNTED_VIEWS: Partial<Record<ViewId, string>> = {
  agents: "Agents stopped on you.",
  tasks: "Reminders that fired.",
};

const KEY = "agentglass.railBadgesOff";
const listeners = new Set<() => void>();
let cache: ReadonlySet<ViewId> | null = null;

function load(): ReadonlySet<ViewId> {
  if (cache) return cache;
  let out = new Set<ViewId>();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (Array.isArray(raw)) out = new Set(raw.filter((id): id is ViewId => typeof id === "string" && id in COUNTED_VIEWS));
  } catch { /* corrupt or absent: every count shows */ }
  cache = out;
  return out;
}

export const railBadgeOn = (id: ViewId): boolean => !load().has(id);
/** A snapshot for useSyncExternalStore: changes whenever a count is turned on or off. */
export const railBadgesKey = (): string => [...load()].sort().join(",");
export const railBadgesCustomised = (): boolean => load().size > 0;

export function setRailBadge(id: ViewId, on: boolean): void {
  if (!(id in COUNTED_VIEWS)) return;
  const next = new Set(load());
  if (on) next.delete(id); else next.add(id);
  cache = next;
  try { if (next.size) localStorage.setItem(KEY, JSON.stringify([...next])); else localStorage.removeItem(KEY); } catch { /* the change holds until reload */ }
  listeners.forEach((f) => f());
}

export function resetRailBadges(): void {
  cache = new Set();
  try { localStorage.removeItem(KEY); } catch { /* nothing to remove */ }
  listeners.forEach((f) => f());
}

export function subscribeRailBadges(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The pips the rail draws, minus the counts the person turned off. */
export function visiblePips<T extends { count?: number }>(pips: Partial<Record<ViewId, T>>): Partial<Record<ViewId, T | Record<string, never>>> {
  const off = load();
  const out: Partial<Record<ViewId, T | Record<string, never>>> = {};
  for (const id of Object.keys(pips) as ViewId[]) out[id] = off.has(id) ? {} : pips[id];
  return out;
}
