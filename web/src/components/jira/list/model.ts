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
import { looksJql, matchesJql, parseJql } from "./boardModel.ts";
import { keyOf } from "./laneModel.ts";
import { passesEpicComponent } from "./facetsModel.ts";
import { areaCards, type GroupBy, type ThenBy } from "../../../lib/jiraAreas.ts";
import { SPRINTS } from "../JiraAreas.tsx";
import { splitSprint, sortedByOrder } from "../../../lib/jiraBoardContext.ts";
import type { ReadState } from "../../../lib/boardStaleness.ts";
import { epicKeyOf } from "./facetsModel.ts";
import { sprintPasses } from "./sprintModel.ts";
import { apply as applyBuilt, EMPTY, type FilterSet } from "../../tasks/filters.ts";

/** What narrows the list. One object, so the toolbar, the chips and the footer read and write the same thing. */
export interface JiraListFilters {
  /** Free text over the cards on screen (key, title, labels). */
  query: string;
  /** The search of the view on screen. It is NOT the box: the box stays free for typing, and the JQL chip shows this. */
  viewJql?: string | null;
  /** The view on screen says its search is cross-space: the site runs it without the open board's scope. */
  viewCross?: boolean;
  /** Only the cards of these spaces (project keys); none means all of them. */
  spaces?: string[];
  /** The keys the site answered for `query` read as JQL; used only while `q` is still the query typed. */
  /** `truncated`: the site stopped at its cap, so its set may lack a card here and only ever adds to the local reading. */
  site?: { q: string; keys: readonly string[]; truncated?: boolean } | null;
  /** The boards' own "next" sprint names (earliest future of each board in view); set by the view, never kept. Without it next is read off the cards. */
  nextSprints?: readonly string[];
  /** Only the cards assigned to the person. */
  mineOnly: boolean;
  /** Only the cards nothing blocks. */
  readyOnly: boolean;
  /** The board's quick toggles from the mockup: a live agent on it, flagged, blocked by an open card, a due date set. */
  liveOnly?: boolean;
  /** Only the cards whose agent is waiting on a person: the board narrowed to what needs you now. */
  needsOnly?: boolean;
  flaggedOnly?: boolean;
  blockedOnly?: boolean;
  dueOnly?: boolean;
  /** Open and unchanged for QUIET_DAYS: the cards that stalled. */
  quietOnly?: boolean;
  /** The keys of the cards a live agent works on now (jiraCardWork.ts), set by the view while Live worker is on. */
  live?: readonly string[];
  /** The keys whose agent waits on a person, threaded in only while needsOnly is on. */
  needs?: readonly string[];
  /** Labels: a card with any of them shows. */
  tagPick: string[];
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
  /** The Sprint group's picks: "@current", "@next", "@none" or "n:<sprint name>"; a card in any of them shows. Replaces the Current sprint toggle. */
  sprintPick?: string[];
  /** "is not": values left out per group id (status, sprint, people, space, epic, label, component, priority). A card holding any of them is hidden. */
  notPick?: Record<string, string[]>;
  /** The Priority group's picks: "urgent", "high", "normal", "low" or "none" (no priority); a card with any of them shows. */
  priorityPick?: string[];
  /** Labels: a card must hold every picked label (all of), not any one of them. */
  tagAll?: boolean;
  /** The people chip beside the search box: cards with none of these assignees are hidden. Empty shows everyone. */
  assigneePick: string[];
  /** Epics picked in the Filters menu, by key: a card under any of them shows. A filter on top of the view, not the sidebar's area. */
  epicPick: string[];
  /** Components picked in the Filters menu, by name: a card filed under any of them shows. */
  componentPick: string[];
}

/** sprintOnly's value for "any sprint running now", whichever space it belongs to; any other value is one sprint's name. */
export const RUNNING_SPRINTS = "@running";

