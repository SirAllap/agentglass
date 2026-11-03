/*
 * The lanes of the Jira list and the rows inside them, decided apart from the screen so each rule can be asserted without
 * a renderer: how cards are grouped (status, project, sprint, priority, person, area, then a second level), which lane is the
 * Backlog, which sub-tasks nest under which parent, how many rows of a long lane are drawn, and which
 * columns fit the width.
 *
 * Ceilings, on purpose: a sub-task nests only under a parent that sits in the same lane (a sub-task of another status stays a
 * row of its own lane, so no lane count lies); the second grouping is one level; the paging is by top-level row.
 */
import type { JiraBoardEpic, ListStatus, ProviderTask } from "../../../../../shared/providers.ts";
import { since } from "../../../lib/format.ts";
import { groupByStatus } from "../../../lib/boardGroups.ts";
import { epicTone, sortedByOrder, splitSprint } from "../../../lib/jiraBoardContext.ts";
import { groupAreas, groupKeyed, type GroupBy, type ThenBy } from "../../../lib/jiraAreas.ts";
import { EMPTY } from "../../tasks/filters.ts";
import { SPRINTS } from "../JiraAreas.tsx";
import type { JiraLane, JiraListFilters, JiraListPhase } from "./model.ts";

export const keyOf = (t: Pick<ProviderTask, "customId" | "id">): string => t.customId ?? t.id;
export const isSubtask = (t: Pick<ProviderTask, "issueType">): boolean => /^sub-?task$/i.test((t.issueType ?? "").replace(/\s+/g, ""));

export interface RowEntry { card: ProviderTask; subs: ProviderTask[] }

/** The rows of a lane: a sub-task goes under its parent when the parent is in the same list; otherwise it keeps its place as a row of its own. */
export function nestSubtasks(cards: readonly ProviderTask[]): RowEntry[] {
  const parents = new Map<string, RowEntry>();
  for (const t of cards) if (!isSubtask(t)) parents.set(keyOf(t), { card: t, subs: [] });
  const out: RowEntry[] = [];
  for (const t of cards) {
    if (!isSubtask(t)) { out.push(parents.get(keyOf(t))!); continue; }
    const home = t.parent ? parents.get(t.parent.key) : undefined;
    if (home) home.subs.push(t); else out.push({ card: t, subs: [] });
  }
  return out;
}

/** A long lane draws its first rows and asks for the rest. Up to FULL_UP_TO rows it draws them all. */
export const FIRST_PAGE = 8;
export const MORE_PAGE = 40;
export const FULL_UP_TO = 24;
/** How many top-level rows of `total` are drawn after `more` extra rows were asked for. */
export const visibleRows = (total: number, more: number): number => (total <= FULL_UP_TO ? total : Math.min(total, FIRST_PAGE + more));
/** What the dashed button says: how many the next press adds and how many stay behind after it. */
export function morePage(total: number, shown: number): { step: number; left: number } | null {
  if (shown >= total) return null;
  const step = Math.min(MORE_PAGE, total - shown);
  return { step, left: total - shown - step };
}

/** How a lane's cards are ordered: the site's own rank (the default), or by key, priority or due date. */
export type LaneSort = "rank" | "key" | "priority" | "due";
export const LANE_SORTS: readonly { id: LaneSort; label: string; hint: string }[] = [
  { id: "rank", label: "Rank", hint: "The order Jira keeps" },
  { id: "key", label: "Key", hint: "ORB-1 before ORB-10" },
  { id: "priority", label: "Priority", hint: "Urgent first" },
  { id: "due", label: "Due date", hint: "Soonest first, none last" },
];
const PRIO = ["urgent", "high", "normal", "low"];
const keyParts = (t: ProviderTask): [string, number] => { const m = /^(.*?)-?(\d+)$/.exec(keyOf(t)); return m ? [m[1]!, Number(m[2])] : [keyOf(t), 0]; };
/** The cards of a lane in `by` order. Rank keeps the order given; the others are stable, and a card without the value goes last. */
export function sortCards(cards: readonly ProviderTask[], by: LaneSort): ProviderTask[] {
  if (by === "rank") return [...cards];
  const cmp: Record<Exclude<LaneSort, "rank">, (a: ProviderTask, b: ProviderTask) => number> = {
    key: (a, b) => { const [pa, na] = keyParts(a), [pb, nb] = keyParts(b); return pa.localeCompare(pb) || na - nb; },
    priority: (a, b) => (a.priority ? PRIO.indexOf(a.priority) : 9) - (b.priority ? PRIO.indexOf(b.priority) : 9),
    due: (a, b) => (a.due ? (b.due ? a.due.localeCompare(b.due) : -1) : b.due ? 1 : 0),
  };
  return [...cards].sort(cmp[by]);
}

