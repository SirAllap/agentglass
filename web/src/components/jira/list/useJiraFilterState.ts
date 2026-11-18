/*
 * What narrows the Jira list and where it is kept: the filters per site view, the person's layout over the default views, the tab
 * lit on top, and the way a restart finds them again. Everything the centre column asks of it comes back from here, so a test
 * mounts it alone and plays a boot as the screen does.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { askFullJql } from "../../../lib/jqlFull.ts";
import { useJiraViewLayout } from "../../../lib/useJiraViewLayout.ts";
import { isAreaScope, NO_FILTERS, startFilters, type JiraListFilters } from "./model.ts";
import { leaveTab, loadChip, keepFilters, keepRest, keptKey, mayKeepRest, tabRestore, pickRest, pickKept, teamFromFavourites, teamScoped, meViewTab, NO_VIEW_FILTERS, viewJql, viewTabs, DEFAULT_VIEWS } from "./viewsModel.ts";

export function useJiraFilterState({ viewId, areaId, onSelect, favourites }: { viewId: string | null; areaId: string | null; onSelect?: (s: { viewId?: string; areaId?: string | null }) => void; favourites: readonly { jql: string }[] }) {
  /* What narrows the list belongs to the board it was set on: kept per view for this visit, never carried over. */
  const [byView, setByView] = useState<Record<string, JiraListFilters>>({});
  const filterKey = viewId ?? "";
  const filters = byView[filterKey] ?? startFilters(viewId, areaId);
  const onFilters = useCallback((patch: Partial<JiraListFilters>) => {
    setByView((m) => ({ ...m, [filterKey]: { ...(m[filterKey] ?? startFilters(viewId, areaId)), ...patch } }));
  }, [filterKey, viewId, areaId]);
  /* The default views (Mine, Mine · sprint, Team, Team · sprint): the person's order, names and hidden ones over them, and the filters kept with each. */
  const [layout, setLayout] = useJiraViewLayout();
  const named = useMemo(() => viewTabs(layout), [layout]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  /* Leaving a default tab by picking another list in the left bar: the tab's filters were written under the board's key, so
     they are dropped there too, or coming back to the board shows Team's people with no tab lit (measured: Team, then a
     starred filter from the sidebar, then the board again — "People: 4" was still on). */
  const leftKey = useRef(filterKey);
  const tabOn = useRef(activeTab); tabOn.current = activeTab;
  useEffect(() => {
    const was = leftKey.current; leftKey.current = filterKey;
    if (was !== filterKey && isAreaScope(was)) setByView((m) => { const { [was]: _gone, ...rest } = m; return rest; });
    else if (was !== filterKey && tabOn.current) setByView((m) => ({ ...m, [was]: { ...(m[was] ?? NO_FILTERS), ...leaveTab((m[was] ?? NO_FILTERS).spaces) } }));
    setActiveTab(null);
  }, [filterKey]);
  /* Filters set inside a default view are kept with it; a space or a person changes the view's own search, so that is asked again. */
  const applyFilters = useCallback((patch: Partial<JiraListFilters>) => {
    onFilters(patch);
    if (!activeTab || !("spaces" in patch || "statusPick" in patch || "assigneePick" in patch || "tagPick" in patch || "epicPick" in patch || "componentPick" in patch)) return;
    const next = pickKept({ ...filters, ...patch });
    setLayout((l) => keepFilters(l, activeTab, next));
    const spec = DEFAULT_VIEWS.find((v) => v.id === activeTab);
    if (spec && ("spaces" in patch || "assigneePick" in patch)) { const jql = layout.jql[spec.id] ?? viewJql(spec, next); onFilters({ viewJql: jql, viewCross: !!spec.cross }); askFullJql(jql); }
  }, [activeTab, filters, onFilters, setLayout]);
  /* Every applied filter and the search text are kept per site view and tab, so a restart finds them as they were. The "Changed" toggle is not here. */
  /* An epic or component picked in the left bar is a board of its own: its slot is view + area, so two epics never share one. */
  const slot = keptKey(areaId && !activeTab ? `${filterKey}@${areaId}` : filterKey, activeTab);
  const entry = byView[filterKey];
  /* Which slot the live filters belong to. After an epic change the entry is still the last epic's until the restore below runs, and must not be written under the new slot. */
  const owner = useRef<string | null>(null);
  useEffect(() => {
    if (!entry || !mayKeepRest(viewId, activeTab)) return;
    if (areaId && !activeTab && owner.current !== slot) return;
    setLayout((l) => keepRest(l, slot, pickRest(entry)));
  }, [entry, slot, viewId, areaId, activeTab, setLayout]);
  /* A view with no filters yet this visit takes the ones it kept (a tab restores its own in pickTab). An epic or component
     takes its own slot on every change, on boot as well: a tab or the me view is lit by pickTab, so it is left out. */
  const restored = useRef(new Set<string>());
  useEffect(() => {
    if (activeTab || meViewTab(viewId)) return;
    if (areaId) {
      if (owner.current === slot) return;
      owner.current = slot;
      onFilters({ ...startFilters(viewId, areaId), ...layout.kept[slot] });
      return;
    }
    if (byView[filterKey] || restored.current.has(filterKey)) return;
    restored.current.add(filterKey);
    const k = layout.kept[slot];
    if (k) onFilters(k);
  }, [filterKey, byView, activeTab, viewId, areaId, slot, layout.kept, onFilters]);
  const pickTab = useCallback((id: string) => {
    /* The "Assigned to me" view lights Mine whether or not Mine is hidden from the strip: hiding a tab must not stop its kept filters from being read. */
    const t = named.find((x) => x.id === id) ?? (id === meViewTab(viewId) ? viewTabs({ ...layout, hidden: layout.hidden.filter((h) => h !== id) }).find((x) => x.id === id) : undefined);
    if (!t) return;
    /* A tab is a view of its own, not a filter inside whatever the left bar has open: picking one lets go of the epic or
       component picked there, so Mine or Team never shows only that epic's cards. The space stays — it is the board. */
    if (areaId) onSelect?.({ areaId: null });
    setActiveTab(id);
    /* The view's search lives in the chip, never in the box: the box stays empty for typing. */
    /* Team with nobody picked yet takes the people of a starred Jira filter "assignee in (...)"; with none, the people picker stays. */
    const spec = DEFAULT_VIEWS.find((v) => v.id === id);
    let kept = layout.filters[id];
    let jql = t.jql;
    if (spec) { const scoped = teamScoped(spec, kept, viewId); /* For this visit only: not saved with the view, or Team would keep the first space it was ever opened under. */
    if (scoped && scoped !== kept) { kept = scoped; jql = layout.jql[id] ?? viewJql(spec, kept); } }
    const seed = spec?.team && !kept?.people.length ? teamFromFavourites(favourites) : [];
    if (spec && seed.length) { kept = { ...(kept ?? NO_VIEW_FILTERS), people: seed }; const k = kept; setLayout((l) => keepFilters(l, id, k)); jql = layout.jql[id] ?? viewJql(spec, kept); }
    onFilters({ ...tabRestore(layout, filterKey, id, kept), viewJql: jql, viewCross: !!DEFAULT_VIEWS.find((v) => v.id === id)?.cross });
    if (jql) askFullJql(jql);
  }, [named, viewId, areaId, filterKey, onSelect, layout.hidden, layout.order, layout.names, layout.filters, layout.jql, layout.kept, favourites, onFilters, setLayout]);
  /* The other way round: an epic or component picked in the left bar is its own view, so the tab on top lets go and
     its search with it — the epic is never read through Mine or Team. */
  const lastArea = useRef(areaId);
  useEffect(() => {
    const was = lastArea.current; lastArea.current = areaId;
    if (!areaId || areaId === was || !activeTab || meViewTab(viewId)) return;
    setActiveTab(null);
    onFilters({ ...startFilters(viewId, areaId), viewJql: null, viewCross: false });
  }, [areaId, activeTab, onFilters, viewId]);
  /* Opening "Assigned to me" opens the Mine view (cross-space); the board is not a hidden filter under it. */
  const meSeeded = useRef(new Set<string>());
  useEffect(() => {
    const mine = meViewTab(viewId);
    /* Leaving the view forgets it was opened, so coming back from the sidebar lands on Mine again, as the tab does. */
    if (!mine) { meSeeded.current.clear(); return; }
    /* Not `byView[filterKey]`: a reload lets go of the view for a moment and the entry it leaves is the emptied one, which would keep the tab dark and the kept filters unread. */
    if (meSeeded.current.has(filterKey)) return;
    meSeeded.current.add(filterKey);
    pickTab(mine);
  }, [viewId, filterKey, pickTab]);
  return { byView, filterKey, filters, onFilters, layout, setLayout, named, activeTab, setActiveTab, applyFilters, pickTab };
}
