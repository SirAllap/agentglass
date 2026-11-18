/*
 * The Filters popover (V2) as plain data: the groups on its left rail, the one-line summary each wears, the plain-language
 * sentence on top with one removable part per narrowing, and what clearing a group changes. No renderer here, so a test
 * plays all of it.
 *
 * The sentence is read from the filters, never stored: removing a part is a patch the part carries.
 */
import { assigneeIdsOf, filterCards, spaceOf, type JiraListFilters } from "./model.ts";
import { EMPTY } from "../../tasks/filters.ts";
import { QUICK_TOGGLES } from "./headerModel.ts";
import type { ListStatus, ProviderTask } from "../../../../../shared/providers.ts";
import type { TeamMember } from "../../../lib/jiraTree.ts";
import { PRIORITY_LABEL, componentChoices, epicKeyOf, epicChoices, priorityChoices } from "./facetsModel.ts";
import { CURRENT, NEXT, NONE, sprintRows, sprintSentence, type SprintBoard } from "./sprintModel.ts";
import { statusMenuOf, togglePick } from "./toolbarModel.ts";
import { spaceChoices, toggleSpace } from "./viewsModel.ts";

export type GroupId = "status" | "sprint" | "people" | "space" | "epic" | "label" | "component" | "priority" | "dates" | "signals";

export const GROUPS: readonly { id: GroupId; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "sprint", label: "Sprint" },
  { id: "people", label: "People" },
  { id: "space", label: "Space" },
  { id: "epic", label: "Epic" },
  { id: "label", label: "Label" },
  { id: "component", label: "Component" },
  { id: "priority", label: "Priority" },
  { id: "dates", label: "Dates" },
  { id: "signals", label: "Signals" },
];

/** Groups under the rail's divider: the ones that are toggles, not lists of values. */
export const TOGGLE_GROUPS: readonly GroupId[] = ["dates", "signals"];

/** The signals a card can carry, in the order the pane lists them. Hide-done lives here too (Show done). */
export const SIGNALS: readonly { id: string; label: string }[] = [
  ...QUICK_TOGGLES.filter((q) => q.id !== "dueOnly").map((q) => ({ id: q.id as string, label: q.label as string })),
  { id: "showDone", label: "Show done" },
];

/** What clearing one group changes (the footer's "Clear <group>"). */
export const CLEAR_GROUP: Record<GroupId, Partial<JiraListFilters>> = {
  status: { statusPick: [] },
  sprint: { sprintPick: [], sprintOnly: null },
  people: { assigneePick: [], mineOnly: false },
  space: { spaces: [] },
  epic: { epicPick: [] },
  label: { tagPick: [] },
  component: { componentPick: [] },
  priority: { priorityPick: [] },
  dates: { dueOnly: false },
  signals: { liveOnly: false, needsOnly: false, flaggedOnly: false, blockedOnly: false, quietOnly: false, showDone: false, built: EMPTY },
};

/** The groups whose values can be "is not". */
export const EXCLUDABLE: readonly GroupId[] = ["status", "sprint", "people", "space", "epic", "label", "component", "priority"];
export const notIn = (f: JiraListFilters, g: GroupId): string[] => f.notPick?.[g] ?? [];

/** What clearing a group changes, its "is not" list and Label's all-of included. */
export function clearGroup(f: JiraListFilters, g: GroupId): Partial<JiraListFilters> {
  const { [g]: _gone, ...rest } = f.notPick ?? {};
  return { ...CLEAR_GROUP[g], ...(notIn(f, g).length ? { notPick: rest } : {}), ...(g === "label" ? { tagAll: false } : {}) };
}

export interface Names { epics?: Readonly<Record<string, string>>; people?: Readonly<Record<string, string>> }

