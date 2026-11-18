/*
 * The lanes of the Jira list and the rows inside them, decided apart from the screen so each rule can be asserted without
 * a renderer: how cards are grouped (status, project, sprint, priority, person, area, then a second level), which lane is the
 * Backlog, which sub-tasks nest under which parent, how many rows of a long lane are drawn, and which
 * columns fit the width.
 *
 * Ceilings, on purpose: a sub-task nests only under a parent that sits in the same lane (a sub-task of another status stays a
 * row of its own lane, so no lane count lies, and opening the parent repeats it there); the second grouping is one level; the
 * paging is by top-level row. A board's search leaves sub-tasks out, so the chevron is the way in: the count on the card says
 * whether there is one, and what it opens is the card's own read, one per parent (lib/jiraSubtasks.ts).
 */
import type { JiraBoardEpic, ListStatus, ProviderTask } from "../../../../../shared/providers.ts";
import { since } from "../../../lib/format.ts";
import { groupByStatus } from "../../../lib/boardGroups.ts";
import { epicTone, sortedByOrder, splitSprint } from "../../../lib/jiraBoardContext.ts";
import { groupAreas, groupKeyed, type GroupBy, type ThenBy } from "../../../lib/jiraAreas.ts";
import { EMPTY } from "../../tasks/filters.ts";
import { SPRINTS } from "../JiraAreas.tsx";
import type { JiraLane, JiraListFilters, JiraListPhase } from "./model.ts";
import { RUNNING_SPRINTS } from "./model.ts";

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

/**
 * Whether a parent row wears a chevron: the count on its card, less the sub-tasks its own lane already draws under it (a text
 * search does return sub-tasks, and a chevron that opens nothing is a dead control). A sub-task is never a parent here.
 */
export const opensSubtasks = (t: Pick<ProviderTask, "subtasks" | "issueType">, drawn = 0): boolean => !isSubtask(t) && (t.subtasks ?? 0) > drawn;

/**
 * The rows a parent draws when opened: its own read's sub-tasks, less the ones the lane already draws under it, so a child is
 * never two rows under one parent. Each keeps its own key and status, because the lane's status is the parent's.
 */
export function childRows(fetched: readonly ProviderTask[], drawn: readonly ProviderTask[]): ProviderTask[] {
  const seen = new Set(drawn.map((t) => t.id));
  return fetched.filter((t) => !seen.has(t.id));
}

/**
 * The Epic column of one row, as the card it names. A sub-task's own `parent` is the row whose chevron opened it, not an
 * epic, so it wears the epic of the row above it — or the epic Jira put on the sub-task itself, where a site does that.
 */
