/*
 * The Jira list pane's shared vocabulary: what the one data hook (lib/useJiraList.ts)
 * hands out and what the slots of JiraListView read and write. Pure types plus the
 * functions that turn a read into lanes and counts, so each rule can be asserted
 * without a renderer. Nothing here talks to the network.
 *
 * Ceiling: lanes are the status lanes. The other groupings (`group`, `thenGroup`)
 * are state the slots share; the grouped lanes are built by the worker that draws
 * them, from `cards` and `epics`.
 */
import type { JiraBoardContext, JiraBoardEpic, JiraBoardSprint, ListPlace, ListStatus, ProviderTask, SavedView } from "../../../../../shared/providers.ts";
import { blockersOf, groupByStatus, readyCount } from "../../../lib/boardGroups.ts";
import { matchesQuery } from "../../../lib/boardSearch.ts";
import { areaCards, type GroupBy, type ThenBy } from "../../../lib/jiraAreas.ts";
import { SPRINTS } from "../JiraAreas.tsx";
import { splitSprint, sortedByOrder } from "../../../lib/jiraBoardContext.ts";
import type { ReadState } from "../../../lib/boardStaleness.ts";
import { apply as applyBuilt, EMPTY, type FilterSet } from "../../tasks/filters.ts";

/** What narrows the list. One object, so the toolbar, the chips and the footer read and write the same thing. */
export interface JiraListFilters {
  /** Free text over the cards on screen (key, title, labels). */
  query: string;
  /** Only the cards assigned to the person. */
  mineOnly: boolean;
  /** Only the cards nothing blocks. */
  readyOnly: boolean;
  /** One label. */
  tag: string | null;
  /** Statuses picked in the Status control; when any, they replace the done/not-done default. */
  statusPick: string[];
  /** The Filters builder: field, is / is not, values. */
  built: FilterSet;
  /** Finished work is hidden unless this is on (or a status is picked). */
  showDone: boolean;
  /** The board's grouping, and the second grouping inside each group. */
  group: GroupBy;
  thenGroup: ThenBy;
  /** The board's own quick filters pressed, by id. The only part that is asked of the site: the others are drawn here. */
  quick: string[];
  /** The sprint's name while an open epic is narrowed to that sprint; null shows the whole epic. */
  sprintOnly: string | null;
}

export const NO_FILTERS: JiraListFilters = {
  query: "", mineOnly: false, readyOnly: false, tag: null, statusPick: [], built: EMPTY, showDone: false, group: "status", thenGroup: "none", quick: [], sprintOnly: null,
};

/** One status lane: its cards in the order the site ranked them. */
export interface JiraLane {
  status: string;
  color: string | undefined;
  done: boolean;
  points: number;
  cards: ProviderTask[];
  /** Lane model (laneModel.ts). Stable id inside the view: fold and sort are remembered by it. `status` is the lane's title whatever the grouping. */
  key?: string;
  /** What the lane head's tile shows. */
  mark?: "status" | "backlog" | "project" | "sprint" | "priority" | "person" | "area";
  /** The lane does not say the status, so each row wears a quiet status dot. */
  flat?: boolean;
  /** Folded until the person opens it. */
  folded?: boolean;
  /** The "Then" grouping inside this lane. */
  sub?: JiraLane[];
}

export interface JiraListCounts {
  /** Every card the view holds (before any filter). */
  total: number;
  /** The cards the lanes hold now. */
  shown: number;
  open: number;
  done: number;
  mine: number;
  ready: number;
}

/**
 * What the pane is doing, in the order the screen asks:
 *  loading  nothing read yet, no cards to show
 *  failed   nothing to show and the read failed (not connected, refused, unreachable)
 *  empty    read fine, the view holds no cards
 *  ready    cards to draw (they may be stale: see `read`)
 */
export type JiraListPhase = "loading" | "failed" | "empty" | "ready";