const many = (xs: readonly string[], noun: string, shown = 2): string => (xs.length <= shown ? xs.join(" or ") : `${xs.length} ${noun}`);
const signalOn = (f: JiraListFilters): string[] => [
  ...QUICK_TOGGLES.filter((q) => q.id !== "dueOnly" && !!f[q.id]).map((q) => q.label as string),
  ...(f.showDone ? ["Show done"] : []),
  ...(f.built.rules.length ? [`${f.built.rules.length} rule${f.built.rules.length === 1 ? "" : "s"}`] : []),
];
const peopleOf = (f: JiraListFilters, n: Names): string[] => [...(f.mineOnly ? ["me"] : []), ...f.assigneePick.map((id) => n.people?.[id] ?? id)];

/** How many values a group has picked: what the badge on the rail counts. */
export function pickedIn(f: JiraListFilters, g: GroupId): number {
  return picksIn(f, g) + notIn(f, g).length;
}
const picksIn = (f: JiraListFilters, g: GroupId): number => {
  switch (g) {
    case "status": return f.statusPick.length;
    case "sprint": return (f.sprintPick?.length ?? 0) + (f.sprintOnly ? 1 : 0);
    case "people": return f.assigneePick.length + (f.mineOnly ? 1 : 0);
    case "space": return f.spaces?.length ?? 0;
    case "epic": return f.epicPick.length;
    case "label": return f.tagPick.length;
    case "component": return f.componentPick.length;
    case "priority": return f.priorityPick?.length ?? 0;
    case "dates": return f.dueOnly ? 1 : 0;
    case "signals": return signalOn(f).length;
  }
};

/** The short line beside a group on the rail: "2 picked", "me", "any". */
export function railSummary(f: JiraListFilters, g: GroupId, n: Names = {}): string {
  const k = pickedIn(f, g);
  if (!k) return "any";
  const out = notIn(f, g);
  if (out.length && !picksIn(f, g)) return out.length === 1 ? `not ${sentenceValue(g, out[0]!, n)}` : `${out.length} excluded`;
  if (out.length) return `${picksIn(f, g)} picked · ${out.length} not`;
  if (g === "people") return many(peopleOf(f, n), "picked");
  if (g === "space") return many(f.spaces ?? [], "picked");
  if (g === "sprint") return many([...(f.sprintOnly ? [f.sprintOnly === "@running" ? "Current" : f.sprintOnly] : []), ...(f.sprintPick ?? []).map((p) => p === CURRENT ? "Current" : p === NEXT ? "Next" : p === NONE ? "None" : p.replace(/^n:/, ""))], "picked");
  if (g === "priority") return many((f.priorityPick ?? []).map((x) => PRIORITY_LABEL[x] ?? x), "picked");
  if (g === "dates") return "has a due date";
  if (g === "signals") return many(signalOn(f), "on", 1);
  return k === 1 ? "1 picked" : `${k} picked`;
}

const sentenceValue = (g: GroupId, id: string, n: Names): string => (g === "epic" ? n.epics?.[id] ?? id : g === "people" ? n.people?.[id] ?? id : g === "sprint" ? sprintSentence([id]) : g === "priority" ? PRIORITY_LABEL[id] ?? id : id);

export interface SentencePart { id: string; /** The words before it: "status", "assigned to". */ lead: string; label: string; /** Removing the part. */ clear: Partial<JiraListFilters>; excluded?: boolean }