/* An open card with no change in this many days has stalled: the tile wears a dim clock and the Quiet filter keeps only those. */
export const QUIET_DAYS = 14;
/** Days since an open card last changed, or 0 when it is done, dated now, or newer than QUIET_DAYS. */
export function quietDays(t: { updated?: number; statusKind?: string }, now = Date.now()): number {
  if (!t.updated || t.statusKind === "done") return 0;
  const d = Math.floor((now - t.updated) / 86_400_000);
  return d >= QUIET_DAYS ? d : 0;
}

export const NO_FILTERS: JiraListFilters = {
  query: "", mineOnly: false, readyOnly: false, tagPick: [], statusPick: [], built: EMPTY, showDone: false, group: "status", thenGroup: "none", quick: [], sprintOnly: null, sprintPick: [], notPick: {}, tagAll: false, assigneePick: [], epicPick: [], componentPick: [],
};

/** A scope id that names an epic or a component: an Area page. */
export const isAreaScope = (viewId: string | null | undefined): boolean => /^scope:[^|]+\|(.*\|)?(c:|e:)/.test(viewId ?? "");

/** An Area page is about its own cards, finished ones included, and inherits nothing from the view that was open: no
 *  Hide done, people, spaces, tab search or quick chips. Whatever is set there lives there and is dropped on leaving.
 *  Ceiling: a space page (scope with neither) still starts with done hidden; the person can show them on any page. */
/* One object, not a fresh one per call: the list reads `byView[key] ?? startFilters(...)` on every render, and a new object
   each time changed the filters' identity on every render, so the effects keyed on them redrew forever (React error 185). */
const AREA_FILTERS: JiraListFilters = { ...NO_FILTERS, showDone: true };
export function startFilters(viewId: string | null | undefined, areaId?: string | null): JiraListFilters {
  return isAreaScope(viewId) || areaId ? AREA_FILTERS : NO_FILTERS;
}


/** The space (project key) a card belongs to. */
export const spaceOf = (t: ProviderTask): string => {
  const k = keyOf(t);
  const i = k.lastIndexOf("-");
  return (i > 0 ? k.slice(0, i) : t.listId ?? "").toUpperCase();
};

/** A card's own assignee ids: a person's key where the card has one, their name otherwise - the same identity `assigneePick` is built from. */
export const assigneeIdsOf = (t: ProviderTask): string[] => (t.people?.length ? t.people.map((p) => p.key ?? p.name) : t.assignees);

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
  mark?: "status" | "backlog" | "project" | "sprint" | "priority" | "person" | "area" | "agent";
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
  /** The spaces the space filter narrows to; none is every space. The columns are the workflow of these. */
  spaces?: string[];
  /** The context read (quick filters, sprint, epics), for the slots that draw its quick filters. */
  context: JiraBoardContext | null;
  /** Read again now, skipping the server's minute. */
  refresh: () => void;
  /** A card the pane changed (a move, an assignment): what the site now says, drawn at once in place of the read. */
  fold: (t: ProviderTask) => void;
  /** The detail's copy of a card: folded at once; when it is newer than the board's (a write), the view and its search are read again past every kept copy. */
  wrote: (t: ProviderTask) => void;
  /** Lanes (S2): the view is "Assigned to me", whose lanes are projects. */
  assigned?: boolean;
  /** Lanes (S2): put a card before or after another on the site, drawn at once. Absent where ranking is not possible (changes off, not a board, not grouped by status). */
  rank?: (moved: ProviderTask, key: string, ask: { before?: string; after?: string }, order: string | null) => void;
  /** Lanes (S2): the last thing the pane tried and the site refused, until dismissed or the next read. */
  said?: { text: string } | null;
  dismissSaid?: () => void;
  /** The last answer the site gave for the JQL in the search box: how many cards and how long the (cached) route took. */
  /** `capped`: the site has more than it sent (`total`, when it said how many). */
  queryStat?: { q: string; n: number; ms: number; capped?: boolean; total?: number };
  /** The site refused the JQL in the box (a parse error, most often): its own sentence, for the query it still names. */
  queryError?: { q: string; text: string };
  /** Where the board sits (project, then board), for the breadcrumb; absent for the built-in views. */
  place?: ListPlace;
  /** The board's brief (the About dialog); absent when it has none. */
  description?: string;
  /** The view's own address on the site, for "Open in Jira"; absent until it has one. */
  address?: string;
}

