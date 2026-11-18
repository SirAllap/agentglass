/*
 * The Jira list pane's saved views and saved searches: loaded from the local store (`source.views`, no request to Jira)
 * and changed through the server's own routes. Components under components/jira/list/ take what this returns and never
 * call the api themselves (the list seam). Removing a view only deletes the local entry; nothing in Jira changes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SavedView } from "../../../shared/providers.ts";
import type { BoardSource } from "./boardSource.ts";
import { api } from "./api.ts";
import { savedQueries, type SavedQuery } from "../components/jira/list/tabsModel.ts";
import { forgetViewCount } from "./useJiraViewCounts.ts";

export interface SavedViewsCtl {
  views: SavedView[];
  queries: SavedQuery[];
  save: (jql: string, name?: string) => Promise<{ ok: boolean; error?: string; view?: SavedView }>;
  edit: (id: string, patch: { name?: string; team?: boolean; tab?: boolean; jql?: string }) => Promise<{ ok: boolean; error?: string }>;
  duplicate: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /** Deletes the local saved entry only. */
  remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
}

const NO_SERVER = { ok: false, error: "Could not reach the server" } as const;

/**
 * A change that worked re-reads this strip's views, then tells whoever else holds a copy (the sidebar's starred list is
 * read separately): without it a removed view stayed in the sidebar and clicking it opened nothing.
 */
export async function afterChange<T extends { ok: boolean }>(p: Promise<T>, reload: () => Promise<void>, changed?: () => void): Promise<T> {
  const r = await p;
  if (r.ok) { await reload(); changed?.(); }
  return r;
}

export function useJiraSavedViews(source: BoardSource, enabled = true, onChanged?: () => void): SavedViewsCtl {
  const [views, setViews] = useState<SavedView[]>([]);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const load = useCallback(async () => {
    try {
      const r = await source.views();
      if (live.current) setViews(r.views ?? []);
    } catch { /* the tabs keep what they had */ }
  }, [source]);
  useEffect(() => { if (enabled) void load(); }, [load, enabled]);

  const changed = useRef(onChanged); changed.current = onChanged;
  const after = useCallback(<T extends { ok: boolean }>(p: Promise<T>): Promise<T> => afterChange(p, load, () => changed.current?.()), [load]);

  return useMemo(() => ({
    views,
    queries: savedQueries(views),
    save: async (jql, name) => {
      try {
        const r = await after(api.jiraSaveJql(jql, name));
        if (r.ok && r.view) forgetViewCount(r.view.id);
        return r;
      } catch { return NO_SERVER; }
    },
    edit: async (id, patch) => {
      try {
        const r = await after(api.jiraEditView(id, patch));
        if (r.ok && patch.jql !== undefined) forgetViewCount(id);
        return r;
      } catch { return NO_SERVER; }
    },
    duplicate: async (id) => {
      try { return await after(api.jiraDuplicateView(id)); } catch { return NO_SERVER; }
    },
    remove: async (id) => {
      try { return await after(api.jiraRemoveView(id)); } catch { return NO_SERVER; }
    },
  }), [views, after]);
}