export interface LaneInput {
  /** The cards to draw, after every filter. */
  cards: readonly ProviderTask[];
  statuses: readonly ListStatus[];
  group: GroupBy;
  thenGroup: ThenBy;
  epics: readonly JiraBoardEpic[];
  /** The active sprint's name when the board has one and no epic is open: the rest is the Backlog. */
  sprintName?: string | undefined;
  /** The sprint's own page: the cards are the sprint's already, so there is no Backlog. */
  sprintView?: boolean;
  /** "Assigned to me": cards from many projects, lanes are the projects. */
  assigned?: boolean;
}

const sum = (cards: readonly ProviderTask[]): number => cards.reduce((n, t) => n + (t.points ?? 0), 0);
const PRIORITY_COLOR: Record<string, string> = {
  urgent: "var(--prio-urgent)", high: "var(--prio-high)", normal: "var(--prio-normal)", low: "var(--prio-low)",
};

function lane(l: Omit<JiraLane, "points" | "done"> & { done?: boolean }, parent = ""): JiraLane {
  return { ...l, key: `${parent}${l.key}`, done: !!l.done, points: sum(l.cards) };
}

function statusLanes(cards: readonly ProviderTask[], statuses: readonly ListStatus[], parent = "", flat = false): JiraLane[] {
  return groupByStatus(cards, statuses, (list) => sortedByOrder(list)).map((g) => lane({
    key: `status:${g.status.toLowerCase()}`, status: g.status, color: g.color, done: g.done, mark: "status", flat, cards: g.rows,
  }, parent));
}

function areaLanes(cards: readonly ProviderTask[], epics: readonly JiraBoardEpic[], parent = ""): JiraLane[] {
  const colors = new Map(epics.map((e) => [e.key, e.color]));
  return groupAreas(cards, epics).map((g) => lane({
    key: `area:${g.key || "none"}`, status: g.title, color: g.key ? `var(${epicTone(colors.get(g.key))})` : undefined, mark: "area", flat: true, cards: g.rows,
  }, parent));
}

/**
 * The lanes of a view. Status is the board's own workflow (empty lanes kept, finished lanes only when they hold something);
 * every other grouping is a lane per sprint, priority, person or epic, and a lane that does not say the status makes its rows wear a
 * quiet status dot (`flat`). "Assigned to me" is one lane per project. `thenGroup` splits each lane once more.
 */
export function buildLanes(i: LaneInput): JiraLane[] {
  const ordered = sortedByOrder(i.cards);
  const split = !i.sprintView && i.sprintName ? splitSprint(ordered, i.sprintName) : null;
  const by: GroupBy | "project" = i.assigned && i.group === "status" ? "project" : i.group;
  let out: JiraLane[];
  if (by === "status") {
    out = statusLanes(split ? split.inSprint : ordered, i.statuses).filter((l) => !(l.done && !l.cards.length));
    if (split?.backlog.length) out.push(lane({ key: "backlog", status: "Backlog", color: undefined, mark: "backlog", flat: true, folded: true, cards: split.backlog }));
  } else if (by === "project") {
    const projects = new Map<string, ProviderTask[]>();
    for (const t of ordered) (projects.get(t.list || "Elsewhere") ?? projects.set(t.list || "Elsewhere", []).get(t.list || "Elsewhere")!).push(t);
    out = [...projects].map(([name, cards]) => lane({ key: `project:${name.toLowerCase()}`, status: name, color: undefined, mark: "project", flat: true, cards }));
  } else if (by === "area") {
    out = areaLanes(ordered, i.epics);
  } else {
    out = groupKeyed(ordered, by).map((g) => lane({
      key: `${by}:${g.key || "none"}`, status: g.title, color: by === "priority" ? PRIORITY_COLOR[g.key] : undefined, mark: by, flat: true, cards: g.rows,
    }));
  }
  if (i.thenGroup === "none") return out;
  return out.map((l) => {
    const sub = i.thenGroup === "area" && by === "status"
      ? areaLanes(l.cards, i.epics, `${l.key}/`)
      : i.thenGroup === "status" && by !== "status" ? statusLanes(l.cards, i.statuses, `${l.key}/`, false).filter((s) => s.cards.length) : [];
    return sub.length ? { ...l, sub } : l;
  });
}

