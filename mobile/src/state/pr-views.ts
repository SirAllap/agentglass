/*
 * The board's saved views, read from the computer's `/prs/views` store.
 *
 * The server owns the list (`~/.config/agentglass/pr-views.json`, validated by
 * shared/prFilter.ts) and the desk edits it; the phone INHERITS it. One copy is
 * held per computer and repository — a checkout path is not a repository, so
 * the key is the `owner/name` the list answer carries — and it is in memory,
 * like the rest of this app's per-visit state.
 *
 * Which view is on is this phone's own, also in memory and never on the server:
 * a screen's current view is not something the desk should inherit, and it is
 * the same rule the desktop keeps in its own localStorage.
 *
 * `saveNewView` is the save-view sheet's write: it re-reads the desk's list
 * first, so a view saved on the desk a minute ago is not overwritten by a stale
 * phone copy, then writes the whole list back like the desk does.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { PrView } from "../../../shared/prFilter.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import type { LaneRules } from "../model/prBoard.ts";
import { NAME_FAILURE, newViewId, withNewView } from "../model/prViewSave.ts";

/** The server's answer, folded so every failure is a value. */
export interface ViewsAnswer { ok: boolean; views?: PrView[]; saved?: boolean; error?: string }

/** The computer, as the store needs it; a test swaps it. */
export interface ViewsBackend {
  get(host: Host, repo: string): Promise<ViewsAnswer>;
  put(host: Host, repo: string, views: PrView[]): Promise<ViewsAnswer>;
}

const realBackend: ViewsBackend = {
  get: async (host, repo) => {
    const a = await ask<ViewsAnswer>(host, `/prs/views?repo=${encodeURIComponent(repo)}`);
    return a.ok ? a.value : { ok: false, error: a.error };
  },
  put: async (host, repo, views) => {
    const a = await ask<ViewsAnswer>(host, `/prs/views?repo=${encodeURIComponent(repo)}`, {
      method: "POST",
      body: { views },
    });
    return a.ok ? a.value : { ok: false, error: a.error };
  },
};
let backend: ViewsBackend = realBackend;
export function __setViewsBackend(b: ViewsBackend | null): void { backend = b ?? realBackend; }

interface Held { views: PrView[]; loading: boolean; loaded: boolean; asked: boolean }

const held = new Map<string, Held>();
const confirmed = new Map<string, PrView[]>();
const active = new Map<string, string>();
const inflight = new Map<string, Promise<void>>();
const writes = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
const EMPTY: Held = { views: [], loading: false, loaded: false, asked: false };

/* The token is in the key because two paired computers can hold a repository at
 * the same path, and a re-pair (same origin, new token) revokes the old one. */
const keyOf = (host: Host, repo: string): string => `${host.origin}\n${host.token}\n${repo}`;

function tell(): void { for (const l of listeners) l(); }
function put(key: string, next: Held): void { held.set(key, next); tell(); }

