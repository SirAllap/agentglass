/*
 * The Tasks > Jira centre column (BoardSource.Main). A flex column with ONE gap of 12 (the spacing contract): toolbar,
 * search, chips, strip, captions + lanes, footer; the card dock sits beside it. Each block is a slot file that takes the
 * model and the filters and nothing else, so a worker fills one without touching this file beyond the props it adds.
 * The list's data comes from useJiraList and from nowhere else.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import type { BoardMainProps } from "../../../lib/boardSource.ts";
import type { FooterNote } from "../../../lib/tasksFooterNote.ts";
import { useJiraList } from "../../../lib/useJiraList.ts";
import { JiraChips } from "./JiraChips.tsx";
import { JiraDock } from "./JiraDock.tsx";
import { JiraFooter } from "./JiraFooter.tsx";
import { JiraLanes } from "./JiraLanes.tsx";
import { JiraSearch } from "./JiraSearch.tsx";
import { JiraStrip } from "./JiraStrip.tsx";
import { JiraToolbar } from "./JiraToolbar.tsx";
import { lookedModel, NO_FILTERS, type JiraListFilters } from "./model.ts";
import { useJiraMenus } from "./menus/JiraMenuHost.tsx";
import { usePrefs, withPrefs } from "./menus/viewPrefs.ts";

export function JiraListView({ source, viewId, areaId, writable, onAllow, feed, reload, active, looked, show }: BoardMainProps) {
  /* What narrows the list belongs to the board it was set on: kept per view for this visit, never carried over. */
  const [byView, setByView] = useState<Record<string, JiraListFilters>>({});
  const filterKey = viewId ?? "";
  const filters = byView[filterKey] ?? NO_FILTERS;
  const onFilters = useCallback((patch: Partial<JiraListFilters>) => {
    setByView((m) => ({ ...m, [filterKey]: { ...(m[filterKey] ?? NO_FILTERS), ...patch } }));
  }, [filterKey]);

  const model = useJiraList({ source, viewId, areaId, filters, reload, active, feed, writable });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState<FooterNote | null>(null);
  /* menus: a sub-task or a parent may not be on the page, so the card opened from a menu is kept here. */
  const [kept, setKept] = useState<ProviderTask | null>(null);
  const card = (selectedId && (model.cards.find((t) => t.id === selectedId) ?? looked?.cards.find((t) => t.id === selectedId) ?? (kept?.id === selectedId ? kept : null))) || null;
  const openCard = useCallback((t: ProviderTask) => { setSelectedId(t.id); setKept(t); }, []);
  // A card the search found that is on no lane is kept in the sidebar's Looked up, as the panel's own search does.
  const openFound = useCallback((t: ProviderTask) => { if (!model.cards.some((c) => c.id === t.id)) looked?.add(t); openCard(t); }, [model.cards, looked, openCard]);
  /* The body asks for a card (the pull-request panel's "show me this card", a find): open it once it is on the page or in Looked up. */
  const [asked, setAsked] = useState<number>(show?.n ?? 0);
  const want = show && show.n !== asked ? show : null;
  const wanted = want ? (model.cards.find((t) => t.id === want.id) ?? looked?.cards.find((t) => t.id === want.id) ?? null) : null;
  useEffect(() => { if (want && wanted) { setAsked(want.n); openCard(wanted); } }, [want?.n, wanted, openCard]); // eslint-disable-line react-hooks/exhaustive-deps
  const menus = useJiraMenus({ model, source, viewId, writable, selected: card, onOpen: openCard, onNote: setNote });
  const prefs = usePrefs(viewId);
  const forget = useCallback((t: ProviderTask) => { looked?.forget(t.id); setKept(null); setSelectedId((cur) => (cur === t.id ? null : cur)); }, [looked]);
  const lookedOn = !!looked?.on && looked.cards.length > 0;
  const shown = useMemo(() => (lookedOn ? lookedModel(model, looked!.cards) : withPrefs(model, prefs)), [model, prefs, lookedOn, looked]);
  /* end menus */

  return (
    <div data-testid="jira-list" className="relative flex flex-1 min-h-0 min-w-0">
      <div className="flex flex-col flex-1 min-w-0 min-h-0" style={{ gap: 12 }}>
        <JiraToolbar model={model} onRefresh={model.refresh} areaId={areaId} />
        <JiraSearch filters={filters} onFilters={onFilters} model={model} source={source} onOpenCard={openFound} />
        <JiraChips model={model} filters={filters} onFilters={onFilters} areaId={areaId} />
        <JiraStrip model={model} onRefresh={model.refresh} />
        <JiraLanes model={shown} viewId={viewId} areaId={areaId} filters={filters} onFilters={onFilters} selectedId={selectedId} onOpen={setSelectedId} onForget={lookedOn ? forget : undefined} {...menus.handlers} />
        <JiraFooter model={model} note={note} onCloseNote={() => setNote(null)} />
      </div>
      <JiraDock source={source} card={card} writable={writable} onTask={model.fold} onClose={() => setSelectedId(null)} onAllow={onAllow} {...menus.handlers} />
      {menus.host}
    </div>
  );
}