/** The cards of the page: an open Area's, the sprint's, or the whole view. A write the card pane made (`over`) wins over the read. */
/** The cards the site answered for the JQL in the box, added to the page's own: the board reads a capped page, and a match
 *  past it was looked up only among what it held, so it vanished. A card the page already has keeps the page's copy. */
export function withSiteCards(page: ProviderTask[], fromSite: readonly ProviderTask[] | undefined, cross = false): ProviderTask[] {
  // A cross-site view (Mine, Team) is the site's answer alone: the open board's cards are not part of its scope.
  if (cross && fromSite) return [...fromSite];
  if (!fromSite?.length) return page;
  const have = new Set(page.map(keyOf));
  const more = fromSite.filter((t) => !have.has(keyOf(t)));
  return more.length ? [...page, ...more] : page;
}

/** The site's cards as the board draws them: a copy the detail folded in wins, as it does over the page's own. */
export const foldSite = (fromSite: readonly ProviderTask[], over: Readonly<Record<string, ProviderTask>>): ProviderTask[] => fromSite.map((t) => over[t.id] ?? t);

/**
 * Whether the JQL search is asked again, and past the server's kept 30 s (`fresh`). A forced read (Refresh, a write) bumps
 * `round`; an answer read in an earlier round is asked again even for the same text, or a card that left stays drawn.
 */
export function siteAsk(site: { q: string; full: boolean; round: number } | null, typed: string, wantFull: boolean, round: number): { ask: boolean; fresh: boolean } {
  const fresh = !!site && site.q === typed && site.round !== round;
  return { ask: !(site?.q === typed && (site.full || !wantFull) && !fresh), fresh };
}

/**
 * The detail's copy of a card is newer than the board's AND moved who holds it or its status: the two changes that can take
 * a card out of a view. Any other edit (a title, a comment) is drawn by the fold alone and costs no read of the board.
 */
export const newerThanBoard = (t: Pick<ProviderTask, "updated" | "assignees" | "status">, had: Pick<ProviderTask, "updated" | "assignees" | "status"> | undefined): boolean =>
  !!had && (t.updated ?? 0) > (had.updated ?? 0) && (t.status !== had.status || [...t.assignees].sort().join("\n") !== [...had.assignees].sort().join("\n"));

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

/**
 * A live read is newer than any card copy folded in from an edit or the detail panel: a folded copy stays only for a card
 * the read did not bring, whose rank still waits on the site, or that is newer than the read's copy, so a change made on the site (an epic, a status) is not hidden behind an old copy for good.
 */
export function overAfterRead(over: Readonly<Record<string, ProviderTask>>, read: readonly ProviderTask[], pending: ReadonlySet<string> = new Set()): Record<string, ProviderTask> {
  const brought = new Map(read.map((t) => [t.id, t] as const));
  // A read older than the write (the site's search can lag a moment behind it) does not put the old copy back.
  const older = (id: string, t: ProviderTask): boolean => (t.updated ?? 0) > (brought.get(id)?.updated ?? 0);
  return Object.fromEntries(Object.entries(over).filter(([id, t]) => !brought.has(id) || pending.has(id) || older(id, t)));
}

/** The search the site is asked: the JQL typed in the box, else the view's own search. Words in the box never replace the view's. */
export function effectiveJql(f: Pick<JiraListFilters, "query" | "viewJql">): string {
  const q = f.query.trim();
  return looksJql(q) ? q : f.viewJql?.trim() ?? "";
}

