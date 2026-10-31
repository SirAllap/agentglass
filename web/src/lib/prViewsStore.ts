/*
 * The board's saved views, per repository, outside React: the list edits as
 * pure functions, and the one copy of the server's list this window holds.
 *
 * The server owns the list (GET/POST /prs/views, validated by validateViews);
 * this keeps the last answer per repository so a hook, the agent door and a
 * second panel all see one list, and writes the whole list back on every edit.
 * An edit is optimistic and rolls back when the server refuses it.
 *
 * One-time import. A repository the server has never saved a list for takes the
 * old localStorage presets ("agentglass.pr.filterPresets") through `lanesFromFlat`,
 * which keeps the same pull requests, with the same names and order and the
 * preset's own id (so the remembered active id still points at it). The old key
 * is left in place and never written again; "imported" is remembered under
 * IMPORTED_KEY so a repository whose server list was later deleted empty is not
 * refilled from it. The ceiling: presets saved on another machine are not
 * reachable from here, only this browser's.
 *
 * The active view id is per machine, in localStorage, not on the server: which
 * view one screen is on is not something the phone should inherit.
 */
import { lanesFromFlat, VIEW_LIMITS, type LaneFilter, type PrView } from "../../../shared/prFilter.ts";
import { ACTIVE_KEY, PRESETS_KEY, checkName, cleanName, freeName, readActiveMap, readPresetMap, type Preset } from "./filterPresets.ts";
import { legacyEntry } from "./prBoardFilterStore.ts";
import { api } from "./api.ts";

export const ACTIVE_VIEW_KEY = "agentglass.pr.viewActive";
export const IMPORTED_KEY = "agentglass.pr.viewsImported";

export type ViewFailure = "empty" | "long" | "taken" | "full" | "missing";
export type ViewEdit = { ok: true; list: PrView[]; view: PrView } | { ok: false; reason: ViewFailure };

/* ------------------------------------------------------------ the list's edits */

const renumber = (list: PrView[]): PrView[] => list.map((v, i) => (v.order === i ? v : { ...v, order: i }));

export function addView(list: PrView[], rawName: string, filter: LaneFilter, id: string): ViewEdit {
  if (list.length >= VIEW_LIMITS.views) return { ok: false, reason: "full" };
  const n = checkName(rawName, list);
  if (!n.ok) return { ok: false, reason: n.reason };
  const view: PrView = { id, name: n.name, filter, order: list.length };
  return { ok: true, list: [...list, view], view };
}

/** Overwrite a view's filter. Name and place stay. */
export function updateView(list: PrView[], id: string, filter: LaneFilter): ViewEdit {
  const at = list.findIndex((v) => v.id === id);
  if (at < 0) return { ok: false, reason: "missing" };
  const view = { ...list[at]!, filter };
  return { ok: true, list: list.map((v, i) => (i === at ? view : v)), view };
}

export function renameView(list: PrView[], id: string, rawName: string): ViewEdit {
  const at = list.findIndex((v) => v.id === id);
  if (at < 0) return { ok: false, reason: "missing" };
  const n = checkName(rawName, list, id);
  if (!n.ok) return { ok: false, reason: n.reason };
  const view = { ...list[at]!, name: n.name };
  return { ok: true, list: list.map((v, i) => (i === at ? view : v)), view };
}

export interface RemovedView { view: PrView; index: number }

export function removeView(list: PrView[], id: string): { list: PrView[]; removed: RemovedView } | null {
  const index = list.findIndex((v) => v.id === id);
  if (index < 0) return null;
  return { list: renumber(list.filter((v) => v.id !== id)), removed: { view: list[index]!, index } };
}

/** Put a deleted view back in its place; a name taken meanwhile gets a number, a full list refuses. */
export function restoreView(list: PrView[], r: RemovedView): PrView[] | null {
  if (list.length >= VIEW_LIMITS.views || list.some((v) => v.id === r.view.id)) return null;
  const name = freeName(r.view.name, list);
  const at = Math.min(r.index, list.length);
  return renumber([...list.slice(0, at), { ...r.view, name }, ...list.slice(at)]);
}