/** The sentence of what is on, one part each, in the order it reads. Empty when nothing narrows. */
export function sentenceParts(f: JiraListFilters, n: Names = {}): SentencePart[] {
  const out: SentencePart[] = [];
  if (f.spaces?.length) out.push({ id: "space", lead: "in", label: f.spaces.join(" or "), clear: CLEAR_GROUP.space });
  if (f.sprintPick?.length) out.push({ id: "sprint", lead: "in", label: sprintSentence(f.sprintPick), clear: { sprintPick: [] } });
  if (f.sprintOnly) out.push({ id: "sprintOnly", lead: "in", label: f.sprintOnly === "@running" ? "current sprint" : f.sprintOnly, clear: { sprintOnly: null } });
  const who = peopleOf(f, n);
  if (who.length) out.push({ id: "people", lead: "assigned to", label: who.join(" or "), clear: CLEAR_GROUP.people });
  if (f.statusPick.length) out.push({ id: "status", lead: "status", label: f.statusPick.join(" or "), clear: CLEAR_GROUP.status });
  if (f.epicPick.length) out.push({ id: "epic", lead: "under", label: f.epicPick.map((k) => n.epics?.[k] ?? k).join(" or "), clear: CLEAR_GROUP.epic });
  if (f.tagPick.length) out.push({ id: "label", lead: "labelled", label: f.tagPick.join(f.tagAll ? " and " : " or "), clear: { ...CLEAR_GROUP.label, tagAll: false } });
  if (f.componentPick.length) out.push({ id: "component", lead: "in component", label: f.componentPick.join(" or "), clear: CLEAR_GROUP.component });
  for (const g of EXCLUDABLE) { const o = notIn(f, g); if (o.length) out.push({ id: `not-${g}`, lead: "not", label: o.map((v) => sentenceValue(g, v, n)).join(" or "), excluded: true, clear: { notPick: { ...f.notPick, [g]: [] } } }); }
  if (f.priorityPick?.length) out.push({ id: "priority", lead: "with priority", label: f.priorityPick.map((p) => PRIORITY_LABEL[p] ?? p).join(" or "), clear: CLEAR_GROUP.priority });
  if (f.dueOnly) out.push({ id: "dates", lead: "with", label: "a due date", clear: CLEAR_GROUP.dates });
  for (const q of QUICK_TOGGLES) if (q.id !== "dueOnly" && f[q.id]) out.push({ id: q.id, lead: "that are", label: (q.label as string).toLowerCase(), clear: { [q.id]: false } });
  if (f.showDone) out.push({ id: "showDone", lead: "including", label: "done", clear: { showDone: false } });
  if (f.built.rules.length) out.push({ id: "built", lead: "matching", label: `${f.built.rules.length} rule${f.built.rules.length === 1 ? "" : "s"}`, clear: { built: EMPTY } });
  return out;
}

/** "N of M cards" for the corner of the sentence. */
export const cardsLine = (shown: number, total: number): { n: string; of: string } => ({ n: String(shown), of: `of ${total} card${total === 1 ? "" : "s"}` });

/** The primary button: "Show 5 cards". */
export const showLabel = (n: number): string => `Show ${n} card${n === 1 ? "" : "s"}`;

/* ---- the rows of the open group ---- */

export interface Row { /** Left out ("is not"). */ out?: boolean; /** Sprint rows: the heading they sit under, a tag ("INF 47 · ends Thu") and a note. */ section?: string; /** Empty status: folded under one line until asked for. */ folded?: boolean; tag?: string; note?: string; id: string; label: string; count?: number; on: boolean; /** A status dot colour. */ color?: string; /** A person's picture. */ face?: { avatar?: string; name: string } }

export interface Source { now?: number; /** The boards in view (active + future sprints with dates): the card menu's own sprint source. */ boards?: readonly SprintBoard[]; cards: readonly ProviderTask[]; statuses: readonly ListStatus[]; tags: readonly string[]; team: readonly TeamMember[] }

/** The values a group offers, picked state included. Toggle groups (dates, signals) offer their switches as rows. */
export function groupRows(g: GroupId, f: JiraListFilters, s: Source): Row[] {
  const no = notIn(f, g);
  const counts = facetCounts(g, f, s);
  const rows = rowsOf(g, f, s).map((r) => ({ ...(counts ? { ...r, count: counts.get(r.id) ?? 0 } : r), ...(no.includes(r.id) ? { out: true } : {}) }));
  return arrange(g, rows);
}

