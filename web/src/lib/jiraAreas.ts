/*
 * The decisions the Areas tree and the Group control make, apart from any
 * screen so each can be asserted without a renderer: which epics are areas and
 * what they hold, an Area's own cards, how a board's cards group by something
 * other than status, and what is remembered of that choice.
 *
 * Ceilings, on purpose: an area is an epic and nothing below it (a sub-area is
 * the next thing after this and is not here); the counts come from the one read
 * the server keeps (`JiraBoardAreas`), so a project with more cards than it
 * holds says "at least"; a person is the first assignee of a card.
 */
import type { JiraBoardEpic, ProviderTask } from "../../../shared/providers.ts";
import { groupByParent, type ParentGroup } from "./jiraBoardContext.ts";

export type GroupBy = "status" | "area" | "sprint" | "priority" | "person";
/** What each group is split by next. `area` under status is the Sprint view's outline. */
export type ThenBy = "none" | "status" | "area";
export interface GroupPref { by: GroupBy; split: ThenBy }

export const GROUP_BY: readonly { id: GroupBy; label: string }[] = [
  { id: "status", label: "Status" }, { id: "area", label: "Area" }, { id: "sprint", label: "Sprint" },
  { id: "priority", label: "Priority" }, { id: "person", label: "Person" },
];

/** The sprint view is an outline of status then area; any other board starts flat. */
export const defaultPref = (sprintView: boolean): GroupPref => ({ by: "status", split: sprintView ? "area" : "none" });

const BYS = new Set<string>(GROUP_BY.map((g) => g.id));

/**
 * What was kept for a board, read back. The first version kept a bare word (`status`, `parent`); it is honoured, with
 * `parent` now spelled `area`. Anything unreadable is the default, and a choice that needs areas on a board with none
 * is the default too. the second level cannot repeat `by`.
 */
export function parsePref(raw: string | null | undefined, hasAreas: boolean, fallback: GroupPref): GroupPref {
  if (!raw) return fallback;
  let by: string = raw;
  let split: string = fallback.split;
  if (raw.startsWith("{")) {
    try { const o = JSON.parse(raw) as { by?: unknown; split?: unknown }; by = String(o.by ?? ""); split = String(o.split ?? "none"); } catch { return fallback; }
  } else { by = raw === "parent" ? "area" : raw; split = "none"; }
  if (!BYS.has(by) || (by === "area" && !hasAreas)) return fallback;
  // The one second level a grouping offers: area under status (where there are areas), status under anything else.
  const ok = by === "status" ? split === "area" && hasAreas : split === "status";
  return { by: by as GroupBy, split: ok ? (split as ThenBy) : "none" };
}

export const prefText = (p: GroupPref): string => JSON.stringify(p);

export { areaName, areaRows, type AreaRow } from "../../../shared/jiraAreas.ts";
import { areaName } from "../../../shared/jiraAreas.ts";

/** An Area's cards, in the order the read gave them. */
export const areaCards = (tasks: readonly ProviderTask[], key: string): ProviderTask[] => tasks.filter((t) => t.parent?.key === key);

/** The header line over an Area: `5 in Sprint 1 of 60`, or just the count where no sprint is active. */
export function areaLine(total: number, inSprint: number, sprintName: string | undefined, truncated: boolean): string {
  const of = `${truncated ? "at least " : ""}${total}`;
  return sprintName ? `${inSprint} in ${sprintName} of ${of}` : `${of} card${total === 1 ? "" : "s"}`;
}

export interface KeyGroup { key: string; title: string; rows: ProviderTask[]; done: number }

const PRIORITY_ORDER = ["urgent", "high", "normal", "low"] as const;
const PRIORITY_TITLE: Record<string, string> = { urgent: "Urgent", high: "High", normal: "Medium", low: "Low", none: "No priority" };

/**
 * The cards under each sprint, priority or person, in a fixed order that does not depend on which card came first: a
 * priority by its weight, a sprint by name, a person by name, and the cards with none of it last. Status and area are
 * the board's own (`groupByStatus`, `groupByParent`).
 */
export function groupKeyed(rows: readonly ProviderTask[], by: "sprint" | "priority" | "person"): KeyGroup[] {
  const by_ = new Map<string, KeyGroup>();
  const put = (key: string, title: string, t: ProviderTask) => {
    const g = by_.get(key) ?? by_.set(key, { key, title, rows: [], done: 0 }).get(key)!;
    g.rows.push(t);
    if (t.statusKind === "done") g.done++;
  };
  for (const t of rows) {
    if (by === "sprint") put(t.sprint || "", t.sprint || "No sprint", t);
    else if (by === "priority") put(t.priority ?? "none", PRIORITY_TITLE[t.priority ?? "none"]!, t);
    else if (t.assignees.length) for (const a of t.assignees.slice(0, 1)) put(a, a, t);
    else put("", "Unassigned", t);
  }
  const rank = (g: KeyGroup) => (by === "priority" ? (g.key === "none" ? 99 : PRIORITY_ORDER.indexOf(g.key as (typeof PRIORITY_ORDER)[number])) : 0);
  return [...by_.values()].sort((a, b) => {
    const empty = (g: KeyGroup) => (by === "priority" ? g.key === "none" : g.key === "");
    return Number(empty(a)) - Number(empty(b)) || rank(a) - rank(b) || a.title.localeCompare(b.title);
  });
}

/** The area groups of some cards, headed by the epic's own name. */
export function groupAreas(rows: readonly ProviderTask[], epics: readonly JiraBoardEpic[]): ParentGroup[] {
  const names = new Map(epics.map((e) => [e.key, areaName(e.name)]));
  return groupByParent(rows).map((g) => (g.key ? { ...g, title: names.get(g.key) ?? g.title } : { ...g, title: "No area" }));
}