export interface JiraListModel {
  phase: JiraListPhase;
  view: SavedView | undefined;
  /** Every card of the page (the view, or the open Area), before the filters. */
  cards: ProviderTask[];
  /** The lanes, filtered. Empty lanes are kept: a status nobody wears is half of what a workflow says. */
  lanes: JiraLane[];
  counts: JiraListCounts;
  /** Labels on the cards, sorted: what the label chips offer. */
  tags: string[];
  /** Fine, retrying (a failed read that does not matter yet) or stale (the cards cannot be trusted). */
  read: ReadState;
  error: string | undefined;
  throttled: boolean;
  unauthorised: boolean;
  /** More behind the read than was followed. */
  truncated: boolean;
  /** When the cards were read; 0 for none. */
  at: number;
  /** A fresh read is running behind these cards. */
  refreshing: boolean;
  sprint: JiraBoardSprint | undefined;
  epics: JiraBoardEpic[];
  /** The board's statuses in the workflow's order (the Status control's list). */
  statuses: ListStatus[];
  /** The context read (quick filters, sprint, epics), for the slots that draw its quick filters. */
  context: JiraBoardContext | null;
  /** Read again now, skipping the server's minute. */
  refresh: () => void;
  /** A card the pane changed (a move, an assignment): what the site now says, drawn at once in place of the read. */
  fold: (t: ProviderTask) => void;
  /** Lanes (S2): the view is "Assigned to me", whose lanes are projects. */
  assigned?: boolean;
  /** Lanes (S2): put a card before or after another on the site, drawn at once. Absent where ranking is not possible (changes off, not a board, not grouped by status). */
  rank?: (moved: ProviderTask, key: string, ask: { before?: string; after?: string }, order: string | null) => void;
  /** Lanes (S2): the last thing the pane tried and the site refused, until dismissed or the next read. */
  said?: { text: string } | null;
  dismissSaid?: () => void;
  /** Where the board sits (project, then board), for the breadcrumb; absent for the built-in views. */
  place?: ListPlace;
  /** The board's brief (the About dialog); absent when it has none. */
  description?: string;
  /** The view's own address on the site, for "Open in Jira"; absent until it has one. */
  address?: string;
}

/** The cards of the page: an open Area's, the sprint's, or the whole view. A write the card pane made (`over`) wins over the read. */
export function pageCards(o: {
  tasks: readonly ProviderTask[];
  areaId: string | null;
  areaTasks: readonly ProviderTask[] | undefined;
  sprintName: string | undefined;
  over?: Readonly<Record<string, ProviderTask>>;
}): ProviderTask[] {
  const area = o.areaId && o.areaId !== SPRINTS
    ? areaCards(o.areaTasks ?? [], o.areaId)
    : o.areaId === SPRINTS && o.sprintName ? splitSprint(o.tasks, o.sprintName).inSprint : [...o.tasks];
  return area.map((t) => o.over?.[t.id] ?? t);
}

/** The filters, the way the board has always applied them: the builder first, then the chips. */
export function filterCards(cards: readonly ProviderTask[], f: JiraListFilters): ProviderTask[] {
  const byId = new Map(cards.map((t) => [t.id, t]));
  return applyBuilt([...cards], f.built).filter((t) =>
    (f.statusPick.length ? f.statusPick.includes(t.status) : (f.showDone || t.statusKind !== "done"))
    && (!f.sprintOnly || t.sprint === f.sprintOnly)
    && (!f.mineOnly || t.mine)
    && (!f.tag || t.tags.includes(f.tag))
    && (!f.readyOnly || !blockersOf(t, byId).length)
    && matchesQuery(t, f.query));
}

export function laneCounts(all: readonly ProviderTask[], shown: number): JiraListCounts {
  return {
    total: all.length,
    shown,
    open: all.filter((t) => t.statusKind !== "done").length,
    done: all.filter((t) => t.statusKind === "done").length,
    mine: all.filter((t) => t.mine && t.statusKind !== "done").length,
    ready: readyCount([...all]),
  };
}

export function lanesOf(cards: readonly ProviderTask[], statuses: readonly ListStatus[]): JiraLane[] {
  return groupByStatus(cards, statuses, (list) => sortedByOrder(list)).map((g) => ({
    status: g.status, color: g.color, done: g.done, points: g.points, cards: g.rows,
  }));
}

/** "Looked up": the cards found by id that are on no board, drawn as one flat lane in place of the view. The filters do not apply to them. */
export function lookedModel(model: JiraListModel, cards: readonly ProviderTask[]): JiraListModel {
  const own = [...cards];
  const lane: JiraLane = { key: "looked", status: "Looked up", color: undefined, done: false, points: 0, cards: own, mark: "backlog", flat: true, folded: false };
  return { ...model, phase: own.length ? "ready" : "empty", cards: own, lanes: [lane], counts: { ...model.counts, total: own.length, shown: own.length }, assigned: false };
}
