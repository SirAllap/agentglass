/*
 * The Tasks > Jira centre column (BoardSource.Main). A flex column with ONE gap of 12 (the spacing contract): toolbar,
 * search, chips, strip, captions + lanes, footer; the card dock sits beside it. Each block is a slot file that takes the
 * model and the filters and nothing else, so a worker fills one without touching this file beyond the props it adds.
 * The list's data comes from useJiraList and from nowhere else.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import type { BoardMainProps } from "../../../lib/boardSource.ts";
import type { FooterNote } from "../../../lib/tasksFooterNote.ts";
import { typingInto } from "../../../lib/taskGrammar.ts";
import { useJiraList } from "../../../lib/useJiraList.ts";
import { useJiraSavedViews } from "../../../lib/useJiraSavedViews.ts";
import { useJiraTeam } from "../../../lib/useJiraTeam.ts";
import { useJiraFilterState } from "./useJiraFilterState.ts";
import { nameForQueryWith, usePersonNames } from "../../../lib/personNames.ts";
import { askFullJql } from "../../../lib/jqlFull.ts";
import { onJiraSearch, reportJiraSearch } from "../../../lib/jiraSearchBus.ts";
import { back as backHist, canBack, here, startHistory, visit as visitHist, type History as CardHistory } from "../../../lib/finderHistory.ts";
import { findCardByKey } from "../../../lib/jiraCardLookup.ts";
import { openJiraJump, publishJiraQueries, setJiraViewActive } from "../../../lib/jiraQueryPalette.ts";
import { projectOf } from "../../../lib/jiraSettings.ts";
import { rosterOf, scopeIdOf, type TeamMember } from "../../../lib/jiraTree.ts";
import { cardKeysOf, liveKeys, fleetNow, onFleet } from "../../../lib/jiraCardWork.ts";
import { boardKey, looksJql, railFolds, type BoardDensity, type BoardLanes, type BoardMode } from "./boardModel.ts";
import { JiraKeyBar, KeyLegend } from "./JiraKeyBar.tsx";
import { BulkActions, BulkBar } from "./BulkBar.tsx";
import { EMPTY_SELECTION, toggleSelected } from "./selectionModel.ts";
import { jqlUrl } from "./menus/menuModel.ts";
import { useBoardsInView } from "./menus/boardsInView.ts";
import { boardNextNames, boardOf } from "./sprintModel.ts";
import { openExternal } from "../../../lib/externalUrl.ts";
import { JiraBoard } from "./JiraBoard.tsx";
import { CLEARED, filtering, keyOf, listState } from "./laneModel.ts";
import { JiraDisplayMenu } from "./JiraDisplayMenu.tsx";
import { JiraFiltersMenu } from "./JiraFiltersMenu.tsx";
import { epicNamesOf } from "./facetsModel.ts";
import { countLine, countText, editCaption, filterCount } from "./headerModel.ts";
import { ActiveFilters } from "./ActiveFilters.tsx";
import { JiraDock } from "./JiraDock.tsx";
import { JiraFooter } from "./JiraFooter.tsx";
import { JiraLanes } from "./JiraLanes.tsx";
import { JiraSearch } from "./JiraSearch.tsx";
import { JiraJump } from "../JiraJump.tsx";
import { JiraTabs } from "./JiraTabs.tsx";
import { clampDockResize, dockWidth, jqlOf, nameForQuery, orderTabs, setNamedTabCount, TAB_PREFIX, type SavedQuery } from "./tabsModel.ts";
import { savePreset, removePreset, leaveTab, tabStart, loadChip, hideView, showView, keepFilters, keepRest, keptKey, mayKeepRest, tabRestore, pickRest, moveView, pickKept, renameView, resetLayout, restoreKept, saveToView, teamFromFavourites, teamScoped, meViewTab, NO_VIEW_FILTERS, currentSprintOf, sprintMoveAsk, tabCounts, viewJql, viewTabs, DEFAULT_VIEWS } from "./viewsModel.ts";
import { JqlBuilder } from "./JqlBuilder.tsx";
import { JiraSprintStrip } from "./JiraSprintStrip.tsx";
import { JiraStrip } from "./JiraStrip.tsx";
import { JiraToolbar } from "./JiraToolbar.tsx";
import { JiraTopBar } from "./JiraTopBar.tsx";
import { OUTLINES } from "./toolbarModel.ts";
import { Ctl } from "./ListControls.tsx";
import { changedSay, drawnIds, onlyCards } from "../../../lib/jiraChanged.ts";
import { cardSeen, useChangedIds } from "../../../lib/jiraChangedStore.ts";
import { saveFavourite, useJiraFavourites, useSyncFavourites } from "../../../lib/jiraFavourites.ts";
import { isAreaScope, lookedModel, NO_FILTERS, RUNNING_SPRINTS, startFilters, type JiraListFilters } from "./model.ts";
import { useJiraMenus } from "./menus/JiraMenuHost.tsx";
import { setWidth, updatePrefs, usePrefs, widthOf, withPrefs } from "./menus/viewPrefs.ts";

const MODE_KEY = "agentglass.jira.boardMode";
const DENSITY_KEY = "agentglass.jira.boardDensity";
function stored<T extends string>(key: string, ok: readonly T[], dflt: T): T {
  try { const v = localStorage.getItem(key); return ok.includes(v as T) ? (v as T) : dflt; } catch { return dflt; }
}
function keep(key: string, v: string): void { try { localStorage.setItem(key, v); } catch { /* private mode */ } }
const LANES_KEY = "agentglass.jira.boardLanes";