/** The filters, the way the board has always applied them: the builder first, then the chips. */
export function filterCards(cards: readonly ProviderTask[], f: JiraListFilters): ProviderTask[] {
  const byId = new Map(cards.map((t) => [t.id, t]));
  // A query that reads as JQL narrows by its clauses; anything else is the plain word search.
  const jql = parseJql(f.query);
  // The view's search runs when the box holds words (or nothing); the box's own JQL replaces it.
  const viewQ = !looksJql(f.query.trim()) ? f.viewJql?.trim() ?? "" : "";
  const viewParsed = viewQ ? parseJql(viewQ) : null;
  // The site's answer wins while it is for this query; the local reading is the fallback when it failed or is on its way.
  const site = f.site && f.site.q === (viewQ || f.query.trim()) ? new Set(f.site.keys) : null;
  const text = (t: ProviderTask): boolean => (jql ? matchesJql(t, jql) : matchesQuery(t, f.query));
  const local = (t: ProviderTask): boolean => text(t) && (!viewParsed || matchesJql(t, viewParsed));
  // A capped answer cannot prove a card here does not match, so it never hides one the local reading keeps.
  const capped = !!f.site?.truncated;
  const matches = (t: ProviderTask): boolean => (site ? (viewQ ? site.has(keyOf(t)) && text(t) : site.has(keyOf(t)) || (capped && local(t))) : local(t));
  const spaceSet = f.spaces?.length ? new Set(f.spaces.map((s) => s.toUpperCase())) : null;
  const assigneeSet = f.assigneePick.length ? new Set(f.assigneePick) : null;
  // Mine and the people chip read as one group, pressed together: a card shows when it answers EITHER (you, or any of them),
  // not only one that answers both - "Mine" + a teammate's chip means "mine or theirs", never "mine and also theirs".
  const whoMatch = (t: ProviderTask): boolean =>
    !f.mineOnly && !assigneeSet ? true : (f.mineOnly && !!t.mine) || (!!assigneeSet && assigneeIdsOf(t).some((id) => assigneeSet.has(id)));
  return applyBuilt([...cards], f.built).filter((t) =>
    (f.statusPick.length ? f.statusPick.includes(t.status) : (f.showDone || t.statusKind !== "done"))
    && sprintPasses(t, f.sprintPick ?? [], cards, f.nextSprints)
    && (!f.sprintOnly || (f.sprintOnly === RUNNING_SPRINTS ? !!t.sprintActive : t.sprint === f.sprintOnly))
    && (!spaceSet || spaceSet.has(spaceOf(t)))
    && whoMatch(t)
    && (!f.tagPick.length || (f.tagAll ? f.tagPick.every((g) => t.tags.includes(g)) : f.tagPick.some((g) => t.tags.includes(g))))
    && (!f.priorityPick?.length || f.priorityPick.includes(t.priority ?? "none"))
    && passesNot(t, f.notPick, cards, f.nextSprints)
    && passesEpicComponent(t, f.epicPick, f.componentPick, cards)
    && (!f.readyOnly || !blockersOf(t, byId).length)
    && (!f.blockedOnly || blockersOf(t, byId).length > 0)
    && (!f.flaggedOnly || !!t.flagged)
    && (!f.dueOnly || !!t.due)
    && (!f.quietOnly || quietDays(t) > 0)
    && (!f.liveOnly || (f.live ?? []).includes(keyOf(t).toUpperCase()))
    && (!f.needsOnly || (f.needs ?? []).includes(keyOf(t).toUpperCase()))
    && matches(t));
}

/**
 * Whether the cards here may be fewer than the site holds: the board's own read was cut, or the search in force (a Team
 * view is one) stopped at its page or 1000-card cap. Measured: "1000 of 1000" with no sign of the cap, and "50 of 50" for
 * a search's first page, because only the board's read said so. A capped answer for another search is not this read's.
 */
export function readIsCapped(boardTruncated: boolean, site: { q: string; truncated?: boolean } | null | undefined, typed: string): boolean {
  return boardTruncated || (!!site && site.q === typed && !!site.truncated);
}

/**
 * A truncated first page with a filter on keeps loading: the site is asked again for every page (up to its cap) so the
 * filtered count and cards are the site's whole answer, not the first page's. Without a filter nothing changes: the
 * first page stands until Enter asks for all of them.
 */
export function walkWanted(entered: boolean, narrowed: boolean, site: { q: string; truncated?: boolean } | null | undefined, typed: string): boolean {
  return entered || (narrowed && !!site && site.q === typed && !!site.truncated);
}