/** Each value's count with every OTHER group applied: what picking it (alone in its group) would leave. Null for groups that are not lists of values. */
export function facetCounts(g: GroupId, f: JiraListFilters, s: Source): Map<string, number> | null {
  if (!ARRANGED.includes(g)) return null;
  // Clearing Status also hides done cards again (Hide done is on); a Done row must count the done cards picking it would show.
  const rest = filterCards(s.cards, { ...f, ...CLEAR_GROUP[g], ...(g === "status" ? { showDone: true } : {}), notPick: { ...f.notPick, [g]: [] } });
  const out = new Map<string, number>();
  const bump = (id: string) => out.set(id, (out.get(id) ?? 0) + 1);
  for (const t of rest) {
    switch (g) {
      case "status": bump(t.status); break;
      case "people": new Set(assigneeIdsOf(t)).forEach(bump); break;
      case "space": bump(spaceOf(t)); break;
      case "epic": bump(epicKeyOf(t, s.cards)); break;
      case "component": new Set(t.components ?? []).forEach(bump); break;
      case "label": new Set(t.tags).forEach(bump); break;
      case "priority": bump(t.priority ?? "none"); break;
    }
  }
  return out;
}

/* ---- keyboard ---- */

/** Tab / Shift+Tab walk the rail's groups, wrapping round. */
export const nextGroup = (g: GroupId, dir: 1 | -1): GroupId => GROUPS[(GROUPS.findIndex((x) => x.id === g) + dir + GROUPS.length) % GROUPS.length]!.id;
/** Up / Down move the row in focus by one, staying inside the list; no row in focus yet, Down starts at the top and Up at the bottom. */
export const stepRow = (at: number, dir: 1 | -1, n: number): number => (n === 0 ? -1 : at < 0 ? (dir === 1 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, at + dir)));
/** What a key does in the open pane: null when it is not ours. Space picks, Alt+Space leaves out, "/" goes to the search. */
export function paneKey(e: { key: string; altKey?: boolean; shiftKey?: boolean }, at: { rail?: boolean; radio?: boolean } = {}): { move: 1 | -1 } | { group: 1 | -1 } | { pick: "is" | "not" } | { search: true } | null {
  // Tab walks the groups only from a rail item; anywhere else it moves focus as the browser does, so no control is out of reach and focus is not trapped.
  // Up / Down inside a radio group (is / is not, any of / all of) belong to that group.
  if (e.key === "ArrowDown" || e.key === "ArrowUp") return at.radio ? null : { move: e.key === "ArrowDown" ? 1 : -1 };
  if (e.key === "Tab") return at.rail ? { group: e.shiftKey ? -1 : 1 } : null;
  if (e.key === " ") return { pick: e.altKey ? "not" : "is" };
  if (e.key === "/") return { search: true };
  return null;
}

/** Groups that are lists of values with no sections of their own: picked on top, the rest by count. */
const ARRANGED: readonly GroupId[] = ["status", "people", "space", "epic", "label", "component", "priority"];
/** Picked and left-out values first, the others by count (a row with no count keeps its place); a value with no card here is dimmed and says so, and an empty status is folded away. */
export function arrange(g: GroupId, rows: Row[]): Row[] {
  if (!ARRANGED.includes(g)) return rows;
  const kept = (r: Row) => r.on || !!r.out;
  const marked = rows.map((r) => (r.count === 0 && !kept(r) ? { ...r, note: "none in this view", folded: g === "status" } : r));
  const rank = (r: Row, i: number): [number, number, number] => [kept(r) ? 0 : 1, kept(r) || r.count === undefined ? 0 : -r.count, i];
  return marked.map((r, i) => [r, rank(r, i)] as const).sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1] || a[1][2] - b[1][2]).map(([r]) => r);
}
function rowsOf(g: GroupId, f: JiraListFilters, s: Source): Row[] {
  switch (g) {
    case "status": { const { working, finished } = statusMenuOf(s.statuses, s.cards, f.statusPick); return [...working, ...finished].map((r) => ({ id: r.status, label: r.status, count: r.count, on: r.on, color: r.color })); }
    case "sprint": return sprintRows(s.cards, f.sprintPick ?? [], s.now ?? Date.now(), s.boards);
    case "people": return s.team.filter((m): m is TeamMember & { key: string } => !!m.key).map((m) => ({ id: m.key, label: m.name, on: f.assigneePick.includes(m.key), face: { avatar: m.avatar, name: m.name } }));
    case "space": return spaceChoices(s.cards, f.spaces ?? []).map((r) => ({ id: r.space, label: r.space, count: r.count, on: r.on }));
    case "epic": return epicChoices(s.cards, f.epicPick).map((r) => ({ id: r.id, label: r.name, count: r.count, on: r.on }));
    case "component": return componentChoices(s.cards, f.componentPick).map((r) => ({ id: r.id, label: r.name, count: r.count, on: r.on }));
    case "priority": return priorityChoices(s.cards, f.priorityPick ?? []).map((r) => ({ id: r.id, label: r.name, count: r.count, on: r.on }));
    case "label": return s.tags.map((t) => ({ id: t, label: t, on: f.tagPick.includes(t) }));
    case "dates": return [{ id: "dueOnly", label: "Has a due date", on: !!f.dueOnly }];
    case "signals": return SIGNALS.map((x) => ({ id: x.id, label: x.label, on: !!(f as unknown as Record<string, unknown>)[x.id] }));
  }
}

