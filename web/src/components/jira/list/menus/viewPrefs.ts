/*
 * What the list menus remember about one view: the cards pinned to the top of their lane and the ones hidden from the
 * list. Housekeeping of this machine: nothing is written to Jira, and a card hidden here is still in the footer's count.
 * (How a lane is sorted and which lanes are folded is the lane model's: lib/jiraLaneState.ts.)
 *
 * Two stores, one file: per-view prefs (keyed by the view id) and the names a view was given in the sidebar. Both
 * are read through a hook and kept in localStorage; a private window just forgets on close.
 *
 * Ceiling: ids are the site's card ids and are never pruned, so a long-gone card stays in `hidden` (a few bytes
 * each) until the lane menu's "Show the N hidden" brings it back or the card returns.
 */
import { useSyncExternalStore } from "react";
import type { ProviderTask } from "../../../../../../shared/providers.ts";
import type { JiraLane } from "../model.ts";

export interface ViewPrefs {
  /** Most recently pinned first. */
  pinned: string[];
  hidden: string[];
}

export const NO_PREFS: ViewPrefs = { pinned: [], hidden: [] };

// ---- pure rules ----

export const togglePin = (p: ViewPrefs, id: string): ViewPrefs =>
  ({ ...p, pinned: p.pinned.includes(id) ? p.pinned.filter((x) => x !== id) : [id, ...p.pinned] });

export const hideCard = (p: ViewPrefs, id: string): ViewPrefs =>
  p.hidden.includes(id) ? p : { ...p, hidden: [...p.hidden, id], pinned: p.pinned.filter((x) => x !== id) };

export const showCards = (p: ViewPrefs, ids: readonly string[]): ViewPrefs =>
  ({ ...p, hidden: p.hidden.filter((x) => !ids.includes(x)) });

/** The cards a view shows once hidden ones are gone. */
export const visibleCards = (cards: readonly ProviderTask[], p: ViewPrefs): ProviderTask[] =>
  p.hidden.length ? cards.filter((t) => !p.hidden.includes(t.id)) : [...cards];

/** A lane the way this view arranges it: hidden cards out, pinned ones first (latest pin on top), in the sub-lanes too. A lane the prefs do not touch comes back as it was. */
export function arrangeLane(lane: JiraLane, p: ViewPrefs): JiraLane {
  const shown = visibleCards(lane.cards, p);
  const at = (t: ProviderTask) => p.pinned.indexOf(t.id);
  const cards = p.pinned.some((id) => shown.some((t) => t.id === id))
    ? [...shown.filter((t) => at(t) >= 0).sort((a, b) => at(a) - at(b)), ...shown.filter((t) => at(t) < 0)]
    : shown;
  const sub = lane.sub?.map((l) => arrangeLane(l, p));
  const same = cards.length === lane.cards.length && cards.every((t, i) => t === lane.cards[i]) && (!sub || sub.every((l, i) => l === lane.sub![i]));
  return same ? lane : { ...lane, cards, ...(sub ? { sub } : {}) };
}

export const arrangeLanes = (lanes: readonly JiraLane[], p: ViewPrefs): JiraLane[] => lanes.map((l) => arrangeLane(l, p));

/** The model the lanes draw from: hidden cards gone, each lane arranged. The footer and the chips keep the real counts. */
export function withPrefs<M extends { cards: ProviderTask[]; lanes: JiraLane[] }>(model: M, p: ViewPrefs): M {
  return p === NO_PREFS ? model : { ...model, cards: visibleCards(model.cards, p), lanes: arrangeLanes(model.lanes, p) };
}

// ---- the stores ----

const PREFS_KEY = "agentglass.jira.listPrefs";
const NAMES_KEY = "agentglass.jira.viewNames";
const RAIL_KEY = "agentglass.jira.railHidden";

function load<T>(key: string, fallback: T): T {
  try { return { ...fallback, ...(JSON.parse(localStorage.getItem(key) || "{}") as object) } as T; } catch { return fallback; }
}
function save(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window: forgotten on close */ }
}

let prefs: Record<string, ViewPrefs> | null = null;
let names: Record<string, string> | null = null;
let railHidden: string[] | null = null;
const listeners = new Set<() => void>();
const tell = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

const allPrefs = (): Record<string, ViewPrefs> => (prefs ??= load<Record<string, ViewPrefs>>(PREFS_KEY, {}));
const allNames = (): Record<string, string> => (names ??= load<Record<string, string>>(NAMES_KEY, {}));

export const getPrefs = (viewId: string | null): ViewPrefs => (viewId && allPrefs()[viewId]) || NO_PREFS;

/** Change a view's prefs. A change that leaves them as they were tells nobody. */
export function updatePrefs(viewId: string, change: (p: ViewPrefs) => ViewPrefs): void {
  const before = getPrefs(viewId);
  const after = change(before);
  if (after === before) return;
  prefs = { ...allPrefs(), [viewId]: after };
  save(PREFS_KEY, prefs);
  tell();
}

export const usePrefs = (viewId: string | null): ViewPrefs => useSyncExternalStore(subscribe, () => getPrefs(viewId), () => NO_PREFS);

/** A name given in the sidebar; blank forgets it. */
export function renameView(viewId: string, name: string): void {
  const { [viewId]: _gone, ...rest } = allNames();
  const next = name.trim();
  names = next ? { ...rest, [viewId]: next } : rest;
  save(NAMES_KEY, names);
  tell();
}

export const useViewNames = (): Record<string, string> => useSyncExternalStore(subscribe, allNames, allNames);

/*
 * The built-in rows a person took off the sidebar ("Hide from the sidebar"), by view id. Housekeeping of this machine,
 * like a name: Jira is never asked. A hidden row comes back from the + menu (the Add dialog lists it).
 */
const hiddenRail = (): string[] => {
  if (railHidden) return railHidden;
  try { const v = JSON.parse(localStorage.getItem(RAIL_KEY) || "[]"); railHidden = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { railHidden = []; }
  return railHidden;
};
export function setRailHidden(viewId: string, hide: boolean): void {
  const now = hiddenRail();
  if (now.includes(viewId) === hide) return;
  railHidden = hide ? [...now, viewId] : now.filter((x) => x !== viewId);
  save(RAIL_KEY, railHidden);
  tell();
}
export const useRailHidden = (): readonly string[] => useSyncExternalStore(subscribe, hiddenRail, hiddenRail);

/** Test seam: forget what was read and held in memory. */
export function __resetViewPrefs(): void { prefs = null; names = null; railHidden = null; listeners.clear(); }