export function JiraListView({ source, viewId, areaId, onSelect, writable, onAllow, feed, reload, onViewsChanged, active, looked, show, rail }: BoardMainProps) {
  /* How the cards are laid out is about the person, not the board: one choice for every view, kept on this machine. */
  const [mode, setModeState] = useState<BoardMode>(() => stored(MODE_KEY, ["list", "board"], "list"));
  const [density, setDensityState] = useState<BoardDensity>(() => stored(DENSITY_KEY, ["comfortable", "compact"], "comfortable"));
  const setMode = useCallback((m: BoardMode) => { setModeState(m); keep(MODE_KEY, m); }, []);
  const setDensity = useCallback((d: BoardDensity) => { setDensityState(d); keep(DENSITY_KEY, d); }, []);
  const [lanes, setLanesState] = useState<BoardLanes>(() => stored(LANES_KEY, ["none", "epic", "assignee", "priority", "agent"], "none"));
  const setLanes = useCallback((l: BoardLanes) => { setLanesState(l); keep(LANES_KEY, l); }, []);
  const [sync] = useSyncFavourites();
  const favourites = useJiraFavourites(!!active && sync);
  /* What narrows the list belongs to the board it was set on: kept per view for this visit, never carried over. */
  const { byView, filterKey, filters, onFilters, layout, setLayout, named, activeTab, setActiveTab, applyFilters, pickTab } = useJiraFilterState({ viewId, areaId, onSelect, favourites });
  /* The mockup opens By epic: a view that has epics (or spans projects) starts there until the person picks otherwise. */
  const outlined = useRef<Set<string>>(new Set());

  /* Live worker: the keys the fleet's live agents name, read from the store App publishes; only threaded in while it is on. */
  const agents = useSyncExternalStore(onFleet, fleetNow, fleetNow);
  const live = useMemo(() => liveKeys(agents), [agents]);
  const needs = useMemo(() => (filters.needsOnly ? agents.filter((a) => a.status === "waiting").flatMap(cardKeysOf) : []), [filters.needsOnly, agents]);
  /* The boards' next sprints (earliest future of each board in view) are known only after the cards are: held in state and fed back into the filters, so "Next sprint" picks the same sprint the card menu offers. */
  const [nextSprints, setNextSprints] = useState<readonly string[] | undefined>(undefined);
  const withLive = useMemo(() => ({ ...(filters.liveOnly || filters.needsOnly ? { ...filters, live, needs } : filters), ...(nextSprints?.length ? { nextSprints } : {}) }), [filters, live, needs, nextSprints]);
  const model = useJiraList({ source, viewId, areaId, filters: withLive, reload, active, feed, writable });
  const sprintKeys = useMemo(() => [...new Set(model.cards.map((t) => (keyOf(t).split("-")[0] ?? "").toUpperCase()).filter(Boolean))].sort().slice(0, 4), [model.cards]);
  const boardCtxs = useBoardsInView(sprintKeys, model.context, !!active && model.cards.length > 0);
  const sprintBoards = useMemo(() => boardCtxs.map(boardOf), [boardCtxs]);
  useEffect(() => { const n = boardNextNames(sprintBoards); setNextSprints((p) => (p?.join("\0") === n.join("\0") ? p : n.length ? n : undefined)); }, [sprintBoards]);
  /* What moved since this board and its cards were last looked at: from the cards already loaded, nothing asked. */
  const changedIds = useChangedIds(model.cards, keyOf, !!active);
  const [changedOnly, setChangedOnly] = useState(false);
  /* Cards on this board whose agent waits on you: the toolbar offers them as one click, the Needs you toggle. */
  const waitingHere = useMemo(() => {
    const keys = new Set(agents.filter((a) => a.status === "waiting").flatMap(cardKeysOf));
    return keys.size ? model.cards.filter((t) => keys.has(keyOf(t).toUpperCase())).length : 0;
  }, [agents, model.cards]);
  /* With nobody waiting, a stalled or errored agent is the next thing worth a look. */
  const stuckHere = useMemo(() => {
    const keys = new Set(agents.filter((a) => a.status === "stalled" || a.status === "errored").flatMap(cardKeysOf));
    return keys.size ? model.cards.filter((t) => keys.has(keyOf(t).toUpperCase())).length : 0;
  }, [agents, model.cards]);
  /* With nobody waiting or stuck, the quieter number: cards an agent is working on now. One counter at a time, so the toolbar holds still. */
  const workingHere = useMemo(() => {
    const keys = new Set(agents.filter((a) => a.status === "working").flatMap(cardKeysOf));
    return keys.size ? model.cards.filter((t) => keys.has(keyOf(t).toUpperCase())).length : 0;
  }, [agents, model.cards]);
  /* The toolbar's people chip: every member the project will accept a card for, 0-card ones included. */
  const project = useMemo(() => { const ks = new Set(model.cards.map(projectOf).filter(Boolean)); return ks.size === 1 ? [...ks][0]! : null; }, [model.cards]);
  const { team: cardTeam, everyone } = useJiraTeam(model.cards, project, !!active);
  /* What card is open, as a history of keys so Back (Alt+Left, the panel's own control) can return to the one
     before — a subtask's parent and a parent's subtask, opened in place, are each a step rather than a jump. */
  const [hist, setHist] = useState<CardHistory>(() => startHistory(""));
  const selectedId = here(hist) || null;
  const [note, setNote] = useState<FooterNote | null>(null);
  /* Cards picked for a bulk action (x, or the row's own checkbox): forgotten when the view changes. */
  const [picked, setPicked] = useState(EMPTY_SELECTION);
  useEffect(() => { setPicked(EMPTY_SELECTION); }, [filterKey]);
  const togglePick = useCallback((id: string) => setPicked((s) => toggleSelected(s, id)), []);
  const pickedCards = useMemo(() => model.cards.filter((t) => picked.has(t.id)), [model.cards, picked]);
  const copyPickedKeys = useCallback(() => {
    const text = pickedCards.map(keyOf).join(", ");
    const said = (ok: boolean) => setNote({ ok, text: ok ? `Copied the ${pickedCards.length} ${pickedCards.length === 1 ? "key" : "keys"}` : "Could not copy" });
    const w = navigator.clipboard?.writeText(text);
    if (!w) { said(false); return; }
    void w.then(() => said(true), () => said(false));
  }, [pickedCards]);
  const moveToSprint = useCallback(() => {
    const ask = sprintMoveAsk(currentSprintOf(model.sprint, model.cards), pickedCards.map(keyOf));
    if (!ask.ok) { setNote({ ok: false, text: ask.error }); return; }
    setNote({ ok: true, text: "moving…" });
    /* The board is read back after a move Jira took, or the moved cards keep showing their old sprint until the next refresh. */
    void source.moveToSprint?.(ask.id, ask.keys).then((r) => { setNote({ ok: r.ok, text: r.ok ? ask.said : r.error ?? "Jira did not accept the move" }); if (r.ok) model.refresh(); }, () => setNote({ ok: false, text: "Could not reach the server" }));
  }, [model, pickedCards, source]);
  const openPickedJql = useCallback(() => { const url = jqlUrl(pickedCards); if (url) openExternal(url); }, [pickedCards]);
  /* menus: a sub-task or a parent may not be on the page, so the card opened from a menu (or from a chevron, or a
     breadcrumb) is kept here, by id, so Back can still find it once the page has moved on. */
  const [extra, setExtra] = useState<Record<string, ProviderTask>>({});
  const card = (selectedId && (model.cards.find((t) => t.id === selectedId) ?? looked?.cards.find((t) => t.id === selectedId) ?? extra[selectedId] ?? null)) || null;
  const openCard = useCallback((t: ProviderTask) => {
    cardSeen(t, keyOf(t));
    setHist((h) => visitHist(h, t.id));
    setExtra((m) => (m[t.id] ? m : { ...m, [t.id]: t }));
  }, []);
  // A card the search found that is on no lane is kept in the sidebar's Looked up, as the panel's own search does.
  const openFound = useCallback((t: ProviderTask) => { if (!model.cards.some((c) => c.id === t.id)) looked?.add(t); openCard(t); }, [model.cards, looked, openCard]);
  /* A row that only has an id (the list's own rows, the board's): find the card already on the page before asking
     anything of Jira. */
  const openId = useCallback((id: string) => {
    const t = model.cards.find((c) => c.id === id) ?? looked?.cards.find((c) => c.id === id) ?? extra[id] ?? null;
    if (t) openCard(t); else setHist((h) => visitHist(h, id));
  }, [model.cards, looked, extra, openCard]);
  /* A field that only names the card by its key (a sub-task's "Parent", the breadcrumb above the title): open it
     from the page if it is already here, else read it on its own, same as a chevron's children — never through
     the cross-view jump, so the list under it never turns into Looked up for this. */
  const openByKey = useCallback((key: string) => {
    const lower = key.toLowerCase();
    const found = model.cards.find((t) => (t.customId ?? t.id).toLowerCase() === lower)
      ?? looked?.cards.find((t) => (t.customId ?? t.id).toLowerCase() === lower)
      ?? Object.values(extra).find((t) => (t.customId ?? t.id).toLowerCase() === lower) ?? null;
    if (found) { openCard(found); return; }
    void findCardByKey(source, key).then((t) => { if (t) openCard(t); });
  }, [model.cards, looked, extra, openCard, source]);
  const back = useCallback(() => setHist((h) => backHist(h)), []);
  /* The space and the epic in the open card's header: the main view moves, the card stays. A space is the sidebar's own
     SPACES entry (the tree's scope id); an epic is what the jump palette runs, so both read as already known. */
  const openSpace = useCallback((space: string) => { const id = scopeIdOf({ kind: "space", space }); if (id) onSelect?.({ viewId: id }); }, [onSelect]);
  /* An epic opens its own page, the sidebar epic row's scope, never the open view narrowed to it: from "Assigned to me" a click
     on the epic means "everything in this epic", not "mine in this epic". Its space is the key's project prefix. */
  const openEpic = useCallback((epic: string) => {
    const space = epic.split("-")[0] ?? "";
    const id = space ? scopeIdOf({ kind: "epic", space, epic } as Parameters<typeof scopeIdOf>[0]) : null;
    if (id) { onSelect?.({ viewId: id }); return; }
    const jql = "parent = " + epic; onFilters({ query: jql }); askFullJql(jql);
  }, [onSelect, onFilters]);
  /* The body asks for a card (the pull-request panel's "show me this card", a find): open it once it is on the page or in Looked up. */
  const [asked, setAsked] = useState<number>(show?.n ?? 0);
  const want = show && show.n !== asked ? show : null;
  const wanted = want ? (model.cards.find((t) => t.id === want.id) ?? looked?.cards.find((t) => t.id === want.id) ?? null) : null;
  useEffect(() => { if (want && wanted) { setAsked(want.n); openCard(wanted); } }, [want?.n, wanted, openCard]); // eslint-disable-line react-hooks/exhaustive-deps
  /* The saved views behind the tabs and the saved searches behind the star, the palette and the bus. */
  const saved = useJiraSavedViews(source, !!active, onViewsChanged);
  const favViews = useMemo(() => favourites.filter((f) => !saved.views.some((v) => v.id === `filter:${f.id}`)).map((f) => ({ id: `filter:${f.id}`, name: f.name, url: "", addedAt: 0 })), [favourites, saved.views]);
  /* Names and searches that hold an account id read as the person; the id itself never reaches a label. */
  const tidy = usePersonNames(useMemo(() => saved.views.map((v) => `${v.name} ${jqlOf(v) ?? ""}`), [saved.views]), useMemo(() => model.cards.flatMap((c) => c.people ?? []), [model.cards]));
  /* The Assignee list outlives the people picked: see rosterOf. One roster per view and tab. */
  const rosterRef = useRef<{ scope: string; list: TeamMember[] }>({ scope: "", list: [] });
  const team = useMemo(() => {
    const scope = `${filterKey}|${activeTab ?? ""}`;
    const prev = rosterRef.current.scope === scope ? rosterRef.current.list : [];
    const list = rosterOf(prev, everyone ?? cardTeam);
    rosterRef.current = { scope, list };
    return list;
  }, [filterKey, activeTab, everyone, cardTeam]);
  useEffect(() => { setNamedTabCount(named.length); }, [named.length]);
  const ordered = useMemo(() => orderTabs(named, [...saved.views, ...favViews].map((v) => ({ ...v, name: tidy(v.name) }))), [named, saved.views, favViews, tidy]);
  const tabViews = ordered.list;
  const epicNames = useMemo(() => epicNamesOf(model.cards), [model.cards]);
  /* The view's JQL, clicked into the box: where it came from, so Cancel puts it back. */
  const [editFrom, setEditFrom] = useState<string | null>(null);
  useEffect(() => { setEditFrom(null); }, [filterKey, activeTab]);
  const editJql = useCallback(() => { setEditFrom(filters.viewJql ?? ""); onFilters(loadChip(filters)); }, [filters, onFilters]);
  const cancelEdit = useCallback(() => { onFilters({ query: "", viewJql: editFrom || null }); setEditFrom(null); }, [editFrom, onFilters]);
  const saveToViewNow = useCallback(() => {
    const spec = DEFAULT_VIEWS.find((v) => v.id === activeTab);
    const jql = filters.query.trim();
    if (!spec || !looksJql(jql)) return;
    setLayout((l) => saveToView(l, spec.id, jql, viewJql(spec, l.filters[spec.id])));
    onFilters({ query: "", viewJql: jql });
    askFullJql(jql);
    setNote({ ok: true, text: `Saved the search to ${spec.name}` });
    setEditFrom(null);
  }, [activeTab, filters.query, onFilters, setLayout]);
  /* Duplicate a default view: its search, as a saved view of its own. */
  const duplicateView = useCallback((id: string) => {
    const t = named.find((x) => x.id === id);
    if (!t?.jql) return;
    void saved.save(t.jql, `${t.name} copy`).then((r) => setNote({ ok: r.ok, text: r.ok ? `Duplicated ${t.name}` : r.error ?? "Could not duplicate this view" }));
  }, [named, saved]);
  const currentView = model.view?.id ?? viewId;
  /* A count is the cards the tab shows on THIS board, so only the tab on screen has one: another tab's number would be the site's, not the board's. */
  const counts = useMemo(() => (model.phase === "loading" ? {} : tabCounts(activeTab ?? (!areaId && currentView === model.view?.id ? currentView : null), model.counts.shown, model.truncated)),
    [activeTab, currentView, areaId, model.phase, model.view?.id, model.counts.shown, model.truncated]);
  useEffect(() => onJiraSearch((q) => onFilters({ query: q })), [onFilters]);
  useEffect(() => { reportJiraSearch(filters.query); }, [filters.query]);
  /* Only while this view is on screen: a hidden board neither fills the palette nor takes Ctrl+K from a terminal. */
  useEffect(() => {
    if (!active) return;
    setJiraViewActive(true);
    publishJiraQueries(saved.queries.map((q) => ({ id: q.id, name: q.name, jql: q.jql })));
    return () => { setJiraViewActive(false); publishJiraQueries([]); };
  }, [saved.queries, active]);
  useEffect(() => {
    if (model.phase === "loading" || byView[filterKey] || outlined.current.has(filterKey)) return;
    outlined.current.add(filterKey);
    if (model.epics.length > 0 || model.assigned) onFilters(OUTLINES[1]!.pick);
  }, [model.phase, model.epics.length, model.assigned, filterKey, byView, onFilters]);
  const typedJql = filters.query.trim();
  /* The view builder, open with the search it starts from: the box's JQL, else the view's own, else nothing. */
  const [builder, setBuilder] = useState<{ jql: string; edit?: SavedQuery } | null>(null);
  const openBuilder = useCallback(() => setBuilder({ jql: looksJql(typedJql) ? typedJql : filters.viewJql ?? "" }), [typedJql, filters.viewJql]);
  const menus = useJiraMenus({ model, source, viewId, writable, selected: card, onOpen: openCard, onNote: setNote });
  const prefs = usePrefs(viewId);
  const forget = useCallback((t: ProviderTask) => { looked?.forget(t.id); if (selectedId === t.id) setHist((h) => visitHist(h, "")); }, [looked, selectedId]);
  const lookedOn = !!looked?.on && looked.cards.length > 0;
  /* Changed cards the board really draws: the lanes hold only what the view's filters and display prefs keep, and `model.cards` holds every loaded card. */
  const drawn = useMemo(() => drawnIds(withPrefs(model, prefs).lanes), [model, prefs]);
  const changedDrawn = useMemo(() => new Set([...changedIds].filter((id) => drawn.has(id))), [changedIds, drawn]);
  useEffect(() => { if (changedOnly && changedDrawn.size === 0) setChangedOnly(false); }, [changedOnly, changedDrawn]);
  const shown = useMemo(() => (lookedOn ? lookedModel(model, looked!.cards) : changedOnly ? onlyCards(withPrefs(model, prefs), (id) => changedDrawn.has(id)) : withPrefs(model, prefs)), [model, prefs, lookedOn, looked, changedOnly, changedDrawn]);
  /* end menus */

  const editing = editFrom !== null && typedJql !== "";
  const editSpec = DEFAULT_VIEWS.find((v) => v.id === activeTab);
  const count = countLine(shown.counts.shown, model.counts.total, model.truncated);
  const say = useMemo(() => changedSay(!lookedOn && changedOnly, changedIds.size, changedDrawn.size), [lookedOn, changedOnly, changedIds, changedDrawn]);

  /* The `?` legend, over the board: closes on Esc, on a click outside, or `?` again. */
  const [legend, setLegend] = useState(false);
  /* Shift+F opens Filters: a count the menu watches, so a second press after it closed opens it again. */
  const [filtersAsk, setFiltersAsk] = useState(0);

  /* b, d, a, [, x, ? and Escape while the pane is in front and nothing is being typed. */
  useEffect(() => {
    if (!active) return;
    const on = (e: KeyboardEvent) => {
      const typing = typingInto(document.activeElement as HTMLElement | null) || e.defaultPrevented;
      if (e.key === "Escape" && legend) { e.preventDefault(); setLegend(false); return; }
      if (!typing && mode === "list" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "x") {
          const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-jl-row]");
          const id = row?.dataset.jlRow ?? selectedId;
          if (id) { e.preventDefault(); togglePick(id); return; }
        }
        if (e.key === "Escape" && picked.size > 0) { e.preventDefault(); setPicked(EMPTY_SELECTION); return; }
      }
      const k = boardKey(e, typing);
      if (!k) return;
      e.preventDefault();
      if (k === "mode") setMode(mode === "board" ? "list" : "board");
      else if (k === "density") setDensity(density === "compact" ? "comfortable" : "compact");
      else if (k === "search") openJiraJump();
      else if (k === "legend") setLegend((v) => !v);
      else if (k === "view") openBuilder();
      else if (k === "filters") setFiltersAsk((n) => n + 1);
      else if (k === "needs") onFilters({ needsOnly: !filters.needsOnly });
      else if (k === "agents") {
        if (mode === "board") setLanes(lanes === "agent" ? "none" : "agent");
        else onFilters(filters.group === "agent" ? { group: "status", thenGroup: "none" } : { group: "agent", thenGroup: "none" });
      }
      else rail?.onToggle();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [active, mode, density, setMode, setDensity, rail, selectedId, togglePick, picked.size, legend, openBuilder, lanes, setLanes, filters.group, filters.needsOnly, onFilters]);

  /* The sidebar folds to its rail only when, docked, it would leave the board under two columns. */
  const [boardW, setBoardW] = useState(0);
  const fold = mode === "board" && !!rail && boardW > 0
    && railFolds({ boardWidth: boardW, sidebarWidth: rail.width, railFolded: rail.folded, density, pinned: rail.pinned });
  useEffect(() => { rail?.onAuto(fold); }, [fold]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the view (List, another tab) gives the sidebar back; otherwise it stays folded for a board no longer shown.
  const railRef = useRef(rail);
  railRef.current = rail;
  useEffect(() => () => railRef.current?.onAuto(false), []);

  /* The dock takes what is left after three columns (tabsModel.dockWidth), so the board keeps them with a card open. */
  const root = useRef<HTMLDivElement>(null);
  const [rowW, setRowW] = useState(0);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    setRowW(el.clientWidth);
    const ro = new ResizeObserver(() => setRowW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={root} data-testid="jira-list" data-dens={density} className="relative flex flex-1 min-h-0 min-w-0">
      <div className="agx-jcq relative flex flex-col flex-1 min-w-0 min-h-0" style={{ gap: 12 }}>
        <JiraToolbar model={model} onRefresh={model.refresh} areaId={areaId} title={named.find((t) => t.id === activeTab)?.name} />
        <div className="agx-jacc">
          {/* Identity row (the mockup's row 1): sprint chip, view tabs, Save view / More views, then Workflow and
              how fresh the read is - one row, not two, so JiraTopBar's two halves sit inside JiraTabs's own flex
              row around its single flex-1 spacer instead of stacking its own full-width bar above this one. */}
          <JiraTabs views={tabViews} max={ordered.shown} current={activeTab ?? currentView} counts={counts} ctl={saved}
            canSave edit={{ onMove: (id, before) => setLayout((l) => moveView(l, id, before)), onRename: (id, name) => setLayout((l) => renameView(l, id, name)), onDuplicate: duplicateView, onHide: (id) => { setLayout((l) => hideView(l, id)); if (activeTab === id) { setActiveTab(null); onFilters({ viewJql: null }); } setNote({ ok: true, text: `Deleted ${named.find((x) => x.id === id)?.name ?? "the view"}`, go: { label: "Undo", run: () => { setLayout((l) => showView(l, id)); setNote(null); } } }); }, onReset: () => setLayout(resetLayout) }}
            onPick={(id) => { if (id.startsWith(TAB_PREFIX)) { pickTab(id); return; } if (activeTab) onFilters(leaveTab(filters.spaces)); setActiveTab(null); if (favViews.some((f) => f.id === id)) void saveFavourite(id).then(() => onSelect?.({ viewId: id })); else onSelect?.({ viewId: id }); }} onSaveCurrent={openBuilder} onEditQuery={(q) => setBuilder({ jql: q.jql, edit: q })}
            onNote={(text) => setNote({ ok: true, text })}
            left={<JiraTopBar model={model} areaId={areaId} side="left" />}
            right={<JiraTopBar model={model} areaId={areaId} side="right" />} />
        </div>
        <JiraSprintStrip model={model} on={filters.sprintOnly === RUNNING_SPRINTS || !!filters.sprintPick?.includes("@current") || !!DEFAULT_VIEWS.find((v) => v.id === activeTab)?.sprint} />
        <div data-slot="finding" className="flex flex-col shrink-0" style={{ gap: 6, padding: "0 24px" }}>
          {/* Finding row (the mockup's row 2): search, Filters, Display, and the count at the right. While a view's JQL is being
              edited in the box, Save to view / Cancel stand where Filters and Display were. */}
          <div className="flex items-start min-w-0" style={{ gap: 6 }}>
            {/* Search, then the applied chips (they wrap among themselves, never push a control), then the fixed controls. */}
            <div className="flex" style={{ flex: "0 1 380px", minWidth: 220 }}>
              <JiraSearch filters={filters} onFilters={onFilters} model={model} source={source} onOpenCard={openFound} />
            </div>
            {!editing && <ActiveFilters filters={filters} boardName={model.view?.name} quickNames={Object.fromEntries((model.context?.filters ?? []).map((q) => [q.id, q.name]))} epicNames={epicNames} onFilters={applyFilters} onEditJql={editJql} />}
                <span className="flex-1" />
            {editing ? (
              <>
                {editSpec && <Ctl tone="primary" disabled={!looksJql(typedJql)} onClick={saveToViewNow} tip="Keep the search in the box as this view's own search">Save to view</Ctl>}
                <Ctl onClick={cancelEdit}>Cancel</Ctl>
              </>
            ) : (
              <>
                {waitingHere > 0 && !filters.needsOnly && (
                  <Ctl onClick={() => onFilters({ needsOnly: true })} tip={{ name: `${waitingHere} ${waitingHere === 1 ? "card's agent waits" : "cards' agents wait"} on you`, text: "Show only those cards. n does the same; n again shows every card." }}>
                    <span style={{ color: "var(--warning-ink)", fontWeight: 600 }}>{waitingHere} need{waitingHere === 1 ? "s" : ""} you</span>
                  </Ctl>
                )}
                {waitingHere === 0 && stuckHere > 0 && !filters.liveOnly && (
                  <Ctl onClick={() => onFilters({ liveOnly: true })} tip={{ name: `${stuckHere} ${stuckHere === 1 ? "card's agent has" : "cards' agents have"} stalled or errored`, text: "Show only cards with a live agent; the stuck ones sort first under the Agent sort." }}>
                    <span style={{ color: "var(--error-ink)", fontWeight: 600 }}>{stuckHere} stuck</span>
                  </Ctl>
                )}
                {waitingHere === 0 && stuckHere === 0 && workingHere > 0 && !filters.liveOnly && (
                  <Ctl onClick={() => onFilters({ liveOnly: true })} tip={{ name: `${workingHere} ${workingHere === 1 ? "card has" : "cards have"} an agent working`, text: "Show only cards with a live agent." }}>
                    <span style={{ color: "var(--text3)" }}>{workingHere} working</span>
                  </Ctl>
                )}
                {changedDrawn.size > 0 && !lookedOn && (
                  <Ctl pressed={changedOnly} onClick={() => setChangedOnly((v) => !v)} tip={{ name: say.chip, text: changedOnly ? "Show every card again." : "Show only the cards with new comments, moves or assignments since you last looked." }}>
                    <span data-testid="jira-changed-chip" style={{ color: "var(--accent, var(--primary))" }}>{say.chip}</span>
                  </Ctl>
                )}
                <Ctl onClick={openBuilder} tip={{ name: "Build a view", text: "Write a Jira search with recipes, suggestions and a live count, and keep it as a tab." }}>JQL</Ctl>
                <JiraFiltersMenu openAsk={filtersAsk} filters={withLive} shownNow={model.counts.shown} boards={sprintBoards} onFilters={applyFilters} cards={model.cards} statuses={model.statuses} tags={model.tags} team={team}
                  saved={layout.saved} onSave={(nm) => setLayout((l) => savePreset(l, nm, filters, filterCount(filters) > 0))} onForget={(nm) => setLayout((l) => removePreset(l, nm))} />
                <JiraDisplayMenu mode={mode} onMode={setMode} density={density} onDensity={setDensity} lanes={lanes} onLanes={setLanes} filters={filters} onFilters={onFilters}
                  hasAreas={model.epics.length > 0 || !!model.assigned} assigned={!!model.assigned}
                  scope={areaId && !areaId.startsWith("@") && model.sprint ? { sprint: model.sprint.name, total: model.counts.total } : undefined} />
              </>
            )}
          </div>
          {editing && <div className="text-[11px]" role="status" style={{ color: "var(--text3)", height: 22, lineHeight: "22px" }}>{editCaption(editSpec?.name ?? "this view", shown.counts.shown, model.counts.total)}</div>}
        </div>
        {say.note && <div className="text-[11px]" role="status" data-testid="jira-changed-note" style={{ color: "var(--text3)", height: 22, lineHeight: "22px" }}>{say.note}</div>}
        <JiraStrip model={model} onRefresh={model.refresh} />
        {builder !== null && (
          <JqlBuilder key={builder.edit?.id ?? "new"} initial={builder.jql} initialName={builder.edit?.name ?? ""} editing={!!builder.edit} suggestName={(q) => nameForQueryWith(q, nameForQuery)} onClose={() => setBuilder(null)}
            onTry={(q) => { onFilters({ query: q }); askFullJql(q); }}
            onSave={async (q, name) => {
              const ed = builder.edit;
              const r = ed ? await saved.edit(ed.id, { jql: q, ...(name !== ed.name ? { name } : {}) }) : await saved.save(q, name);
              if (r.ok) { setNote({ ok: true, text: ed ? `Updated “${name}”` : `Saved “${name}” as a view` }); }
              return r;
            }} />
        )}
        {mode === "board" && listState({ phase: shown.phase, error: shown.error, shown: shown.counts.shown, areaId }) === "lanes" ? (
          <JiraBoard viewId={viewId ?? undefined} model={shown} density={density} lanes={lanes} selectedId={selectedId} onOpen={openId} onOpenByKey={openByKey} onRowMenu={menus.handlers.onRowMenu} onStatusMenu={menus.handlers.onStatusMenu} onAssignMenu={menus.handlers.onAssignMenu} onWidth={setBoardW} writable={writable} onNote={setNote} onClearFilter={filtering(filters) ? () => onFilters(CLEARED) : undefined} />
        ) : <JiraLanes model={shown} writable={writable} viewId={viewId} areaId={areaId} filters={filters} onFilters={onFilters} selectedId={selectedId} onOpen={openId} onOpenCard={openCard} onForget={lookedOn ? forget : undefined} picked={picked} onPick={togglePick} {...menus.handlers} />}
        <JiraFooter model={model} countText={countText(count, say.count)} title={named.find((t) => t.id === activeTab)?.name} note={note} onCloseNote={() => setNote(null)} />
        <JiraKeyBar mode={mode} onLegend={() => setLegend((v) => !v)} />
        {mode === "list" && <BulkBar count={picked.size} onCopyKeys={copyPickedKeys} onOpenJql={jqlUrl(pickedCards) ? openPickedJql : null} onClear={() => setPicked(EMPTY_SELECTION)} onSprint={null} extra={<BulkActions picked={pickedCards} board={viewId ?? ""} context={model.context} epics={model.epics} writable={!!writable} onDone={model.refresh} />} />}
      </div>
      <JiraDock width={widthOf(prefs) != null ? clampDockResize(widthOf(prefs)!, rowW) : dockWidth(rowW, density)} rowW={rowW}
        onResizeWidth={(px) => { if (viewId) updatePrefs(viewId, (p) => setWidth(p, px)); }}
        onResetWidth={() => { if (viewId) updatePrefs(viewId, (p) => setWidth(p, null)); }}
        source={source} card={card} writable={writable} onTask={model.wrote} onClose={() => setHist((h) => visitHist(h, ""))}
        onOpenCard={openCard} onOpenByKey={openByKey} onOpenSpace={openSpace} onOpenEpic={openEpic} onBack={canBack(hist) ? back : undefined} onAllow={onAllow} {...menus.handlers} />
      {menus.host}
      <JiraJump source={source} cards={model.cards} epics={model.epics} queries={saved.queries} tidy={tidy} active={!!active} onOpenCard={openFound}
        onRunJql={(jql) => { onFilters({ query: jql }); askFullJql(jql); }} onOpenPlace={(id) => onSelect?.({ viewId: id })} />
      {legend && <KeyLegend mode={mode} onClose={() => setLegend(false)} />}
    </div>
  );
}
