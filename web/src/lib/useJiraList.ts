/*
 * The one place the Jira list pane reads from. Every request the pane makes for
 * its list goes through this file (`source.read`, `boardContext`, `boardAreas`);
 * the slots under components/jira/list/ take the model it returns and nothing
 * else, so swapping where the list comes from (the epic-cards route, when it
 * lands) is a change to this file alone. A test pins that.
 *
 * It keeps the protocol the board body had, request for request:
 *  - the first read of a view paints what the machine kept, then reads live
 *    (jiraBoard.read), and a read that says `revalidating` is followed by the
 *    same settle loop (1.5 s, 30 tries) until the live answer lands;
 *  - the read of a view is asked once per visit; the window re-reads on focus
 *    only when the rows are a minute old (boardDue). No timer;
 *  - a board's context and its areas are asked once per board visit;
 *  - a slow answer for a board you left never wins (a ticket per read).
 * What it reads is handed back to the body through `feed`, so the rail draws
 * from the same answer instead of asking a second time.
 */
import { jqlScope } from "../components/jira/list/viewsModel.ts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { agentStateOf, fleetNow, onFleet } from "./jiraCardWork.ts";
import type { BoardSource, MainFeed, MainReload } from "./boardSource.ts";
import { BOARD_POLL_MS, boardDue } from "./boardPoll.ts";
import { readState } from "./boardStaleness.ts";
import { readOrder, writeOrder } from "./workflowOrder.ts";
import type { JiraBoardAreas, JiraBoardContext, ListStatus, ProviderTask, ViewTasksResponse } from "../../../shared/providers.ts";
import {
  effectiveJql, filterCards, foldSite, newerThanBoard, siteAsk, laneCounts, overAfterRead, pageCards, readIsCapped, walkWanted, countBasis, boardIsCut, withSiteCards, type JiraListFilters, type JiraListModel, type JiraListPhase,
} from "../components/jira/list/model.ts";
import { sprintNarrow } from "../components/jira/list/sprintModel.ts";
import { awaitingTabRead, buildLanes, keyOf } from "../components/jira/list/laneModel.ts";
import { onFullJql } from "./jqlFull.ts";
import { JQL_REST_MS, looksJql } from "../components/jira/list/boardModel.ts";
import { api } from "./api.ts";
import { SPRINTS } from "../components/jira/JiraAreas.tsx";
import { ASSIGNED_VIEW_ID } from "../../../shared/providers.ts";

export interface UseJiraListInput {
  source: BoardSource;
  /** The view to show; null asks for the one the server held last. */
  viewId: string | null;
  /** The open epic, the sprint (`@sprints`) or null. */
  areaId: string | null;
  filters: JiraListFilters;
  /** Bumped by the body to ask for a read again. */
  reload?: MainReload;
  /** A hidden tab does not re-read on focus. */
  active?: boolean;
  feed?: MainFeed;
  /** Whether this app may change the tracker: ranking by a drop needs it. */
  writable?: boolean;
}

type AreasState = { state: "loading" | "ready" | "error"; read: JiraBoardAreas | null };

const NO_RELOAD: MainReload = { n: 0, force: false };
/**
 * A view's statuses: the server's workflow answer, in the board's order, as is. No answer
 * and no cards: no columns, the loading state shows. No answer (empty or failed) but cards on screen: grouped by status,
 * an empty column list drew no card at all, so the columns are the statuses the cards wear — in the stored order where
 * it has them, first-seen after that. Never the stored order alone: it may hold a status nobody wears any more (an
 * Epic-only "WORK IN PROGRESS").
 */