/** Picking a row: the patch that turns it on, or off when it is on. */
export function togglePatch(g: GroupId, f: JiraListFilters, id: string, mode: "is" | "not" = "is"): Partial<JiraListFilters> {
  if (mode === "not" && EXCLUDABLE.includes(g)) return excludePatch(g, f, id);
  const dropped = notIn(f, g).includes(id) ? { notPick: { ...f.notPick, [g]: notIn(f, g).filter((x) => x !== id) } } : {};
  return { ...plainToggle(g, f, id), ...dropped };
}
/** "Is not" on a value: leaves it out, or takes it back; a picked value is moved over rather than kept in both. */
function excludePatch(g: GroupId, f: JiraListFilters, id: string): Partial<JiraListFilters> {
  const out = notIn(f, g), was = out.includes(id);
  const patch: Partial<JiraListFilters> = { notPick: { ...f.notPick, [g]: was ? out.filter((x) => x !== id) : [...out, id] } };
  if (!was && rowPicked(g, f, id)) Object.assign(patch, plainToggle(g, f, id));
  return patch;
}
const pickList = (g: GroupId, f: JiraListFilters): readonly string[] => ({ status: f.statusPick, sprint: f.sprintPick ?? [], people: f.assigneePick, space: f.spaces ?? [], epic: f.epicPick, label: f.tagPick, component: f.componentPick, priority: f.priorityPick ?? [], dates: [], signals: [] })[g];
const rowPicked = (g: GroupId, f: JiraListFilters, id: string): boolean => pickList(g, f).includes(id);
function plainToggle(g: GroupId, f: JiraListFilters, id: string): Partial<JiraListFilters> {
  switch (g) {
    case "status": return { statusPick: togglePick(f.statusPick, id) };
    case "sprint": return { sprintPick: togglePick(f.sprintPick ?? [], id) };
    case "people": return { assigneePick: togglePick(f.assigneePick, id) };
    case "space": return { spaces: toggleSpace(f.spaces ?? [], id) };
    case "epic": return { epicPick: togglePick(f.epicPick, id) };
    case "component": return { componentPick: togglePick(f.componentPick, id) };
    case "label": return { tagPick: togglePick(f.tagPick, id) };
    case "priority": return { priorityPick: togglePick(f.priorityPick ?? [], id) };
    case "dates":
    case "signals": return { [id]: !(f as unknown as Record<string, unknown>)[id] } as Partial<JiraListFilters>;
  }
}

/** The search box of a pane: rows whose name holds the words. */
export const searchRows = (rows: readonly Row[], q: string): Row[] => { const w = q.trim().toLowerCase(); return w ? rows.filter((r) => r.label.toLowerCase().includes(w)) : [...rows]; };