export function subscribeViews(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** What is held for this repository; never asks. Stable between changes. */
export function viewsOf(host: Host | null, repo: string | null): Held {
  return host && repo ? held.get(keyOf(host, repo)) ?? EMPTY : EMPTY;
}

/** What a read has produced, so a screen can say loading, empty and failed
 *  differently instead of drawing no chips for all three. */
export type ViewsCondition = "idle" | "loading" | "ready" | "empty" | "failed";

export function viewsCondition(h: Held): ViewsCondition {
  if (h.loading) return "loading";
  if (!h.asked) return "idle";
  if (!h.loaded) return "failed";
  return h.views.length ? "ready" : "empty";
}

/** Read once per repository and computer; `force` asks again (a pull-to-refresh,
 *  a focus, opening the sheet). A forced read replaces a held list, so an edit
 *  made on the desk reaches an open phone without a poll. */
export function loadViews(host: Host, repo: string, force = false): Promise<void> {
  const key = keyOf(host, repo);
  const running = inflight.get(key);
  if (running) return running;
  const was = held.get(key);
  // A failure is not remembered as "this repository has no views": `loaded` only
  // turns true on a server answer, so the next visit asks again.
  if (!force && was?.loaded) return Promise.resolve();
  put(key, { views: was?.views ?? [], loading: true, loaded: false, asked: true });
  const asked = (async () => {
    try {
      const answer = await backend.get(host, repo);
      const views = answer.ok && Array.isArray(answer.views) ? answer.views : was?.views ?? [];
      if (answer.ok) confirmed.set(key, views);
      put(key, { views, loading: false, loaded: answer.ok, asked: true });
    } catch {
      put(key, { views: was?.views ?? [], loading: false, loaded: false, asked: true });
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, asked);
  return asked;
}

/**
 * Show `next` now, write it, and put the server's list back if the server says
 * no. Writes to one repository go in order, like the desk's.
 *
 * The list to restore is the last one the server CONFIRMED, not the list held
 * when this call started: two refused commits queued back to back would
 * otherwise restore the first one's optimistic list over the second's failure.
 * With no confirmed read at all the answer is the empty list, never an
 * optimistic one the server never accepted.
 */
export function commitViews(host: Host, repo: string, next: PrView[]): Promise<string | null> {
  const key = keyOf(host, repo);
  put(key, { views: next, loading: false, loaded: true, asked: true });
  const restore = (): void => {
    put(key, { views: confirmed.get(key) ?? [], loading: false, loaded: true, asked: true });
  };
  const run = async (): Promise<string | null> => {
    try {
      const answer = await backend.put(host, repo, next);
      if (answer.ok) { confirmed.set(key, next); return null; }
      restore();
      return answer.error ?? "the server refused the views";
    } catch {
      restore();
      return "the computer did not answer";
    }
  };
  const chained = (writes.get(key) ?? Promise.resolve()).then(run, run);
  writes.set(key, chained);
  return chained;
}

/** Save the board's rules as a new view. Null on success, else a sentence for the sheet. */
export async function saveNewView(host: Host, repo: string, name: string, rules: LaneRules): Promise<string | null> {
  await loadViews(host, repo, true);
  const now = viewsOf(host, repo);
  if (!now.loaded) return "The computer did not answer, so nothing was saved. Try again.";
  const r = withNewView(now.views, name, rules, newViewId());
  if (!r.ok) return NAME_FAILURE[r.reason];
  const err = await commitViews(host, repo, r.list);
  if (err) return err;
  setActiveViewId(host, repo, r.view.id);
  return null;
}

/* ------------------------------------------------------------- the active view */

export function activeViewId(host: Host | null, repo: string | null): string | null {
  return host && repo ? active.get(keyOf(host, repo)) ?? null : null;
}

export function setActiveViewId(host: Host, repo: string, id: string | null): void {
  const key = keyOf(host, repo);
  if (id) active.set(key, id); else active.delete(key);
  tell();
}

/** The list, the one that is on, and the way to move it. */
export interface PhoneViews {
  views: PrView[];
  loading: boolean;
  condition: ViewsCondition;
  active: PrView | null;
  /** The id this phone had on is no longer in the desk's list. */
  activeMissing: boolean;
  setActive: (id: string | null) => void;
  /** Ask the desk again, for the retry row and the focus read. */
  retry: () => void;
}

export function usePrViews(host: Host | null, repo: string | null): PhoneViews {
  const heldFor = useCallback(() => viewsOf(host, repo), [host, repo]);
  const state = useSyncExternalStore(subscribeViews, heldFor, heldFor);
  const readActive = useCallback(() => activeViewId(host, repo), [host, repo]);
  const id = useSyncExternalStore(subscribeViews, readActive, readActive);
  useEffect(() => { if (host && repo) void loadViews(host, repo); }, [host, repo]);
  const setActive = useCallback(
    (next: string | null) => { if (host && repo) setActiveViewId(host, repo, next); },
    [host, repo],
  );
  const retry = useCallback(() => { if (host && repo) void loadViews(host, repo, true); }, [host, repo]);
  const activeView = useMemo(() => state.views.find((v) => v.id === id) ?? null, [state.views, id]);
  /* Only a successful list can say a view is gone; a failed read says nothing
     about the desk's file. */
  const activeMissing = !!id && state.loaded && !state.loading && !activeView;
  return { views: state.views, loading: state.loading, condition: viewsCondition(state), active: activeView, activeMissing, setActive, retry };
}

/** Tests only. */
export function __resetViews(): void {
  held.clear(); confirmed.clear(); active.clear(); inflight.clear(); writes.clear(); listeners.clear();
  backend = realBackend;
}