export function columnStatuses(view: string, answer: readonly ListStatus[] | undefined, cards: readonly Pick<ProviderTask, "status" | "statusKind" | "statusColor">[] = []): ListStatus[] {
  const stored = view ? readOrder(view) : null;
  if (answer?.length) return [...answer];
  const worn = new Map<string, (typeof cards)[number]>();
  for (const t of cards) if (t.status && !worn.has(t.status.toLowerCase())) worn.set(t.status.toLowerCase(), t);
  const rank = new Map((stored ?? []).map((n, i) => [n.toLowerCase(), i]));
  const keys = [...worn.keys()];
  const at = (k: string) => rank.get(k) ?? stored!.length + keys.indexOf(k);
  return keys.sort((a, b) => (stored ? at(a) - at(b) : 0)).map((k, orderindex) => {
    const t = worn.get(k)!;
    return { status: t.status, type: t.statusKind === "done" ? "done" : t.statusKind === "open" ? "open" : "custom", orderindex, ...(t.statusColor ? { color: t.statusColor } : {}) };
  });
}

/** How long a run of writes from the detail rests before the board is read again: one read for several quick moves. */
const WROTE_REST_MS = 800;

const NOTHING: ViewTasksResponse = { tasks: [], statuses: [], fields: [], at: 0 };

