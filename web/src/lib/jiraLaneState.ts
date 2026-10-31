/*
 * What a person did to the lanes of a Jira view: which are folded, and how each is sorted. The sort is remembered per view
 * (localStorage), the fold for this visit only, as the board always did. One small store so the lane head, the lane menu and
 * the data hook read and write the same thing.
 *
 * A lane is named by the key laneModel gives it (`status:in progress`, `backlog`, `area:ORB-9`, and `parent/child` for a
 * second level), so a lane keeps its state when the cards in it change.
 */
import { useSyncExternalStore } from "react";
import type { LaneSort } from "../components/jira/list/laneModel.ts";

const STORE_KEY = "agentglass.jira.laneSort";
const SORTS = new Set<string>(["rank", "key", "priority", "due"]);

const at = (view: string, lane: string): string => `${view}|${lane}`;
let sorts: Record<string, LaneSort> | null = null;
const folds = new Map<string, boolean>();
const listeners = new Set<() => void>();
let version = 0;

function read(): Record<string, LaneSort> {
  if (sorts) return sorts;
  sorts = {};
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && SORTS.has(v)) sorts[k] = v as LaneSort;
  } catch { /* a private window keeps it for this visit only */ }
  return sorts;
}
const tell = () => { version++; for (const l of listeners) l(); };

export const laneSortOf = (view: string, lane: string): LaneSort => read()[at(view, lane)] ?? "rank";

export function setLaneSort(view: string, lane: string, by: LaneSort): void {
  const m = read();
  if (by === "rank") delete m[at(view, lane)]; else m[at(view, lane)] = by;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(m)); } catch { /* kept for this visit */ }
  tell();
}

/** Whether a lane is folded: what the person chose, else the lane's own default (the Backlog starts folded). */
export const laneFolded = (view: string, lane: string, dflt: boolean): boolean => folds.get(at(view, lane)) ?? dflt;

export function setLaneFolded(view: string, lanes: readonly string[], folded: boolean): void {
  for (const l of lanes) folds.set(at(view, l), folded);
  tell();
}

/** Re-renders the reader when a sort or a fold changed. */
export function useLaneState(): number {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => version, () => 0);
}

/** For tests: back to a fresh visit. */
export function __resetLaneState(): void { sorts = null; folds.clear(); tell(); }
