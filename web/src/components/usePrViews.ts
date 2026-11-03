/*
 * The board's saved views, as React state: the list the server holds for this
 * repository, which one is on, and the edits. The data rules and the held copy
 * live in lib/prViewsStore.ts (the agent door shares them); this only subscribes.
 *
 * `repo` is `owner/name`, not the panel's `repo.key`: the server and the agent
 * door know the first only.
 *
 * Which view is on is per machine (localStorage, ACTIVE_VIEW_KEY), not on the
 * server: a screen's current view is not something another device should inherit.
 * The list itself, and so its order and names, is the server's.
 *
 * Edits return the reason they were refused, synchronously (a name taken, a full
 * list), the way useFilterPresets did, and write to the server behind it; a
 * refusal from the server puts the list back.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { LaneFilter, PrView } from "../../../shared/prFilter.ts";
import {
  activeViewId, addView, commitViews, loadViews, moveView, removeView, renameView, restoreView, setActiveViewId,
  subscribeActive, subscribeViews, updateView, viewsState, type RemovedView, type ViewEdit, type ViewFailure,
} from "../lib/prViewsStore.ts";

/** How long a delete can be taken back. */
export const UNDO_MS = 6000;

export type PrViewFailure = ViewFailure | "offline";

export interface PrViewsApi {
  views: PrView[];
  loading: boolean;
  active: PrView | null;
  setActive: (id: string | null) => void;
  /** Overwrite this view's filter (and name): "Save to <view>". */
  save: (view: PrView) => PrViewFailure | null;
  /** Append a view made of `filter` and make it the active one. */
  saveNew: (name: string, filter: LaneFilter) => PrViewFailure | null;
  remove: (id: string) => void;
  rename: (id: string, name: string) => PrViewFailure | null;
  move: (id: string, dir: -1 | 1) => void;
  undo: { id: string; name: string } | null;
  restore: () => void;
}

const viewId = () => `pv${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const none = () => () => {};
const NO_VIEWS = { views: [] as PrView[], loading: false };

export function usePrViews(repo: string | null): PrViewsApi {
  const sub = useCallback((cb: () => void) => (repo ? subscribeViews(repo, cb) : none()), [repo]);
  const readState = () => (repo ? viewsState(repo) : NO_VIEWS);
  const state = useSyncExternalStore(sub, readState, readState);
  const readActive = () => (repo ? activeViewId(repo) : null);
  const stored = useSyncExternalStore(subscribeActive, readActive, readActive);
  const [removed, setRemoved] = useState<RemovedView | null>(null);

  useEffect(() => { if (repo) void loadViews(repo); }, [repo]);
  // The repository changed under the toast: its undo belongs to the other list.
  useEffect(() => { setRemoved(null); }, [repo]);
  useEffect(() => {
    if (!removed) return;
    const t = setTimeout(() => setRemoved(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [removed]);

  const list = state.views;
  const active = useMemo(() => (stored ? list.find((v) => v.id === stored) ?? null : null), [list, stored]);

  const setActive = useCallback((id: string | null) => { if (repo) setActiveViewId(repo, id); }, [repo]);

  // The latest list, read at call time: a rename must say "taken" before the next render.
  const apply = useCallback((edit: (cur: PrView[]) => ViewEdit): { failure: PrViewFailure | null; view?: PrView } => {
    if (!repo) return { failure: "offline" };
    const r = edit(viewsState(repo).views);
    if (!r.ok) return { failure: r.reason };
    void commitViews(repo, r.list);
    return { failure: null, view: r.view };
  }, [repo]);

  const save = useCallback((v: PrView) => {
    const a = apply((cur) => {
      const u = updateView(cur, v.id, v.filter);
      return u.ok && v.name !== u.view.name ? renameView(u.list, v.id, v.name) : u;
    });
    return a.failure;
  }, [apply]);

  const saveNew = useCallback((name: string, filter: LaneFilter) => {
    const a = apply((cur) => addView(cur, name, filter, viewId()));
    if (a.view) setActive(a.view.id);
    return a.failure;
  }, [apply, setActive]);

  const rename = useCallback((id: string, name: string) => apply((cur) => renameView(cur, id, name)).failure, [apply]);

  const move = useCallback((id: string, dir: -1 | 1) => {
    if (!repo) return;
    const cur = viewsState(repo).views;
    const next = moveView(cur, id, dir);
    if (next !== cur) void commitViews(repo, next);
  }, [repo]);

  const remove = useCallback((id: string) => {
    if (!repo) return;
    const d = removeView(viewsState(repo).views, id);
    if (!d) return;
    void commitViews(repo, d.list);
    if (stored === id) setActive(null);
    setRemoved(d.removed);
  }, [repo, stored, setActive]);

  const restore = useCallback(() => {
    if (!repo || !removed) return;
    const next = restoreView(viewsState(repo).views, removed);
    setRemoved(null);
    if (next) void commitViews(repo, next);
  }, [repo, removed]);

  const undo = useMemo(() => (removed ? { id: removed.view.id, name: removed.view.name } : null), [removed]);
  return useMemo(
    () => ({ views: list, loading: state.loading, active, setActive, save, saveNew, remove, rename, move, undo, restore }),
    [list, state.loading, active, setActive, save, saveNew, remove, rename, move, undo, restore],
  );
}