/** The third column's name: the sprint on a board's own lanes, the epic where the lanes are projects or epics. */
export function thirdColumn(o: { assigned?: boolean; group: GroupBy; cards: readonly ProviderTask[] }): "Sprint" | "Epic" {
  if (o.assigned || o.group === "area") return "Epic";
  return o.cards.some((t) => t.sprint) ? "Sprint" : "Epic";
}

export interface Cols { epic: boolean; pr: boolean; who: boolean; due: boolean; pts: boolean; template: string }
/* Widths of the tracks. The title takes what is left. */
const TRACK = { mark: 22, title: 280, third: 160, pr: 120, who: 96, due: 96, pts: 48, gap: 12, chrome: 88 };
const DROP_ORDER = ["epic", "pts", "who", "pr", "due"] as const;

/** The columns that fit a list `width` px wide (its scroller, padding included); the last to go is Due. Below that the row is the title alone. */
export function columnsFor(width: number): Cols {
  const on = { epic: true, pr: true, who: true, due: true, pts: true };
  const need = () => {
    const tracks = [TRACK.mark, TRACK.title, ...(on.epic ? [TRACK.third] : []), ...(on.pr ? [TRACK.pr] : []), ...(on.who ? [TRACK.who] : []), ...(on.due ? [TRACK.due] : []), ...(on.pts ? [TRACK.pts] : [])];
    return tracks.reduce((n, w) => n + w, 0) + (tracks.length - 1) * TRACK.gap + TRACK.chrome;
  };
  for (const c of DROP_ORDER) if (width && need() > width) on[c] = false;
  const t = [`${TRACK.mark}px`, `minmax(${TRACK.title}px,2fr)`];
  if (on.epic) t.push(`minmax(${TRACK.third}px,1fr)`);
  if (on.pr) t.push(`${TRACK.pr}px`);
  if (on.who) t.push(`${TRACK.who}px`);
  if (on.due) t.push(`${TRACK.due}px`);
  if (on.pts) t.push(`${TRACK.pts}px`);
  return { ...on, template: t.join(" ") };
}

/** What the lane's menu and its Copy action work on: the keys of every card in it, sub-tasks included. */
export const laneKeys = (l: JiraLane): string[] => l.cards.map(keyOf);

/** What the list area shows instead of (or before) lanes. */
export type ListState = "loading" | "not-connected" | "failed" | "empty-space" | "epic-0" | "no-match" | "lanes";
export function listState(o: { phase: JiraListPhase; error: string | undefined; shown: number; areaId: string | null | undefined }): ListState {
  if (o.phase === "loading") return "loading";
  if (o.phase === "failed") return /not connected/i.test(o.error ?? "") ? "not-connected" : "failed";
  if (o.phase === "empty") return o.areaId && o.areaId !== SPRINTS ? "epic-0" : "empty-space";
  return o.shown === 0 ? "no-match" : "lanes";
}

/** Every narrowing off. The grouping and the Show-done switch are not filters and stay. */
export const CLEARED: Partial<JiraListFilters> = { query: "", mineOnly: false, readyOnly: false, tag: null, statusPick: [], built: EMPTY, sprintOnly: null };
export const filtering = (f: JiraListFilters): boolean => !!(f.query.trim() || f.mineOnly || f.readyOnly || f.tag || f.statusPick.length || f.built.rules.length || f.sprintOnly);

/** The strip under the chips when a read failed but cards are on screen: what failed and how old the cards are. Null where nothing is wrong. */
export function staleNote(m: { read: "fine" | "retrying" | "stale"; phase: JiraListPhase; error: string | undefined; throttled: boolean; unauthorised: boolean; at: number }): { tone: "warn" | "err"; text: string } | null {
  if (m.read === "fine" || m.phase !== "ready") return null;
  const age = m.at ? `read ${since(m.at)}` : "from an earlier read";
  const why = m.unauthorised ? "Jira refused the token." : m.throttled ? "Jira asked us to slow down." : `${(m.error ?? "The read failed").replace(/[.\s]+$/, "")}.`;
  return m.read === "stale"
    ? { tone: "err", text: `${why} These cards were ${age} and may be out of date.` }
    : { tone: "warn", text: `${why} Showing the cards ${age}.` };
}
