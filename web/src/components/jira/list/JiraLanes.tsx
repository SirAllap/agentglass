/*
 * The column captions and the lanes of soft rows: the centre of the Jira list. One scroller holds the sticky captions and
 * every lane, so the captions and the rows share one width. What goes in a lane is the lane model's (laneModel.ts); how a
 * lane is sorted and folded is the view's lane state (lib/jiraLaneState.ts) and its pins and hidden cards the menus' prefs.
 *
 * Ceilings, on purpose: a long lane draws its first rows and pages by 40; the second level ("Then") is one level deep; a drag
 * ranks inside one status lane, sorted by rank, with changes on. A parent opens its sub-tasks: its card's count says it has
 * some (the board's search leaves them out), and the rows come from one read per parent, held for the session
 * (lib/jiraSubtasks.ts).
 */
import { useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import { blockersOf } from "../../../lib/boardGroups.ts";
import { guessOrder, rankOf, rankable } from "../../../lib/jiraBoardContext.ts";
import { jiraSubtasksVersion, onJiraSubtasks, peekJiraSubtasks, readJiraSubtasks } from "../../../lib/jiraSubtasks.ts";
import { laneFolded, laneSortOf, setLaneFolded, useLaneState } from "../../../lib/jiraLaneState.ts";
import { JiraColumns, useColumns } from "./JiraColumns.tsx";
import { JiraLaneHead, type EpicFacts } from "./JiraLaneHead.tsx";
import { AddSubtask } from "./AddSubtask.tsx";
import { agentUrgency, cardKeysOf, fleetNow, onFleet, workerFor } from "../../../lib/jiraCardWork.ts";
import type { AgentCard } from "../../../lib/derive.ts";
import { JiraRow, cardCi, type DragRow, type JiraRowProps } from "./JiraRow.tsx";
import { JiraSkeleton, JiraStateCard } from "./JiraStates.tsx";
import {
  childRows, epicColumn, isSubtask, keyOf, listState, morePage, nestSubtasks, nextStep, opensSubtasks, sortCards, thirdColumn, visibleRows, type Cols, type LaneSort,
} from "./laneModel.ts";
import { usePrefs } from "./menus/viewPrefs.ts";
import type { JiraLane, JiraListFilters, JiraListModel } from "./model.ts";
import type { Selection } from "./selectionModel.ts";
import { askDock } from "./menus/dockIntent.ts";
import type { Blocker } from "../../../lib/blockers.ts";

export interface JiraLanesProps {
  model: JiraListModel;
  viewId: string | null;
  /** The open epic or the sprint page, when the list is one. */
  areaId?: string | null;
  filters: JiraListFilters;
  onFilters: (patch: Partial<JiraListFilters>) => void;
  /** The card open in the dock, if any. */
  selectedId: string | null;
  onOpen: (id: string) => void;
  /** Open a sub-task row by its own card, not just its id: a chevron's children and a lane's lone sub-tasks are not
   *  always in `model.cards`, so the id alone cannot be looked up again once clicked. */
  onOpenCard: (card: ProviderTask) => void;
  onRowMenu?: (e: MouseEvent, card: ProviderTask) => void;
  onLaneMenu?: (e: MouseEvent, lane: JiraLane) => void;
  onSubtaskMenu?: (e: MouseEvent, card: ProviderTask) => void;
  /** Whether this app may change Jira: the sub-task bar is off when it may not. */
  writable?: boolean;
  /** Looked-up cards only: leave the list. */
  onForget?: (card: ProviderTask) => void;
  /** Which cards are picked for a bulk action, and the row's own checkbox toggling one. Absent turns the checkbox off. */
  picked?: Selection;
  onPick?: (id: string) => void;
}

export const todayStr = (): string => {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const NOT_BLOCKED: readonly Blocker[] = [];
const laneId = (l: JiraLane): string => l.key ?? l.status;

/** A lane's cards as the person sorted them; pinned cards stay on top whatever the sort. */
function ordered(cards: readonly ProviderTask[], by: LaneSort, pinned: readonly string[], agents: readonly AgentCard[]): ProviderTask[] {
  if (by === "rank") return [...cards];
  const top = cards.filter((t) => pinned.includes(t.id));
  const rank = (t: ProviderTask): number => { const w = workerFor(keyOf(t), agents); return !w ? 3 : agentUrgency(w.status); };
  return [...top, ...sortCards(cards.filter((t) => !pinned.includes(t.id)), by, rank)];
}

export function JiraLanes(p: JiraLanesProps) {
  const { model, viewId, areaId, filters, onFilters, selectedId, onOpen, onOpenCard, onRowMenu, onLaneMenu, onSubtaskMenu, onForget, writable, picked, onPick } = p;
  const view = viewId ?? model.view?.id ?? "";
  const scroller = useRef<HTMLDivElement>(null);
  const state = listState({ phase: model.phase, error: model.error, shown: model.counts.shown, areaId });
  const shows = state === "loading" || state === "lanes";
  const cols = useColumns(scroller, shows);
  useLaneState();
  const prefs = usePrefs(viewId);
  const today = todayStr();
  const third = thirdColumn({ assigned: !!model.assigned, group: filters.group, cards: model.cards });

  /* More rows asked for per lane, forgotten with the view. */
  const [asked, setAsked] = useState<Record<string, number>>({});
  const more = (id: string) => asked[`${view}|${id}`] ?? 0;
  const ask = (id: string, n: number) => setAsked((m) => ({ ...m, [`${view}|${id}`]: (m[`${view}|${id}`] ?? 0) + n }));

  /* Parents opened to show their own sub-tasks, closed until asked and forgotten with the view. */
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const isOpen = (key: string) => opened[`${view}|${key}`] ?? false;
  /* Opening is when a parent's sub-tasks are asked for: one read per parent, held for the session, and the store says when one lands. */
  useSyncExternalStore(onJiraSubtasks, jiraSubtasksVersion, jiraSubtasksVersion);
  const flip = (card: ProviderTask) => {
    const key = keyOf(card);
    const next = !isOpen(key);
    setOpened((m) => ({ ...m, [`${view}|${key}`]: next }));
    if (next) void readJiraSubtasks(key);
  };

  const agents = useSyncExternalStore(onFleet, fleetNow, fleetNow);
  const epicFacts = (lane: JiraLane): EpicFacts => {
    const byStatus = new Map<string, { status: string; color: string | undefined; n: number }>();
    for (const t of lane.cards) { const e = byStatus.get(t.status) ?? { status: t.status, color: t.statusColor ?? undefined, n: 0 }; e.n++; byStatus.set(t.status, e); }
    const order = new Map(model.statuses.map((x, i) => [x.status, i]));
    const k = (lane.key ?? "").replace(/^area:/, "");
    const next = nextStep(lane.cards, cardCi, (t) => workerFor(keyOf(t), agents)?.status === "waiting", (t) => agentUrgency(workerFor(keyOf(t), agents)?.status ?? "") === 1);
    return {
      key: k && k !== "none" ? k : null,
      done: lane.cards.filter((t) => t.statusKind === "done").length,
      live: lane.cards.filter((t) => workerFor(keyOf(t), agents)?.status === "working").length,
      waiting: lane.cards.filter((t) => workerFor(keyOf(t), agents)?.status === "waiting").length,
      spent: (() => { const keys = new Set(lane.cards.map((t) => keyOf(t).toUpperCase())); return agents.filter((a) => cardKeysOf(a).some((x) => keys.has(x))).reduce((n, a) => n + a.cost, 0); })(),
      stack: [...byStatus.values()].sort((a, b) => (order.get(a.status) ?? 99) - (order.get(b.status) ?? 99)),
      next,
      onNext: (id: string) => { onOpen(id); if (next?.work) askDock(id, "work"); },
    };
  };

  const blocked = useMemo(() => {
    const byId = new Map(model.cards.map((t) => [t.id, t]));
    const m = new Map<string, readonly Blocker[]>();
    for (const t of model.cards) { const b = blockersOf(t, byId); if (b.length) m.set(t.id, b.map((x) => ({ key: keyOf(x), status: x.status }))); }
    return m;
  }, [model.cards]);

  /* Dragging to rank: the card picked up, and the half of the row the pointer is over. */
  const pickRef = useRef<{ key: string; lane: string } | null>(null);
  const [mark, setMark] = useState<{ id: string; half: "top" | "bottom" } | null>(null);
  const dragFor = (lane: JiraLane, tops: readonly ProviderTask[], t: ProviderTask): DragRow | undefined => {
    if (!model.rank || lane.mark !== "status" || !rankable(lane.cards) || isSubtask(t)) return undefined;
    const keys = tops.map(keyOf);
    const key = keyOf(t);
    const half = (e: DragEvent<HTMLElement>): "top" | "bottom" => {
      const box = e.currentTarget.getBoundingClientRect();
      return e.clientY - box.top < box.height / 2 ? "top" : "bottom";
    };
    return {
      edge: mark?.id === t.id ? mark.half : null,
      onStart: () => { pickRef.current = { key, lane: laneId(lane) }; },
      onEnd: () => { pickRef.current = null; setMark(null); },
      onOver: (e) => {
        const from = pickRef.current;
        if (!from || from.lane !== laneId(lane) || from.key === key) return;
        e.preventDefault();
        const h = half(e);
        setMark((m) => (m?.id === t.id && m.half === h ? m : { id: t.id, half: h }));
      },
      onDrop: (e) => {
        const from = pickRef.current;
        pickRef.current = null; setMark(null);
        if (!from || from.lane !== laneId(lane)) return;
        e.preventDefault();
        const h = half(e);
        const r = rankOf(keys, from.key, key, h);
        const moved = tops.find((x) => keyOf(x) === from.key);
        if (r && moved) model.rank?.(moved, r.key, r.ask, guessOrder(t.order, h));
      },
    };
  };

  /* The one row a Tab reaches when nothing is open: the first one drawn. */
  const firstOf = (lanes: readonly JiraLane[]): string | undefined => {
    for (const l of lanes) {
      if (laneFolded(view, laneId(l), !!l.folded)) continue;
      const id = l.sub?.length ? firstOf(l.sub) : nestSubtasks(ordered(l.cards, laneSortOf(view, laneId(l)), prefs.pinned, agents))[0]?.card.id;
      if (id) return id;
    }
    return undefined;
  };
  const firstId = shows ? firstOf(model.lanes) : undefined;
  const row = (lane: JiraLane, c: Cols, t: ProviderTask, nested: boolean, tops: readonly ProviderTask[], sort: LaneSort, o: { open?: JiraRowProps["open"]; chip?: boolean; /** The card a sub-task hangs under: it is where the child's epic comes from. */ above?: ProviderTask; ring?: { done: number; of: number } | null } = {}) => {
    const sub = isSubtask(t);
    const epic = epicColumn(t, o.above);
    const thirdCell = third === "Sprint" ? (t.sprint ? { text: t.sprint } : null) : epic ? { text: epic.title } : null;
    const menu = sub ? onSubtaskMenu : onRowMenu;
    return (
      <JiraRow key={t.id} card={t} cols={c} third={thirdCell} today={today} selected={t.id === selectedId}
        tabbable={t.id === selectedId || t.id === firstId} nested={nested} open={o.open ?? null} chip={o.chip}
        dot={lane.flat && lane.mark !== "area" && !o.chip ? { color: t.statusColor ?? lane.color, name: t.status } : null} statuses={model.statuses} onStatus={onRowMenu}
        ring={o.ring ?? null} blockedBy={blocked.get(t.id) ?? NOT_BLOCKED}
        drag={sort === "rank" && !nested ? dragFor(lane, tops, t) : undefined} onOpen={nested ? () => onOpenCard(t) : onOpen} onMenu={menu}
        onForget={onForget ? () => onForget(t) : undefined}
        picked={onPick ? !!picked?.has(t.id) : undefined} onPick={onPick ? () => onPick(t.id) : undefined} />
    );
  };

  const laneView = (lane: JiraLane, c: Cols, inner = false) => {
    const id = laneId(lane);
    const folded = laneFolded(view, id, !!lane.folded);
    const sort = laneSortOf(view, id);
    const entries = nestSubtasks(ordered(lane.cards, sort, prefs.pinned, agents));
    const total = entries.length;
    const shown = visibleRows(total, more(id));
    const next = morePage(total, shown);
    const tops = entries.map((e) => e.card);
    return (
      <section key={id} className={`agx-jl-lane${inner ? " is-sub" : ""}`} role="rowgroup" data-lane={id} data-folded={folded ? "" : undefined}
        aria-label={lane.status} style={lane.color ? { ["--t" as string]: lane.color } : undefined}>
        <JiraLaneHead lane={lane} epic={lane.mark === "area" ? epicFacts(lane) : null} id={id} viewId={view} folded={folded} sort={sort} onMenu={onLaneMenu}
          onToggle={() => setLaneFolded(view, [id], !folded)} />
        {!folded && (
          <div className="agx-jl-body">
            {lane.sub?.length ? lane.sub.map((s) => laneView(s, c, true)) : (
              <>
                {!total && <div className="agx-jl-lane-empty">Nothing here</div>}
                {entries.slice(0, shown).map((e) => {
                  /* A parent opens the sub-tasks its lane does not already draw: the card's count is the only trace of them, so
                     the rows come from the parent's own read, asked for once when it is first opened. */
                  const key = keyOf(e.card);
                  const chevron = opensSubtasks(e.card, e.subs.length);
                  const expanded = chevron && isOpen(key);
                  const read = expanded ? peekJiraSubtasks(key) : null;
                  const kids = read ? childRows(read.rows, e.subs) : [];
                  const count = read && !read.error ? kids.length : Math.max(0, (e.card.subtasks ?? 0) - e.subs.length);
                  /* A sub-task that nestSubtasks could not place under its parent (the parent sits in another
                     lane, or this lane has no lane status to speak for it at all) is a row of its own: it wears
                     its own chip instead of the lane's dot, the same as a chevron's children do. */
                  return (
                    <div key={e.card.id}>
                      {row(lane, c, e.card, false, tops, sort, chevron ? {
                        open: { expanded, count, onToggle: () => flip(e.card) },
                        ring: expanded && read && !read.error ? { done: kids.filter((x) => x.statusKind === "done").length, of: kids.length } : null,
                      } : (isSubtask(e.card) ? { chip: true } : {}))}
                      {e.subs.map((s) => row(lane, c, s, true, tops, sort, { above: e.card }))}
                      {expanded && kids.map((s) => row(lane, c, s, true, tops, sort, { chip: true, above: e.card }))}
                      {expanded && read?.error && <div className="agx-jl-open-note">{read.error}</div>}
                      {expanded && read && !read.error && <AddSubtask parent={e.card} kids={kids} writable={!!writable} />}
                    </div>
                  );
                })}
                {next && (
                  <button type="button" className="agx-jl-more" onClick={() => ask(id, next.step)}>
                    Show {next.step} more {next.left > 0 && <small>({next.left} left)</small>}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </section>
    );
  };

  /* Up and Down move between rows; Tab leaves the list. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || !(e.target as HTMLElement).matches("[data-jl-row]")) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-jl-row]")];
    const at = rows.indexOf(e.target as HTMLElement);
    const to = rows[at + (e.key === "ArrowDown" ? 1 : -1)];
    if (!to) return;
    e.preventDefault();
    to.focus();
  };

  const card = shows ? null : <JiraStateCard state={state} model={model} filters={filters} onFilters={onFilters} areaId={areaId} />;
  return (
    <div ref={scroller} data-slot="lanes" role="grid" aria-label="Cards" aria-busy={state === "loading"}
      className="agx-jl-scroll agx-scroll" style={{ ["--jl-cols" as string]: cols.template, ...(card ? { display: "flex" } : {}) }} onKeyDown={onKeyDown}>
      {shows && <JiraColumns cols={cols} third={third} />}
      {state === "loading" && <JiraSkeleton />}
      {state === "lanes" && model.lanes.map((l) => laneView(l, cols))}
      {card}
    </div>
  );
}