export function epicColumn(t: Pick<ProviderTask, "parent" | "issueType">, above?: Pick<ProviderTask, "parent" | "issueType">): ProviderTask["parent"] | undefined {
  const own = t.parent && t.parent.type !== "Sub-task" ? t.parent : undefined;
  if (!isSubtask(t) || own?.type === "Epic") return own;
  const sits = above && !isSubtask(above) ? above.parent : undefined;
  return sits && sits.type !== "Sub-task" ? sits : undefined;
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

/** How a lane's cards are ordered: the site's own rank (the default), or by key, priority, due date or agent. */
export type LaneSort = "rank" | "key" | "priority" | "due" | "agent";
export const LANE_SORTS: readonly { id: LaneSort; label: string; hint: string }[] = [
  { id: "rank", label: "Rank", hint: "The order Jira keeps" },
  { id: "key", label: "Key", hint: "ORB-1 before ORB-10" },
  { id: "priority", label: "Priority", hint: "Urgent first" },
  { id: "due", label: "Due date", hint: "Soonest first, none last" },
  { id: "agent", label: "Agent", hint: "Waiting on you first, then stalled, then working" },
];
const PRIO = ["urgent", "high", "normal", "low"];
const keyParts = (t: ProviderTask): [string, number] => { const m = /^(.*?)-?(\d+)$/.exec(keyOf(t)); return m ? [m[1]!, Number(m[2])] : [keyOf(t), 0]; };
/** The cards of a lane in `by` order. Rank keeps the order given; the others are stable, and a card without the value goes last.
 *  `agentRank` is what "agent" sorts by (0 waiting, 1 stalled or errored, 2 working, 3 none): the fleet is the caller's, this stays pure. */
export function sortCards(cards: readonly ProviderTask[], by: LaneSort, agentRank: (t: ProviderTask) => number = () => 3): ProviderTask[] {
  if (by === "rank") return [...cards];
  const cmp: Record<Exclude<LaneSort, "rank">, (a: ProviderTask, b: ProviderTask) => number> = {
    key: (a, b) => { const [pa, na] = keyParts(a), [pb, nb] = keyParts(b); return pa.localeCompare(pb) || na - nb; },
    priority: (a, b) => (a.priority ? PRIO.indexOf(a.priority) : 9) - (b.priority ? PRIO.indexOf(b.priority) : 9),
    due: (a, b) => (a.due ? (b.due ? a.due.localeCompare(b.due) : -1) : b.due ? 1 : 0),
    agent: (a, b) => agentRank(a) - agentRank(b),
  };
  return [...cards].sort(cmp[by]);
}

export interface LaneInput {
  /** The cards to draw, after every filter. */
  cards: readonly ProviderTask[];
  statuses: readonly ListStatus[];
  /** The spaces (project keys) the space filter narrows to: the columns are the workflow of these only. None is every space. */
  spaces?: readonly string[];
  group: GroupBy;
  /** By agent: where each card stands with its agents (`agentStateOf`). Without it every card is "No agent". */
  agentOf?: (t: ProviderTask) => string | null;
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

function statusLanes(cards: readonly ProviderTask[], statuses: readonly ListStatus[], parent = "", flat = false, spaces?: readonly string[]): JiraLane[] {
  return groupByStatus(cards, statuses, (list) => sortedByOrder(list), spaces).map((g) => lane({
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
  // An epic is a container the sidebar lists with its progress, not a card: it never takes a row, in any grouping.
  const isEpic = (t: ProviderTask): boolean => (t.issueType ?? "").toLowerCase() === "epic";
  const ordered = sortedByOrder(i.cards.filter((t) => !isEpic(t)));
  // A status lane empty only because its epics were left out is not drawn: the status was listed for the epic's sake
  // ("Assigned to me" builds its statuses from the cards). An empty status the board itself has stays, as before.
  const held = new Set(ordered.map((t) => t.status.toLowerCase()));
  const epicOnly = new Set(i.cards.filter(isEpic).map((t) => t.status.toLowerCase()).filter((s) => !held.has(s)));
  const split = !i.sprintView && i.sprintName ? splitSprint(ordered, i.sprintName) : null;
  const by: GroupBy = i.group;
  let out: JiraLane[];
  if (by === "status") {
    out = statusLanes(split ? split.inSprint : ordered, i.statuses, "", false, i.spaces).filter((l) => l.cards.length || !(l.done || epicOnly.has(l.status.toLowerCase())));
    if (split?.backlog.length) out.push(lane({ key: "backlog", status: "Backlog", color: undefined, mark: "backlog", flat: true, folded: true, cards: split.backlog }));
  } else if (by === "project") {
    const projects = new Map<string, ProviderTask[]>();
    for (const t of ordered) (projects.get(t.list || "Elsewhere") ?? projects.set(t.list || "Elsewhere", []).get(t.list || "Elsewhere")!).push(t);
    out = [...projects].map(([name, cards]) => lane({ key: `project:${name.toLowerCase()}`, status: name, color: undefined, mark: "project", flat: true, cards }));
  } else if (by === "area") {
    out = areaLanes(ordered, i.epics);
  } else {
    const groups = groupKeyed(ordered, by, i.agentOf);
    // By agent, No agent is most of the board and the least of the question: folded, while another lane has cards. A fold set by hand wins.
    const foldNone = by === "agent" && groups.length > 1;
    out = groups.map((g) => lane({
      key: `${by}:${g.key || "none"}`, status: g.title, color: by === "priority" ? PRIORITY_COLOR[g.key] : undefined, mark: by, flat: true, cards: g.rows,
      ...(foldNone && g.key === "" ? { folded: true } : {}),
    }));
  }
  if (i.thenGroup === "none") return out;
  return out.map((l) => {
    const sub = i.thenGroup === "area" && by === "status"
      ? areaLanes(l.cards, i.epics, `${l.key}/`)
      : i.thenGroup === "status" && by !== "status" ? statusLanes(l.cards, i.statuses, `${l.key}/`, false, i.spaces).filter((s) => s.cards.length) : [];
    return sub.length ? { ...l, sub } : l;
  });
}

/** The sprint or the epic of a card, under its title; the name of the column is gone, the text stays. */
export function thirdColumn(o: { assigned?: boolean; group: GroupBy; cards: readonly ProviderTask[] }): "Sprint" | "Epic" {
  if (o.assigned || o.group === "area") return "Epic";
  return o.cards.some((t) => t.sprint) ? "Sprint" : "Epic";
}

/* The first track is the chevron gutter. It is on every row, so a row with sub-tasks to open and one without share every
   column, and opening a parent moves none of them. Then the mockup's six: Key, Card, Status, Agent, PR, Who. */
export interface Cols { status: boolean; agent: boolean; pr: boolean; who: boolean; template: string; /** The PR (and the agent, when it has no column) sit under the card title. */ stacked: boolean }
const TRACK = { twist: 42, key: 128, title: 260, status: 148, agent: 152, pr: 156, who: 56, gap: 12, chrome: 88 };
/** Under this list width the PR leaves its column for the line under the title (the mockup's P38). */
export const ROW_FOLD = 900;
const DROP_ORDER = ["agent", "who", "pr"] as const;

/** The columns that fit a list `width` px wide (its scroller, padding included); the agent is the first to go. Below that the row is key and title. */
export function columnsFor(width: number): Cols {
  const on = { status: true, agent: true, pr: true, who: true };
  const need = () => {
    const tracks = [TRACK.twist, TRACK.key, TRACK.title, ...(on.status ? [TRACK.status] : []), ...(on.agent ? [TRACK.agent] : []), ...(on.pr ? [TRACK.pr] : []), ...(on.who ? [TRACK.who] : [])];
    return tracks.reduce((n, w) => n + w, 0) + (tracks.length - 1) * TRACK.gap + TRACK.chrome;
  };
  if (width && width < ROW_FOLD) on.status = width >= 640;
  for (const c of DROP_ORDER) if (width && need() > width) on[c] = false;
  const stacked = !!width && (!on.pr || !on.agent);
  const t = [`${TRACK.twist}px`, `${TRACK.key}px`, `minmax(${TRACK.title}px,1fr)`];
  if (on.status) t.push(`${TRACK.status}px`);
  if (on.agent) t.push(`${TRACK.agent}px`);
  if (on.pr) t.push(`${TRACK.pr}px`);
  if (on.who) t.push(`${TRACK.who}px`);
  return { ...on, template: t.join(" "), stacked };
}

/** The workflow position of a card as `done` of `of` segments: its status's place among the board's statuses, the last one being done. */
export function progressOf(t: Pick<ProviderTask, "status" | "statusKind">, statuses: readonly { status: string }[]): { done: number; of: number } {
  const of = Math.min(Math.max(statuses.length, 2), 8);
  if (t.statusKind === "done") return { done: of, of };
  const at = statuses.findIndex((s) => s.status === t.status);
  if (at < 0 || statuses.length < 2) return { done: 0, of };
  return { done: Math.max(1, Math.round(((at + 1) / statuses.length) * of)), of };
}

/** `work`: the step is read on the card's Work tab (an agent's question), not on the card itself. */
export interface NextStep { id: string; label: string; work?: boolean }
/** The one thing an epic's header offers next: an agent stopped on you first (nothing moves until it is answered), then a
 *  failing check, then a card waiting for review, then one waiting for QA. */
export function nextStep(cards: readonly ProviderTask[], ci: (t: ProviderTask) => "failing" | "passing" | "running" | "unknown", waiting: (t: ProviderTask) => boolean = () => false, stuck: (t: ProviderTask) => boolean = () => false): NextStep | null {
  const open = cards.filter((t) => t.statusKind !== "done");
  const asks = open.find(waiting);
  if (asks) return { id: asks.id, label: `Answer agent on ${keyOf(asks)}`, work: true };
  /* A stalled or errored agent is next: nothing moves on that card until somebody reads why it stopped. */
  const stopped = open.find(stuck);
  if (stopped) return { id: stopped.id, label: `Check agent on ${keyOf(stopped)}`, work: true };
  const failing = open.find((t) => ci(t) === "failing");
  if (failing) return { id: failing.id, label: `Fix CI ${keyOf(failing)}` };
  const word = (t: ProviderTask) => t.status.toLowerCase();
  const review = open.find((t) => /review/.test(word(t)));
  if (review) return { id: review.id, label: `Review ${keyOf(review)}` };
  const qa = open.find((t) => /\bqa\b|test/.test(word(t)));
  if (qa) return { id: qa.id, label: `QA ${keyOf(qa)}` };
  return null;
}

/** What the lane's menu and its Copy action work on: the keys of every card in it, sub-tasks included. */
export const laneKeys = (l: JiraLane): string[] => l.cards.map(keyOf);

/** A tab is read on the site as its own search; until that answer lands the cards on screen are the previous tab's, so they are not drawn as this one's. */
export function awaitingTabRead(o: { fromView: boolean; typed: string; siteQ: string | undefined; failed: boolean }): boolean {
  return o.fromView && !!o.typed && o.siteQ !== o.typed && !o.failed;
}

/** What the list area shows instead of (or before) lanes. */
export type ListState = "loading" | "not-connected" | "failed" | "empty-space" | "epic-0" | "no-match" | "lanes";
export function listState(o: { phase: JiraListPhase; error: string | undefined; shown: number; areaId: string | null | undefined }): ListState {
  if (o.phase === "loading") return "loading";
  if (o.phase === "failed") return /not connected/i.test(o.error ?? "") ? "not-connected" : "failed";
  if (o.phase === "empty") return o.areaId && o.areaId !== SPRINTS ? "epic-0" : "empty-space";
  return o.shown === 0 ? "no-match" : "lanes";
}

/** Every narrowing off. The grouping and the Show-done switch are not filters and stay. */
export const CLEARED: Partial<JiraListFilters> = { query: "", mineOnly: false, readyOnly: false, tagPick: [], statusPick: [], built: EMPTY, sprintOnly: null, sprintPick: [], priorityPick: [], notPick: {}, tagAll: false, quick: [], assigneePick: [], epicPick: [], componentPick: [], spaces: [], flaggedOnly: false, blockedOnly: false, dueOnly: false, liveOnly: false, needsOnly: false, quietOnly: false };
export const filtering = (f: JiraListFilters): boolean => narrowedBy(f).length > 0;

/** What narrows the list, in words, for the empty state: "Mine", "2 labels", "Current sprint". */
export function narrowedBy(f: JiraListFilters): string[] {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return [
    f.query.trim() ? `"${f.query.trim()}"` : "",
    f.mineOnly ? "Mine" : "",
    f.spaces?.length ? n(f.spaces.length, "space", "spaces") : "",
    f.flaggedOnly ? "Flagged" : "",
    f.blockedOnly ? "Blocked" : "",
    f.dueOnly ? "Has due date" : "",
    f.quietOnly ? "Quiet 14 days" : "",
    f.liveOnly ? "Live worker" : "",
    f.needsOnly ? "Needs you" : "",
    f.readyOnly ? "Ready" : "",
    f.assigneePick.length ? n(f.assigneePick.length, "person", "people") : "",
    f.statusPick.length ? n(f.statusPick.length, "status", "statuses") : "",
    f.tagPick.length ? n(f.tagPick.length, "label", "labels") : "",
    f.epicPick.length ? n(f.epicPick.length, "epic", "epics") : "",
    f.componentPick.length ? n(f.componentPick.length, "component", "components") : "",
    f.priorityPick?.length ? n(f.priorityPick.length, "priority", "priorities") : "",
    f.quick.length ? n(f.quick.length, "quick filter", "quick filters") : "",
    f.sprintOnly ? (f.sprintOnly === RUNNING_SPRINTS ? "Current sprint" : f.sprintOnly) : "",
    f.built.rules.length ? n(f.built.rules.length, "rule", "rules") : "",
  ].filter(Boolean);
}

/** The strip under the chips when a read failed but cards are on screen: what failed and how old the cards are. Null where nothing is wrong. */
export function staleNote(m: { read: "fine" | "retrying" | "stale"; phase: JiraListPhase; error: string | undefined; throttled: boolean; unauthorised: boolean; at: number }): { tone: "warn" | "err"; text: string } | null {
  if (m.read === "fine" || m.phase !== "ready") return null;
  const age = m.at ? `read ${since(m.at)}` : "from an earlier read";
  const why = m.unauthorised ? "Jira refused the token." : m.throttled ? "Jira asked us to slow down." : `${(m.error ?? "The read failed").replace(/[.\s]+$/, "")}.`;
  return m.read === "stale"
    ? { tone: "err", text: `${why} These cards were ${age} and may be out of date.` }
    : { tone: "warn", text: `${why} Showing the cards ${age}.` };
}
