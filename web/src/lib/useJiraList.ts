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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardSource, MainFeed, MainReload } from "./boardSource.ts";
import { BOARD_POLL_MS, boardDue } from "./boardPoll.ts";
import { readState } from "./boardStaleness.ts";
import type { JiraBoardAreas, JiraBoardContext, ProviderTask, ViewTasksResponse } from "../../../shared/providers.ts";
import {
  filterCards, laneCounts, pageCards, type JiraListFilters, type JiraListModel, type JiraListPhase,
} from "../components/jira/list/model.ts";
import { buildLanes } from "../components/jira/list/laneModel.ts";
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
const NOTHING: ViewTasksResponse = { tasks: [], statuses: [], fields: [], at: 0 };

export function useJiraList(input: UseJiraListInput): JiraListModel {
  const { source, viewId, areaId, filters, reload = NO_RELOAD, active = true, feed, writable = false } = input;
  const [data, setData] = useState<ViewTasksResponse | null>(null);
  const [ctx, setCtx] = useState<JiraBoardContext | null>(null);
  const [areas, setAreas] = useState<AreasState>({ state: "loading", read: null });
  const [over, setOver] = useState<Record<string, ProviderTask>>({});
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const dataRef = useRef<ViewTasksResponse | null>(null);
  const quickKey = filters.quick.join(",");
  const quickRef = useRef<readonly string[]>(filters.quick);
  quickRef.current = filters.quick;

  const asking = useRef(0);
  const settling = useRef(0);
  const land = (r: ViewTasksResponse) => { dataRef.current = r; setData(r); setNow(Date.now()); feedRef.current?.read(r); };

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
  const dismissSaid = useCallback(() => setSaid(null), []);
  /* A drop on the board: the card sorts at its guessed place at once and goes back to where the read had it if the site refuses. */
  const rank = useCallback((moved: ProviderTask, key: string, ask: { before?: string; after?: string }, order: string | null) => {
    if (order) fold({ ...moved, order });
    void source.rank!(key, ask).then((r) => {
      if (r.ok) return;
      fold(moved);
      setSaid({ text: `Could not rank ${key}: ${r.error ?? "the site refused"}` });
    }).catch(() => { fold(moved); setSaid({ text: `Could not rank ${key}: the site did not answer` }); });
  }, [source, fold]);

  return useMemo(() => {
    const d = data ?? NOTHING;
    const cards = pageCards({ tasks: d.tasks, areaId, areaTasks: areas.read?.ok ? areas.read.tasks : undefined, sprintName: ctx?.sprint?.name, over });
    const shown = filterCards(cards, filters);
    const read = readState({ error: d.error, at: d.at, rows: cards.length, pollMs: BOARD_POLL_MS, throttled: d.throttled, unauthorised: d.unauthorised, now });
    /* Asking for another view: the cards on screen are the last one's, so the new one is "loading" until it lands. */
    const switching = busy && !!viewId && !!d.view?.id && d.view.id !== viewId;
    const phase: JiraListPhase = !data || switching ? "loading" : !cards.length ? (d.error ? "failed" : busy ? "loading" : "empty") : "ready";
    const view = d.view?.id ?? viewId ?? "";
    const assigned = d.view?.id === ASSIGNED_VIEW_ID;
    const sprintName = areaId ? undefined : ctx?.sprint?.name;
    const canRank = writable && !!source.rank && view.startsWith("board:") && filters.group === "status";
    const lanes = buildLanes({
      cards: shown, statuses: d.statuses ?? [], group: filters.group, thenGroup: filters.thenGroup, epics: ctx?.epics ?? [],
      sprintName, sprintView: areaId === SPRINTS, assigned,
    });
    return {
      phase, view: d.view, cards, lanes, counts: laneCounts(cards, shown.length),
      tags: [...new Set(cards.flatMap((t) => t.tags))].sort(),
      read, error: d.error, throttled: !!d.throttled, unauthorised: !!d.unauthorised, truncated: !!d.truncated, at: d.at,
      refreshing: busy || !!d.revalidating, sprint: ctx?.sprint, epics: ctx?.epics ?? [], statuses: d.statuses, context: ctx,
      refresh: () => { void run(dataRef.current?.view?.id ?? viewId ?? undefined, true); },
      fold, assigned, said, dismissSaid, ...(canRank ? { rank } : {}), place: d.place, description: d.description, address: source.openAddress(data),
    };
  }, [data, ctx, areas, over, areaId, filters, busy, now, run, viewId, fold, said, dismissSaid, rank, writable, source]);
}
