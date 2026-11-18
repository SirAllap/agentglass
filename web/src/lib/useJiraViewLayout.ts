/* The person's layout over the board's views (order, names, hidden, the filters kept with each), kept on this machine. */
import { useCallback, useEffect, useState } from "react";
import { readLayout, type ViewLayout } from "../components/jira/list/viewsModel.ts";

const KEY = "agentglass.jira.viewLayout";
/* The copy every panel shares, kept in memory too: when storage cannot be read (private mode, blocked), an edit still starts from what was last kept, never from the defaults. */
let shared: ViewLayout | null = null;
export const __resetSharedLayout = (): void => { shared = null; };
export function loadLayout(): ViewLayout {
  try { shared = readLayout(JSON.parse(localStorage.getItem(KEY) ?? "null")); } catch { shared ??= readLayout(null); }
  return shared;
}
const load = loadLayout;
/** One edit: from the shared copy (storage when it can be read), kept in memory and, when it can be written, in storage. */
export function editLayout(f: (l: ViewLayout) => ViewLayout): ViewLayout {
  const n = f(load());
  shared = n;
  try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* private mode */ }
  return n;
}
/* Every mounted panel shares one copy: a panel that held its own would write its stale layout over what another kept (two Jira panels open, one reloading, wiped the filters the other had saved). */
const listeners = new Set<(l: ViewLayout) => void>();

export function useJiraViewLayout(): [ViewLayout, (f: (l: ViewLayout) => ViewLayout) => void] {
  const [layout, set] = useState<ViewLayout>(load);
  useEffect(() => { listeners.add(set); return () => void listeners.delete(set); }, []);
  const update = useCallback((f: (l: ViewLayout) => ViewLayout) => {
    const n = editLayout(f);
    for (const l of listeners) l(n);
    set(n);
  }, []);
  return [layout, update];
}
