/*
 * The column captions and the lanes of soft rows: the centre of the Jira list. One scroller holds the sticky captions and
 * every lane, so the captions and the rows share one width. What goes in a lane is the lane model's (laneModel.ts); how a
 * lane is sorted and folded is the view's lane state (lib/jiraLaneState.ts) and its pins and hidden cards the menus' prefs.
 *
 * Ceilings, on purpose: a long lane draws its first rows and pages by 40; the second level ("Then") is one level deep; a drag
 * ranks inside one status lane, sorted by rank, with changes on.
 */
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import { blockersOf } from "../../../lib/boardGroups.ts";
import { epicTone, guessOrder, rankOf, rankable } from "../../../lib/jiraBoardContext.ts";
import { laneFolded, laneSortOf, setLaneFolded, useLaneState } from "../../../lib/jiraLaneState.ts";
import { JiraColumns, useColumns } from "./JiraColumns.tsx";
import { JiraLaneHead } from "./JiraLaneHead.tsx";
import { JiraRow, type DragRow } from "./JiraRow.tsx";
import { JiraSkeleton, JiraStateCard } from "./JiraStates.tsx";
import {
  isSubtask, keyOf, listState, morePage, nestSubtasks, sortCards, thirdColumn, visibleRows, type Cols, type LaneSort,
} from "./laneModel.ts";
import { usePrefs } from "./menus/viewPrefs.ts";
import type { JiraLane, JiraListFilters, JiraListModel } from "./model.ts";

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
  onRowMenu?: (e: MouseEvent, card: ProviderTask) => void;
  onLaneMenu?: (e: MouseEvent, lane: JiraLane) => void;
  onSubtaskMenu?: (e: MouseEvent, card: ProviderTask) => void;
  /** Looked-up cards only: leave the list. */
  onForget?: (card: ProviderTask) => void;
}

const todayStr = (): string => {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const NOT_BLOCKED: readonly string[] = [];
const laneId = (l: JiraLane): string => l.key ?? l.status;

/** A lane's cards as the person sorted them; pinned cards stay on top whatever the sort. */
function ordered(cards: readonly ProviderTask[], by: LaneSort, pinned: readonly string[]): ProviderTask[] {
  if (by === "rank") return [...cards];
  const top = cards.filter((t) => pinned.includes(t.id));
  return [...top, ...sortCards(cards.filter((t) => !pinned.includes(t.id)), by)];
}

export function JiraLanes(p: JiraLanesProps) {
  const { model, viewId, areaId, filters, onFilters, selectedId, onOpen, onRowMenu, onLaneMenu, onSubtaskMenu, onForget } = p;
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

  const epicTones = useMemo(() => new Map(model.epics.map((e) => [e.key, `var(${epicTone(e.color)})`])), [model.epics]);
  const blocked = useMemo(() => {
    const byId = new Map(model.cards.map((t) => [t.id, t]));
    const m = new Map<string, readonly string[]>();
    for (const t of model.cards) { const b = blockersOf(t, byId); if (b.length) m.set(t.id, b.map(keyOf)); }
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
      const id = l.sub?.length ? firstOf(l.sub) : nestSubtasks(ordered(l.cards, laneSortOf(view, laneId(l)), prefs.pinned))[0]?.card.id;
      if (id) return id;
    }
    return undefined;
  };
  const firstId = shows ? firstOf(model.lanes) : undefined;
  const row = (lane: JiraLane, c: Cols, t: ProviderTask, nested: boolean, tops: readonly ProviderTask[], sort: LaneSort) => {
    const sub = isSubtask(t);
    const epic = t.parent && t.parent.type !== "Sub-task" ? t.parent : undefined;
    const thirdCell = third === "Sprint" ? (t.sprint ? { text: t.sprint } : null) : epic ? { text: epic.title, tone: epicTones.get(epic.key) ?? "var(--text3)" } : null;
    const menu = sub ? onSubtaskMenu : onRowMenu;
    return (
      <JiraRow key={t.id} card={t} cols={c} third={thirdCell} today={today} selected={t.id === selectedId}
        tabbable={t.id === selectedId || t.id === firstId} nested={nested}
        dot={lane.flat ? { color: t.statusColor ?? lane.color, name: t.status } : null} blockedBy={blocked.get(t.id) ?? NOT_BLOCKED}
        drag={sort === "rank" && !nested ? dragFor(lane, tops, t) : undefined} onOpen={onOpen} onMenu={menu}
        onForget={onForget ? () => onForget(t) : undefined} />
    );
  };

  const laneView = (lane: JiraLane, c: Cols, inner = false) => {
    const id = laneId(lane);
    const folded = laneFolded(view, id, !!lane.folded);
    const sort = laneSortOf(view, id);
    const entries = nestSubtasks(ordered(lane.cards, sort, prefs.pinned));
    const total = entries.length;
    const shown = visibleRows(total, more(id));
    const next = morePage(total, shown);
    const tops = entries.map((e) => e.card);
    return (
      <section key={id} className={`agx-jl-lane${inner ? " is-sub" : ""}`} role="rowgroup" data-lane={id} data-folded={folded ? "" : undefined}
        aria-label={lane.status} style={lane.color ? { ["--t" as string]: lane.color } : undefined}>
        <JiraLaneHead lane={lane} id={id} viewId={view} folded={folded} sort={sort} onMenu={onLaneMenu}
          onToggle={() => setLaneFolded(view, [id], !folded)} />
        {!folded && (
          <div className="agx-jl-body">
            {lane.sub?.length ? lane.sub.map((s) => laneView(s, c, true)) : (
              <>
                {!total && <div className="agx-jl-lane-empty">Nothing here</div>}
                {entries.slice(0, shown).map((e) => (
                  <div key={e.card.id}>
                    {row(lane, c, e.card, false, tops, sort)}
                    {e.subs.map((s) => row(lane, c, s, true, tops, sort))}
                  </div>
                ))}
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
