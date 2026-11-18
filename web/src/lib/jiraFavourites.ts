/*
 * "Sync with Jira filters": whether the sidebar's Starred filters also list the person's favourite filters on the site.
 *
 * A preference of this window (localStorage, like the diff defaults), read by the sidebar and by Settings. The default,
 * on, is stored as an absent key so a window that never chose follows the default if it ever moves. The favourites are
 * asked once, when the setting is on and Jira is showing; a failure leaves the local queries alone.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api.ts";

const KEY = "agentglass.jira.syncFavourites";
export const DEFAULT_SYNC_FAVOURITES = true;

const listeners = new Set<() => void>();
const read = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };

export const syncFavouritesNow = (): boolean => (read() === null ? DEFAULT_SYNC_FAVOURITES : read() === "1");

export function setSyncFavourites(on: boolean): void {
  try { if (on === DEFAULT_SYNC_FAVOURITES) localStorage.removeItem(KEY); else localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private mode */ }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) l(); };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => { listeners.delete(l); if (typeof window !== "undefined") window.removeEventListener("storage", onStorage); };
}

export function useSyncFavourites(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, syncFavouritesNow, () => DEFAULT_SYNC_FAVOURITES);
  return [on, setSyncFavourites];
}

export interface Favourite { id: string; name: string; jql: string }

/** The person's favourite filters; empty while unknown, when the setting is off, and when Jira said no. */
export function useJiraFavourites(enabled: boolean): Favourite[] {
  const [list, setList] = useState<Favourite[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const gone = new AbortController();
    void api.jiraFavourites(gone.signal).then((r) => {
      if (!gone.signal.aborted) setList(r.ok && r.filters ? r.filters : []);
    }).catch(() => { /* the local queries stand alone */ });
    return () => gone.abort();
  }, [enabled]);
  return enabled ? list : [];
}

/** Keep a favourite filter in the local address book so it can be opened like any saved view; Jira is not written to. */
export const saveFavourite = (viewId: string) => api.jiraAddView({ kind: "filter", id: viewId.replace(/^filter:/, "") });

export const NO_FAVOURITES = "No Jira favourites";
export const FAVOURITES_FAILED = "Could not read Jira filters";

/** Save each favourite not saved yet, stopping when `signal` aborts; returns how many were saved. */
export async function importFavourites(
  filters: readonly { id: string }[], have: ReadonlySet<string>, signal: AbortSignal,
  save: (id: string) => Promise<{ ok: boolean }> = saveFavourite,
): Promise<number> {
  let added = 0;
  for (const f of filters) {
    if (signal.aborted) break;
    if (have.has(`filter:${f.id}`)) continue;
    if ((await save(f.id)).ok) added++;
  }
  return added;
}

/**
 * "Sync with Jira filters" on: the favourites are read once and each one not saved here becomes a saved query linked to its
 * Jira filter (its id is `filter:<id>`, so a filter already saved is never added twice). An empty answer adds nothing and says so;
 * a failure leaves the switch on and says so in a quiet line. Returns that line, "" when there is nothing to say.
 *
 * Ceiling: imported once per window open; a filter starred in Jira afterwards comes in at the next open, not live.
 */
export function useFavouriteImport(enabled: boolean, saved: ReadonlySet<string>, imported: () => void): string {
  const [note, setNote] = useState("");
  const have = useRef(saved); have.current = saved;
  const done = useRef(imported); done.current = imported;
  useEffect(() => {
    if (!enabled) { setNote(""); return; }
    const gone = new AbortController();
    void (async () => {
      try {
        const r = await api.jiraFavourites(gone.signal);
        if (gone.signal.aborted) return;
        if (!r.ok || !r.filters) { setNote(FAVOURITES_FAILED); return; }
        if (r.filters.length === 0) { setNote(NO_FAVOURITES); return; }
        setNote("");
        /* Whatever was saved must reach the sidebar even when this run was cancelled half way (the tab went hidden, the effect re-ran):
           otherwise the filters are saved but the list stays on "No saved boards or filters yet" until the next open. */
        const added = await importFavourites(r.filters, have.current, gone.signal);
        if (added) done.current();
      } catch { if (!gone.signal.aborted) setNote(FAVOURITES_FAILED); }
    })();
    return () => gone.abort();
  }, [enabled]);
  return enabled ? note : "";
}