/**
 * The board read says "more behind it" when its backlog page was cut. With Current sprint on, the backlog is not in the
 * answer anyway, so a read whose only cut part is the backlog is whole for this view. Measured: 297 cards, 297 in Jira's
 * own list for the same sprint and people, and the footer said "297 of 297+ and more behind it".
 */
export const boardIsCut = (truncated: boolean, backlogCut: boolean, sprintOnly: boolean): boolean => truncated && !(backlogCut && sprintOnly);

/**
 * The count's basis. With a filter on and the site's answer for this search in hand, the count is the site's own: whole
 * ("288 of 288", no plus), or capped with the number it says it holds ("288 of 1342"). Never "N of N+" there, because the
 * cards the board read first were only a part. Otherwise the board's reading stands.
 */
export function countBasis(narrowed: boolean, boardTruncated: boolean, site: { q: string; truncated?: boolean; total?: number } | null | undefined, typed: string, cards: number): { total: number; truncated: boolean } {
  const mine = !!site && site.q === typed;
  if (narrowed && mine && !site.truncated) return { total: cards, truncated: false };
  if (narrowed && mine && site.total !== undefined) return { total: site.total, truncated: false };
  return { total: cards, truncated: readIsCapped(boardTruncated, site, typed) };
}

export function laneCounts(all: readonly ProviderTask[], shown: number, total: number = all.length): JiraListCounts {
  return {
    total,
    shown,
    open: all.filter((t) => t.statusKind !== "done").length,
    done: all.filter((t) => t.statusKind === "done").length,
    mine: all.filter((t) => t.mine && t.statusKind !== "done").length,
    ready: readyCount([...all]),
  };
}

export function lanesOf(cards: readonly ProviderTask[], statuses: readonly ListStatus[], scope?: readonly string[]): JiraLane[] {
  return groupByStatus(cards, statuses, (list) => sortedByOrder(list), scope).map((g) => ({
    status: g.status, color: g.color, done: g.done, points: g.points, cards: g.rows,
  }));
}

/** The status a card in `status` moves on to: the next column right of it that is a step of the flow (not `offFlow`), or null from an off-flow column or the last one. */
export function nextFlowStatus(columns: readonly string[], status: string, statuses: readonly ListStatus[]): string | null {
  const off = new Set(statuses.filter((s) => s.offFlow).map((s) => s.status));
  const i = columns.indexOf(status);
  if (i < 0 || off.has(status)) return null;
  return columns.slice(i + 1).find((c) => !off.has(c)) ?? null;
}

/** "Looked up": the cards found by id that are on no board, drawn as one flat lane in place of the view. The filters do not apply to them. */
export function lookedModel(model: JiraListModel, cards: readonly ProviderTask[]): JiraListModel {
  const own = [...cards];
  const lane: JiraLane = { key: "looked", status: "Looked up", color: undefined, done: false, points: 0, cards: own, mark: "backlog", flat: true, folded: false };
  return { ...model, phase: own.length ? "ready" : "empty", cards: own, lanes: [lane], counts: { ...model.counts, total: own.length, shown: own.length }, assigned: false };
}

/** "Is not": a card is hidden when it holds any value left out in any group. No exclusions passes everything. */
export function passesNot(t: ProviderTask, not: Record<string, string[]> | undefined, cards: readonly ProviderTask[], nextSprints?: readonly string[]): boolean {
  if (!not) return true;
  const out = (g: string): string[] => not[g] ?? [];
  if (out("status").includes(t.status)) return false;
  if (out("sprint").length && sprintPasses(t, out("sprint"), cards, nextSprints)) return false;
  if (out("people").length && assigneeIdsOf(t).some((id) => out("people").includes(id))) return false;
  if (out("space").length && out("space").some((s) => s.toUpperCase() === spaceOf(t))) return false;
  if (out("epic").includes(epicKeyOf(t, cards))) return false;
  if (out("label").some((g) => t.tags.includes(g))) return false;
  if (out("component").some((c) => (t.components ?? []).includes(c))) return false;
  if (out("priority").includes(t.priority ?? "none")) return false;
  return true;
}