export function useJiraList(input: UseJiraListInput): JiraListModel {
  const { source, viewId, areaId, filters, reload = NO_RELOAD, active = true, feed, writable = false } = input;
  const [data, setData] = useState<ViewTasksResponse | null>(null);
  const [ctx, setCtx] = useState<JiraBoardContext | null>(null);
  const [areas, setAreas] = useState<AreasState>({ state: "loading", read: null });
  const [over, setOver] = useState<Record<string, ProviderTask>>({});
  /* Bumped by every forced read (Refresh, a write from the detail): the site's JQL answer is asked again, skipping its kept 30 s. */
  const [siteRound, setSiteRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const siteRef = useRef<{ tasks: ProviderTask[] } | null>(null);
  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const dataRef = useRef<ViewTasksResponse | null>(null);
  // Mine and the people chip ride to the server as two more quick-filter ids, so a board's search answers for them
  // exactly (the site's own count), instead of a filter run here over the page the board happened to read.
  const netQuick = useMemo(() => {
    const extra: string[] = [];
    if (filters.mineOnly) extra.push("mine");
    if (filters.assigneePick.length) extra.push(`people:${[...new Set(filters.assigneePick)].sort().join(",")}`);
    return extra.length ? [...filters.quick, ...extra] : filters.quick;
  }, [filters.quick, filters.mineOnly, filters.assigneePick]);
  const quickKey = netQuick.join(",");
  const quickRef = useRef<readonly string[]>(netQuick);
  quickRef.current = netQuick;

  /* Keep the order shown for this view, so the next boot paints it first. Only a real answer is kept, never a card-made list. */
  useEffect(() => {
    const id = data?.view?.id;
    if (id && data?.statuses?.length) writeOrder(id, data.statuses.map((x) => x.status));
  }, [data]);

  const asking = useRef(0);
  const settling = useRef(0);
  const ranking = useRef(new Set<string>());
  const land = (r: ViewTasksResponse) => { dataRef.current = r; setData(r); if (!r.revalidating) setOver((m) => overAfterRead(m, r.tasks, ranking.current)); setNow(Date.now()); feedRef.current?.read(r); };

  /* Waits for the live read behind a painted one; stands down when anything else is asked (`settling` is bumped). */
  const settle = useCallback(async (id: string, was: number) => {
    const run = ++settling.current;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      if (settling.current !== run) return;
      try {
        const r = await source.read(id, false, quickRef.current.length ? quickRef.current : undefined);
        if (settling.current !== run) return;
        if (r.at > was || !r.revalidating) { land(r); return; }
      } catch { return; }
    }
  }, [source]);

  const done = useRef<{ id: string; quick: string; reload: number } | null>(null);
  const run = useCallback(async (id: string | undefined, force: boolean) => {
    const ticket = ++asking.current;
    settling.current++;
    if (force) setSiteRound((n) => n + 1);
    setBusy(true);
    done.current = { id: id ?? "", quick: quickRef.current.join(","), reload: reload.n };
    try {
      const r = await source.read(id, force, id && quickRef.current.length ? quickRef.current : undefined);
      if (ticket !== asking.current) return;
      if (r.view?.id) done.current = { ...done.current, id: r.view.id };
      land(r);
      setSaid(null);
      if (r.revalidating && r.view?.id) void settle(r.view.id, r.at);
    } catch {
      if (ticket !== asking.current) return;
      // Keep the cards: a server that did not answer once has not moved anybody's work.
      land({ ...(dataRef.current ?? NOTHING), error: "Could not reach the server" });
    } finally {
      if (ticket === asking.current) setBusy(false);
    }
  }, [source, settle, reload.n]);

  /* A read when the view, the quick filters or the body's `reload` change. The view the last read named is the view asked
     for next, so the body handing it back as `viewId` does not read twice. */
  useEffect(() => {
    const d = done.current;
    if (d && d.id === (viewId ?? "") && d.quick === quickKey && d.reload === reload.n) return;
    void run(viewId ?? undefined, !!d && d.reload !== reload.n && reload.force);
  }, [viewId, quickKey, reload.n, run]);

  /* Coming back to the window re-reads cards a minute old. Nothing else asks on its own. */
  useEffect(() => {
    if (!active) return;
    const onFocus = () => {
      if (document.hidden || !document.hasFocus()) return;
      if (!boardDue(Date.now(), dataRef.current?.at)) return;
      void run(dataRef.current?.view?.id, false);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, run]);

  const boardViewId = data?.view?.id;
  useEffect(() => {
    setCtx(null); feedRef.current?.context(null);
    if (!source.boardContext || !boardViewId?.startsWith("board:")) return;
    let live = true;
    void source.boardContext(boardViewId).then((c) => { if (live) { setCtx(c); feedRef.current?.context(c); } }).catch(() => {});
    return () => { live = false; };
  }, [source, boardViewId]);
  useEffect(() => {
    const set = (a: AreasState) => { setAreas(a); feedRef.current?.areas(a); };
    set({ state: "loading", read: null });
    // Not a board (a saved filter, "assigned to me"): no areas, and "loading" would stay on for good.
    if (!source.boardAreas || !boardViewId?.startsWith("board:")) { set({ state: "ready", read: null }); return; }
    let live = true;
    void source.boardAreas(boardViewId)
      .then((r) => { if (live) set({ state: r.ok ? "ready" : "error", read: r }); })
      .catch(() => { if (live) set({ state: "error", read: null }); });
    return () => { live = false; };
  }, [source, boardViewId]);

  const fold = useCallback((t: ProviderTask) => setOver((m) => ({ ...m, [t.id]: t })), []);
  /* The detail's copy of a card: drawn at once. Newer than the board's own copy (a write, or a change read on the site), the
     board and its search are read again past every kept copy, so a card that left the view (another assignee, a done
     status) leaves it. The detail hands every read here too, and an unchanged card asks nothing. */
  const wroteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (wroteTimer.current) clearTimeout(wroteTimer.current); }, []);
  const wrote = useCallback((t: ProviderTask) => {
    fold(t);
    const had = dataRef.current?.tasks.find((x) => x.id === t.id) ?? siteRef.current?.tasks.find((x) => x.id === t.id);
    if (!newerThanBoard(t, had)) return;
    // Several moves in a row are one read of the board, not one each.
    if (wroteTimer.current) clearTimeout(wroteTimer.current);
    wroteTimer.current = setTimeout(() => { wroteTimer.current = null; void run(dataRef.current?.view?.id ?? viewIdRef.current ?? undefined, true); }, WROTE_REST_MS);
  }, [fold, run]);
  const dismissSaid = useCallback(() => setSaid(null), []);
  /* A drop on the board: the card sorts at its guessed place at once and goes back to where the read had it if the site refuses. */
  const rank = useCallback((moved: ProviderTask, key: string, ask: { before?: string; after?: string }, order: string | null) => {
    if (order) fold({ ...moved, order });
    ranking.current.add(moved.id);
    void source.rank!(key, ask).then((r) => {
      ranking.current.delete(moved.id);
      if (r.ok) return;
      fold(moved);
      setSaid({ text: `Could not rank ${key}: ${r.error ?? "the site refused"}` });
    }).catch(() => { ranking.current.delete(moved.id); fold(moved); setSaid({ text: `Could not rank ${key}: the site did not answer` }); });
  }, [source, fold]);

  /* JQL in the box is run on the site (GET /jira/jql, kept 30 s there) once typing rests: the first page only. Enter asks for
     every page (`full`). Until it answers, or if it fails, filterCards reads the clauses itself over the cards already here. */
  const typed = effectiveJql(filters);
  const fromView = !!filters.viewJql?.trim() && typed === filters.viewJql.trim();
  const [siteRead, setSite] = useState<{ q: string; at: string; keys: string[]; tasks: ProviderTask[]; ms: number; truncated?: boolean; total?: number; full: boolean; round: number } | null>(null);
  // Keyed like the site answer: an error read on one view is not this view's, even for the same text.
  const [queryError, setQueryError] = useState<{ q: string; at: string; text: string } | null>(null);
  const [fullFor, setFullFor] = useState<string | null>(null);
  useEffect(() => onFullJql((q) => setFullFor(q)), []);
  const wantFullEntered = fullFor === typed;
  // The site answers inside the open view and its quick filters; an answer read for another view is not this one's.
  const scopeView = viewId ?? data?.view?.id ?? null;
  // Current sprint and Hide done are asked of Jira inside the search, so its 1000-card cap cuts the filtered list.
  const narrow = useMemo(() => [...(sprintNarrow(filters.sprintOnly, filters.sprintPick) ? ["sprint"] : []), ...(!filters.showDone && !filters.statusPick.length ? ["notdone"] : [])], [filters.sprintOnly, filters.sprintPick, filters.showDone, filters.statusPick.length]);
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const scopeAt = `${scopeView ?? ""}|${quickKey}|${narrow.join("+")}${fromView && filters.viewCross ? "|x" : ""}`;
  const site = siteRead && siteRead.at === scopeAt ? siteRead : null;
  // A first page cut short with a filter on keeps loading, so the count is the site's and not the first page's.
  const wantFull = walkWanted(wantFullEntered, narrow.length > 0, site, typed);
  siteRef.current = site;
  useEffect(() => {
    if (!typed || (!fromView && !looksJql(typed))) { setSite(null); setQueryError(null); return; }
    // A Refresh since this answer was read asks again at once and past the server's kept copy; the old answer stays drawn until then (no blank).
    const { ask, fresh: again } = siteAsk(site, typed, wantFull, siteRound);
    if (!ask) return;
    const round = siteRound;
    const ac = new AbortController();
    const t = setTimeout(() => {
      const t0 = performance.now();
      void api.jiraJql(typed, ac.signal, wantFull, jqlScope(scopeView, { viewCross: fromView && filters.viewCross }, quickRef.current), narrowRef.current, again).then((r) => {
        if (r.ok && r.tasks) { setSite({ q: typed, at: scopeAt, keys: r.tasks.map(keyOf), tasks: r.tasks, ms: performance.now() - t0, truncated: !!r.truncated, full: wantFull, round, ...(typeof r.matching === "number" ? { total: r.matching } : {}) }); setQueryError(null); }
        // Jira's own parse error for the search typed: shown under the box, never dropped. The local reading (filterCards)
        // stays as the answer while it is wrong, same as any other failed site read.
        else if (r.error) setQueryError({ q: typed, at: scopeAt, text: r.error });
      }).catch(() => { /* the local reading stays */ });
    }, wantFull || again ? 0 : JQL_REST_MS);
    return () => { clearTimeout(t); ac.abort(); };
  }, [typed, site?.q, site?.full, site?.round, siteRound, wantFull, scopeAt]);

  /* The fleet is read only while the list is grouped by agent, so a session's every event does not rebuild other groupings. */
  const fleet = useSyncExternalStore(onFleet, fleetNow, fleetNow);
  const byAgent = filters.group === "agent" ? fleet : null;

  return useMemo(() => {
    const d = data ?? NOTHING;
    const read0 = pageCards({ tasks: d.tasks, areaId, areaTasks: areas.read?.ok ? areas.read.tasks : undefined, sprintName: ctx?.sprint?.name, over });
    // The site's cards wear the detail's writes too: a Mine view is the site's answer alone, and drew the old assignee.
    const cards = withSiteCards(read0, site && site.q === typed ? foldSite(site.tasks, over) : undefined, fromView && !!filters.viewCross);
    const shown = filterCards(cards, site ? { ...filters, site } : filters);
    const basis = countBasis(narrow.length > 0, boardIsCut(!!d.truncated, !!d.backlogCut, narrow.includes("sprint")), site, typed, cards.length);
    const queryStat = site && site.q === typed ? { q: site.q, n: site.keys.length, ms: site.ms, ...(site.truncated ? { capped: true, ...(site.total !== undefined ? { total: site.total } : {}) } : {}) } : undefined;
    const read = readState({ error: d.error, at: d.at, rows: cards.length, pollMs: BOARD_POLL_MS, throttled: d.throttled, unauthorised: d.unauthorised, now });
    /* Asking for another view: the cards on screen are the last one's, so the new one is "loading" until it lands. */
    const switching = busy && !!viewId && !!d.view?.id && d.view.id !== viewId;
    const awaiting = awaitingTabRead({ fromView, typed, siteQ: site?.q, failed: queryError?.q === typed && queryError.at === scopeAt });
    const phase: JiraListPhase = !data || switching || awaiting ? "loading" : !cards.length ? (d.error ? "failed" : busy ? "loading" : "empty") : "ready";
    const view = d.view?.id ?? viewId ?? "";
    const assigned = d.view?.id === ASSIGNED_VIEW_ID;
    const sprintName = areaId ? undefined : ctx?.sprint?.name;
    const canRank = writable && !!source.rank && view.startsWith("board:") && filters.group === "status";
    const statuses = columnStatuses(view, d.statuses, cards);
    const lanes = buildLanes({
      cards: shown, statuses, ...(filters.spaces?.length ? { spaces: filters.spaces } : {}), group: filters.group, thenGroup: filters.thenGroup, epics: ctx?.epics ?? [],
      sprintName, sprintView: areaId === SPRINTS, assigned,
      ...(byAgent ? { agentOf: ((state) => (t: ProviderTask) => state(keyOf(t)))(agentStateOf(byAgent, Date.now())) } : {}),
    });
    return {
      phase, view: d.view, cards, lanes, counts: laneCounts(cards, shown.length, basis.total),
      tags: [...new Set(cards.flatMap((t) => t.tags))].sort(),
      read, error: d.error, throttled: !!d.throttled, unauthorised: !!d.unauthorised, truncated: basis.truncated, at: d.at,
      refreshing: busy || !!d.revalidating, sprint: ctx?.sprint, epics: ctx?.epics ?? [], statuses, ...(filters.spaces?.length ? { spaces: filters.spaces } : {}), context: ctx,
      refresh: () => { void run(dataRef.current?.view?.id ?? viewId ?? undefined, true); },
      ...(queryStat ? { queryStat } : {}), ...(queryError && queryError.q === typed && queryError.at === scopeAt ? { queryError } : {}),
      fold, wrote, assigned, said, dismissSaid, ...(canRank ? { rank } : {}), place: d.place, description: d.description, address: source.openAddress(data),
    };
  }, [data, ctx, areas, over, areaId, filters, typed, site, narrow, queryError, scopeAt, busy, now, run, viewId, fold, wrote, said, dismissSaid, rank, writable, source, byAgent]);
}