export function moveView(list: PrView[], id: string, dir: -1 | 1): PrView[] {
  const from = list.findIndex((v) => v.id === id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return renumber(next);
}

/** The old presets as views: same names, same order, same pull requests kept. */
export function viewsFromPresets(presets: readonly Preset[]): PrView[] {
  return presets.slice(0, VIEW_LIMITS.views).map((p, i) => ({ id: p.id, name: cleanName(p.name), filter: lanesFromFlat(p.join, p.rules), order: i }));
}

/* --------------------------------------------------------------- the held copy */

export interface ViewsState { views: PrView[]; loading: boolean }

/** The server, as the store needs it; a test swaps it. */
export interface ViewsBackend {
  get(repo: string): Promise<{ ok: boolean; views?: PrView[]; saved?: boolean }>;
  put(repo: string, views: PrView[]): Promise<{ ok: boolean; views?: PrView[]; error?: string }>;
}
const realBackend: ViewsBackend = { get: (r) => api.prViews(r), put: (r, v) => api.prSetViews(r, v) };
let backend: ViewsBackend = realBackend;
export function __setViewsBackend(b: ViewsBackend | null): void { backend = b ?? realBackend; }

const states = new Map<string, ViewsState>();
const subs = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<void>>();
const writes = new Map<string, Promise<unknown>>();
const EMPTY: ViewsState = { views: [], loading: false };

export const viewsState = (repo: string): ViewsState => states.get(repo) ?? EMPTY;
function put(repo: string, s: ViewsState) {
  states.set(repo, s);
  subs.get(repo)?.forEach((cb) => cb());
}
export function subscribeViews(repo: string, cb: () => void): () => void {
  let set = subs.get(repo);
  if (!set) subs.set(repo, (set = new Set()));
  set.add(cb);
  return () => { set.delete(cb); };
}

const readJson = (k: string): unknown => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const writeJson = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const isMap = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const imported = (repo: string) => { const m = readJson(IMPORTED_KEY); return isMap(m) && m[repo] === true; };
const markImported = (repo: string) => { const m = readJson(IMPORTED_KEY); writeJson(IMPORTED_KEY, { ...(isMap(m) ? m : {}), [repo]: true }); };

/** The old presets of this repository, whichever host prefix their key carried. */
function legacyPresets(repo: string): Preset[] {
  const map = readPresetMap(readJson(PRESETS_KEY));
  return (legacyEntry(map, repo) as Preset[] | undefined) ?? [];
}

/** Load once per repository (the answer is shared); `force` asks again. */
export function loadViews(repo: string, force = false): Promise<void> {
  const held = inflight.get(repo);
  if (held) return held;
  if (!force && states.has(repo) && !states.get(repo)!.loading) return Promise.resolve();
  put(repo, { views: viewsState(repo).views, loading: true });
  const p = (async () => {
    try {
      const r = await backend.get(repo);
      if (!r.ok || !r.views) { put(repo, { views: viewsState(repo).views, loading: false }); return; }
      if (r.saved || imported(repo)) { put(repo, { views: r.views, loading: false }); return; }
      const seed = viewsFromPresets(legacyPresets(repo));
      if (!seed.length) { markImported(repo); put(repo, { views: r.views, loading: false }); return; }
      const w = await backend.put(repo, seed);
      if (w.ok) markImported(repo);
      put(repo, { views: w.ok ? w.views ?? seed : r.views, loading: false });
    } catch {
      put(repo, { views: viewsState(repo).views, loading: false });
    } finally {
      inflight.delete(repo);
    }
  })();
  inflight.set(repo, p);
  return p;
}

/** Show `next` now, write it, and put the previous list back if the server says no. Writes to one repository go in order. */
export function commitViews(repo: string, next: PrView[]): Promise<string | null> {
  const prev = viewsState(repo).views;
  put(repo, { views: next, loading: false });
  const run = async (): Promise<string | null> => {
    try {
      const r = await backend.put(repo, next);
      if (r.ok) return null;
      put(repo, { views: prev, loading: false });
      return r.error ?? "the server refused the views";
    } catch {
      put(repo, { views: prev, loading: false });
      return "the server did not answer";
    }
  };
  const chained = (writes.get(repo) ?? Promise.resolve()).then(run, run);
  writes.set(repo, chained);
  return chained;
}

/* ------------------------------------------------------------- the active view */

export function activeViewId(repo: string): string | null {
  const own = readJson(ACTIVE_VIEW_KEY);
  if (isMap(own) && typeof own[repo] === "string") return (own[repo] as string) || null;
  const old = legacyEntry(readActiveMap(readJson(ACTIVE_KEY)), repo);
  return typeof old === "string" ? old : null;
}

export function setActiveViewId(repo: string, id: string | null): void {
  const own = readJson(ACTIVE_VIEW_KEY);
  const next = { ...(isMap(own) ? own : {}) };
  if (id) next[repo] = id; else next[repo] = "";
  writeJson(ACTIVE_VIEW_KEY, next);
  activeSubs.forEach((cb) => cb());
}
const activeSubs = new Set<() => void>();
export function subscribeActive(cb: () => void): () => void {
  activeSubs.add(cb);
  return () => { activeSubs.delete(cb); };
}

/** Tests only. */
export function __resetViewsStore(): void {
  states.clear(); subs.clear(); inflight.clear(); writes.clear(); activeSubs.clear();
}
