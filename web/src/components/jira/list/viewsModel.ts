/*
 * The board's views as plain data: the four default views, the person's layout over them (order, names, hidden ones), the
 * filters kept with each view, and the search each view runs. Nothing here reads the screen or the site, so a test asks it directly.
 */
import { parseScope } from "../../../../../shared/jiraScope.ts";
import { ASSIGNED_VIEW_ID, type ProviderTask } from "../../../../../shared/providers.ts";
import type { ViewCount } from "../../../lib/jiraTree.ts";
import { spaceOf, type JiraListFilters } from "./model.ts";
import { EMPTY } from "../../tasks/filters.ts";
import { migrateSprintOnly, sprintSentence } from "./sprintModel.ts";
import { PRIORITY_LABEL, componentChipLabel, epicChipLabel } from "./facetsModel.ts";
import { TAB_PREFIX, type NamedTab } from "./tabsModel.ts";

export interface ViewSpec { id: string; name: string; /** Cards of a set of people the person picks, not of the person. */ team: boolean; /** Only the open sprint(s). */ sprint: boolean; /** Runs on the whole site, not inside the open board's scope. */ cross?: boolean }

export const DEFAULT_VIEWS: readonly ViewSpec[] = [
  { id: TAB_PREFIX + "mine", name: "Mine", team: false, sprint: false, cross: true },
  { id: TAB_PREFIX + "mine-sprint", name: "Mine · sprint", team: false, sprint: true, cross: true },
  { id: TAB_PREFIX + "team", name: "Team", team: true, sprint: false, cross: true },
  { id: TAB_PREFIX + "team-sprint", name: "Team · sprint", team: true, sprint: true, cross: true },
];

/** The sidebar's "Assigned to me" is the Mine view: it carries its own cross-space scope, not a board filter under other views. */
export const meViewTab = (viewId: string | null | undefined): string | null => (viewId === ASSIGNED_VIEW_ID ? TAB_PREFIX + "mine" : null);

/** What a view keeps from the filters set inside it. `people` are the team's members (assignee ids). */
export interface ViewFilters { spaces: string[]; statusPick: string[]; people: string[]; tags: string[]; epics?: string[]; components?: string[] }
export const NO_VIEW_FILTERS: ViewFilters = { spaces: [], statusPick: [], people: [], tags: [], epics: [], components: [] };

export interface ViewLayout { order: string[]; names: Record<string, string>; hidden: string[]; filters: Record<string, ViewFilters>; /** A search saved back to a view from the box: it replaces the one the view builds. */ jql: Record<string, string>; /** Every applied filter and the search text, per site view and tab (see keptKey), kept across a restart. */ kept: Record<string, KeptFilters>; /** Named sets of filters from the Filters popover's Saved row, by name. */ saved?: Record<string, KeptFilters> }
export const NO_LAYOUT: ViewLayout = { order: [], names: {}, hidden: [], filters: {}, jql: {}, kept: {} };

/** What survives a restart of the filters set on a view. Not the view's own search, nor what is derived (site, live, needs), nor a grouping. */
const KEPT_LISTS = ["spaces", "tagPick", "statusPick", "assigneePick", "epicPick", "componentPick", "quick", "sprintPick", "priorityPick"] as const;
const KEPT_FLAGS = ["mineOnly", "readyOnly", "liveOnly", "needsOnly", "flaggedOnly", "blockedOnly", "dueOnly", "quietOnly", "showDone"] as const;
export type KeptFilters = Partial<Pick<JiraListFilters, (typeof KEPT_LISTS)[number] | (typeof KEPT_FLAGS)[number] | "query" | "sprintOnly" | "built" | "notPick" | "tagAll">>;
/** One slot per site view and tab: "Assigned to me" and "Team" each keep their own. */
export const keptKey = (viewId: string | null | undefined, tab: string | null | undefined): string => `${viewId ?? ""}|${tab ?? ""}`;
export function pickRest(f: JiraListFilters): KeptFilters {
  const out: Record<string, unknown> = { query: f.query, sprintOnly: f.sprintOnly ?? null, built: f.built, notPick: Object.fromEntries(Object.entries(f.notPick ?? {}).filter(([, v]) => v.length).map(([k, v]) => [k, [...v]])), tagAll: !!f.tagAll };
  for (const k of KEPT_LISTS) out[k] = [...(f[k] ?? [])];
  for (const k of KEPT_FLAGS) out[k] = !!f[k];
  return out as KeptFilters;
}
/** What picking (or starting on) a tab applies: the tab's start, its saved lists, then the slot kept for this site view and tab. The slot wins: the old per-tab lists are empty for a tab whose filters were only kept in the slot, and must not wipe it. */
export function tabRestore(layout: ViewLayout, viewKey: string, tab: string, lists: ViewFilters | undefined): KeptFilters & ReturnType<typeof tabStart> & ReturnType<typeof restoreKept> {
  /* "Assigned to me" written while Mine was not lit (hidden from the strip) sits under the tab-less key: read it when the tab's own slot is empty, for Mine only (Team must not inherit Mine's filters). */
  const slot = layout.kept[keptKey(viewKey, tab)] ?? (viewKey === ASSIGNED_VIEW_ID && tab === meViewTab(viewKey) ? layout.kept[keptKey(viewKey, null)] : undefined);
  return { ...tabStart(), ...restoreKept(lists), ...slot, query: slot?.query ?? "" } as KeptFilters & ReturnType<typeof tabStart> & ReturnType<typeof restoreKept>;
}
/** The save effect must not write while a tab is still to be restored (the view opens on one, none is lit yet): the defaults would replace the stored copy. */
export const mayKeepRest = (viewId: string | null | undefined, activeTab: string | null | undefined): boolean => !!activeTab || !meViewTab(viewId);
export const keepRest = (layout: ViewLayout, key: string, f: KeptFilters): ViewLayout => (JSON.stringify(layout.kept[key]) === JSON.stringify(f) ? layout : { ...layout, kept: { ...layout.kept, [key]: f } });
function readKept(v: unknown): KeptFilters | null {
  if (typeof v !== "object" || !v) return null;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of KEPT_LISTS) if (Array.isArray(o[k])) out[k] = (o[k] as unknown[]).filter((x): x is string => typeof x === "string");
  for (const k of KEPT_FLAGS) if (typeof o[k] === "boolean") out[k] = o[k];
  if (typeof o.query === "string") out.query = o.query;
  if (o.sprintOnly === null || typeof o.sprintOnly === "string") out.sprintOnly = o.sprintOnly;
  Object.assign(out, migrateSprintOnly(out));
  if (o.notPick && typeof o.notPick === "object" && !Array.isArray(o.notPick)) out.notPick = Object.fromEntries(Object.entries(o.notPick as Record<string, unknown>).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).filter((x): x is string => typeof x === "string")]));
  if (typeof o.tagAll === "boolean") out.tagAll = o.tagAll;
  const b = o.built as { rules?: unknown } | undefined;
  if (b && typeof b === "object" && Array.isArray(b.rules)) out.built = b;
  return out as KeptFilters;
}

/** What the site is asked with a search: inside the open view, or (a default view's own search, untouched in the box) across the whole site. */
export function jqlScope(viewId: string | null, filters: Pick<JiraListFilters, "viewCross">, quick: readonly string[]): { id: string; quick: readonly string[]; cross?: boolean } | undefined {
  if (!viewId) return undefined;
  return filters.viewCross ? { id: viewId, quick, cross: true } : { id: viewId, quick };
}

/** The team a starred Jira filter already names: the first whose whole search is "assignee in (a, b)" (an ORDER BY after it is fine). */
export function teamFromFavourites(favs: readonly { jql: string }[]): string[] {
  for (const f of favs) {
    const m = /^\s*assignee\s+in\s*\(([^()]*)\)\s*(?:order\s+by\b.*)?$/i.exec(f.jql);
    if (!m) continue;
    const ids = m[1]!.split(",").map((x) => x.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")).filter((x) => x && !/[()]/.test(x));
    if (ids.length) return ids;
  }
  return [];
}

/**
 * A Team view opened over a space starts scoped to that space. Team's search is "everyone's cards", and with no space in it
 * that was every assigned card on the site (817 of them) under a sidebar that said one space. Mine stays cross-space on
 * purpose; a space the person already picked inside the view is theirs and is kept.
 */
export function teamScoped(spec: Pick<ViewSpec, "team">, kept: ViewFilters | undefined, viewId: string | null | undefined): ViewFilters | undefined {
  if (!spec.team || kept?.spaces.length) return kept;
  const space = viewId ? parseScope(viewId)?.space : undefined;
  return space ? { ...(kept ?? NO_VIEW_FILTERS), spaces: [space] } : kept;
}

const quoted = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

/** The search a view runs, with the filters kept for it. Team cards always have an assignee. */
export function viewJql(spec: Pick<ViewSpec, "team" | "sprint">, f: ViewFilters = NO_VIEW_FILTERS): string {
  const parts: string[] = [];
  if (spec.team) {
    if (f.people.length) parts.push(`assignee in (${f.people.map(quoted).join(", ")})`);
    parts.push("assignee is not EMPTY");
  } else parts.push("assignee = currentUser()");
  if (spec.sprint) parts.push("sprint in openSprints()");
  if (f.spaces.length) parts.push(`project in (${f.spaces.map(quoted).join(", ")})`);
  return parts.join(" AND ");
}

/** The views on screen: the layout's order (a view the layout does not know goes last), its names, without the hidden ones. */
export function layoutViews(layout: ViewLayout, all: readonly ViewSpec[] = DEFAULT_VIEWS): ViewSpec[] {
  const rank = (id: string) => { const i = layout.order.indexOf(id); return i < 0 ? layout.order.length : i; };
  return all.map((v, i) => ({ v, i }))
    .sort((a, b) => rank(a.v.id) - rank(b.v.id) || a.i - b.i)
    .map(({ v }) => ({ ...v, name: layout.names[v.id]?.trim() || v.name }))
    .filter((v) => !layout.hidden.includes(v.id));
}

/** The strip's tabs, each with the search it runs now. */
export function viewTabs(layout: ViewLayout, all: readonly ViewSpec[] = DEFAULT_VIEWS): NamedTab[] {
  return layoutViews(layout, all).map((v) => ({ id: v.id, name: v.name, jql: layout.jql[v.id] ?? viewJql(v, layout.filters[v.id]) }));
}

/** Drag `id` to where `before` sits (null: the end). */
export function moveView(layout: ViewLayout, id: string, before: string | null, all: readonly ViewSpec[] = DEFAULT_VIEWS): ViewLayout {
  const ids = [...layout.order.filter((x) => all.some((v) => v.id === x)), ...all.map((v) => v.id).filter((x) => !layout.order.includes(x))].filter((x) => x !== id);
  const at = before ? ids.indexOf(before) : -1;
  ids.splice(at < 0 ? ids.length : at, 0, id);
  return { ...layout, order: ids };
}
export const renameView = (layout: ViewLayout, id: string, name: string): ViewLayout => {
  const names = { ...layout.names };
  if (name.trim()) names[id] = name.trim(); else delete names[id];
  return { ...layout, names };
};
export const hideView = (layout: ViewLayout, id: string): ViewLayout => (layout.hidden.includes(id) ? layout : { ...layout, hidden: [...layout.hidden, id] });
export const showView = (layout: ViewLayout, id: string): ViewLayout => ({ ...layout, hidden: layout.hidden.filter((x) => x !== id) });
/** Reset to defaults: order, names and hidden go back; the filters kept with each view stay. */
export const resetLayout = (layout: ViewLayout): ViewLayout => ({ ...NO_LAYOUT, filters: layout.filters, kept: layout.kept, ...(layout.saved ? { saved: layout.saved } : {}) });

/* ---- the Saved row: named sets of filters ---- */
export const MAX_PRESETS = 12;
const presetOf = (f: JiraListFilters): KeptFilters => { const { query: _q, ...rest } = pickRest(f); return rest; };
/** Keeps what is on as a named set (the search box's words are not part of it); the same name replaces the old one. Nothing on, or no name, keeps nothing. */
export function savePreset(layout: ViewLayout, name: string, f: JiraListFilters, on: boolean): ViewLayout {
  const n = name.trim().slice(0, 40);
  const saved = layout.saved ?? {};
  if (!n || !on || (!(n in saved) && Object.keys(saved).length >= MAX_PRESETS)) return layout;
  return { ...layout, saved: { ...saved, [n]: presetOf(f) } };
}
export function removePreset(layout: ViewLayout, name: string): ViewLayout {
  const { [name]: _gone, ...saved } = layout.saved ?? {};
  return { ...layout, saved };
}
/** Applying a set: everything off first, then the set, so nothing from before stays on beside it. */
export const presetPatch = (k: KeptFilters): Partial<JiraListFilters> => ({ ...tabStart(), ...restoreKept(undefined), ...k }) as Partial<JiraListFilters>;
/** Whether the filters on now are exactly this set. */
export const presetIsOn = (f: JiraListFilters, k: KeptFilters): boolean => JSON.stringify(presetOf(f)) === JSON.stringify(presetOf({ ...f, ...presetPatch(k) } as JiraListFilters));
/** "Save to view": the search typed in the box becomes the view's own; the same text as the built one drops the override. */
export const saveToView = (layout: ViewLayout, id: string, jql: string, built: string): ViewLayout => {
  const next = { ...layout.jql };
  if (jql.trim() && jql.trim() !== built.trim()) next[id] = jql.trim(); else delete next[id];
  return { ...layout, jql: next };
};
export const keepFilters = (layout: ViewLayout, id: string, f: ViewFilters): ViewLayout => ({ ...layout, filters: { ...layout.filters, [id]: f } });

/** What the list's filters give to a view to keep, and what a view gives back on the next visit. */
export function pickKept(f: { spaces?: readonly string[]; statusPick: readonly string[]; assigneePick: readonly string[]; tagPick: readonly string[]; epicPick?: readonly string[]; componentPick?: readonly string[] }): ViewFilters {
  return { spaces: [...(f.spaces ?? [])], statusPick: [...f.statusPick], people: [...f.assigneePick], tags: [...f.tagPick], epics: [...(f.epicPick ?? [])], components: [...(f.componentPick ?? [])] };
}
export const restoreKept = (k: ViewFilters | undefined): { spaces: string[]; statusPick: string[]; assigneePick: string[]; tagPick: string[]; epicPick: string[]; componentPick: string[] } => {
  const v = k ?? NO_VIEW_FILTERS;
  return { spaces: [...v.spaces], statusPick: [...v.statusPick], assigneePick: [...v.people], tagPick: [...v.tags], epicPick: [...(v.epics ?? [])], componentPick: [...(v.components ?? [])] };
};

/**
 * Leaving a default tab (Team, Mine…) for a saved search or starred filter: the tab's own search chip and the people,
 * statuses and labels kept with it go, so the filter is read on its own. The space stays: it is the board. Measured:
 * "Assigned to me" opened from Team kept Team's "assignee in (…)" and People: 4, and showed the whole team.
 */
export const leaveTab = (spaces: readonly string[] = []) => ({ ...tabStart(), ...restoreKept(undefined), spaces: [...spaces], query: "", viewJql: null, viewCross: false });

/** The narrowings a tab never keeps (only spaces, statuses, people, labels, epics and components are kept with it): off when
 *  a tab is picked and when it is left, so Flagged, Mine only, Show done, a built rule or a sprint set under one tab are not read under the next. */
export const tabStart = () => ({ mineOnly: false, readyOnly: false, liveOnly: false, needsOnly: false, flaggedOnly: false, blockedOnly: false, dueOnly: false, quietOnly: false, built: EMPTY, sprintOnly: null, sprintPick: [] as string[], priorityPick: [] as string[], notPick: {} as Record<string, string[]>, tagAll: false, quick: [] as string[], showDone: false });

/** What a tab's count says: only the tab on screen has one - the cards it shows on this board. Any other tab has none, never a site-wide number. */
export function tabCounts(current: string | null, shown: number, more: boolean): Record<string, ViewCount> {
  return current ? { [current]: { n: shown, more } } : {};
}

/** A broken layout read back from storage becomes the defaults, field by field. */
export function readLayout(raw: unknown): ViewLayout {
  if (typeof raw !== "object" || raw === null) return NO_LAYOUT;
  const o = raw as Record<string, unknown>;
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const names: Record<string, string> = {};
  if (typeof o.names === "object" && o.names) for (const [k, v] of Object.entries(o.names)) if (typeof v === "string") names[k] = v;
  const filters: Record<string, ViewFilters> = {};
  if (typeof o.filters === "object" && o.filters) {
    for (const [k, v] of Object.entries(o.filters as Record<string, unknown>)) {
      if (typeof v !== "object" || !v) continue;
      const f = v as Record<string, unknown>;
      filters[k] = { spaces: strs(f.spaces), statusPick: strs(f.statusPick), people: strs(f.people), tags: typeof f.tag === "string" ? [f.tag] : strs(f.tags), epics: strs(f.epics), components: strs(f.components) };
    }
  }
  const jql: Record<string, string> = {};
  if (typeof o.jql === "object" && o.jql) for (const [k, v] of Object.entries(o.jql)) if (typeof v === "string" && v.trim()) jql[k] = v;
  const kept: Record<string, KeptFilters> = {};
  if (typeof o.kept === "object" && o.kept) for (const [k, v] of Object.entries(o.kept as Record<string, unknown>)) { const r = readKept(v); if (r) kept[k] = r; }
  const saved: Record<string, KeptFilters> = {};
  if (typeof o.saved === "object" && o.saved && !Array.isArray(o.saved)) for (const [k, v] of Object.entries(o.saved as Record<string, unknown>)) { const r = readKept(v); if (r) saved[k] = r; }
  return { order: strs(o.order), names, hidden: strs(o.hidden), filters, jql, kept, ...(Object.keys(saved).length ? { saved } : {}) };
}

/**
 * The sprint "Move to current sprint" and the Sprint submenu mean: the board's own when the view has one, else the active
 * sprint the cards carry (the same `sprintActive` the "Current sprint" chip keeps), so a space or JQL view, which has no
 * board, still has a current sprint. A card in an active sprint answers with its own; otherwise the sprint most cards of its own space on
 * screen are in. The ceiling: spaces running two sprints at once are told apart only by the card's own.
 */
export function currentSprintOf(board: { id: string; name: string } | null | undefined, cards: readonly ProviderTask[], card?: ProviderTask): { id: string; name: string } | null {
  if (board) return board;
  if (card?.sprintActive && card.sprintId && card.sprint) return { id: card.sprintId, name: card.sprint };
  /* The guess from the other cards stays inside one space: a sprint belongs to one team, and a cross-space view such as
     "Assigned to me" would otherwise hand an INF card the sprint most of another space's cards are in. A bulk move with no
     card in hand guesses only when every card on screen is in the same space. */
  const space = (t: Pick<ProviderTask, "customId" | "id">) => (t.customId ?? t.id).split("-")[0]!.toUpperCase();
  const spaces = new Set(cards.map(space));
  const within = card ? space(card) : spaces.size === 1 ? [...spaces][0] : null;
  if (!within) return null;
  const n = new Map<string, { id: string; name: string; n: number }>();
  for (const t of cards) if (space(t) === within && t.sprintActive && t.sprintId && t.sprint) { const s = n.get(t.sprintId) ?? { id: t.sprintId, name: t.sprint, n: 0 }; s.n += 1; n.set(t.sprintId, s); }
  const top = [...n.values()].sort((a, b) => b.n - a.n)[0];
  return top ? { id: top.id, name: top.name } : null;
}

/** "Move to current sprint": the board's active sprint and the cards, or the sentence that says why not. */
export function sprintMoveAsk(sprint: { id: string; name: string } | null | undefined, keys: readonly string[]): { ok: true; id: string; keys: string[]; said: string } | { ok: false; error: string } {
  if (!sprint) return { ok: false, error: "This board has no active sprint to move cards to" };
  if (!keys.length) return { ok: false, error: "Pick a card to move" };
  return { ok: true, id: sprint.id, keys: [...keys], said: `Moved ${keys.length === 1 ? keys[0] : `${keys.length} cards`} to ${sprint.name}` };
}

/* ---------- the spaces filter ---------- */
export const toggleSpace = (picked: readonly string[], space: string): string[] => (picked.includes(space) ? picked.filter((s) => s !== space) : [...picked, space]);
export const spacesTrigger = (picked: readonly string[]): string => (picked.length === 0 ? "All spaces" : picked.length === 1 ? picked[0]! : `${picked.length} spaces`);
/** The spaces the cards on screen belong to, plus any already picked, with how many cards each holds. */
export function spaceChoices(cards: readonly ProviderTask[], picked: readonly string[]): { space: string; count: number; on: boolean }[] {
  const n = new Map<string, number>(picked.map((s) => [s, 0]));
  for (const t of cards) { const s = spaceOf(t); if (s) n.set(s, (n.get(s) ?? 0) + 1); }
  return [...n].map(([space, count]) => ({ space, count, on: picked.includes(space) })).sort((a, b) => a.space.localeCompare(b.space));
}

/** Clicking the view's JQL chip: its search moves into the box, editable; Enter applies it. The view no longer holds it twice. */
export const loadChip = (f: { viewJql?: string | null }): { query: string; viewJql: null } => ({ query: f.viewJql ?? "", viewJql: null });

/* ---------- every active filter is a chip ---------- */
export interface ActiveChip { id: string; label: string; /** The board's own scope: shown first, not removable. */ board?: boolean; /** What removing the chip changes. */ clear?: Partial<JiraListFilters> }

/** Everything that narrows the list right now, one chip each, the board's own scope first. */
export function activeChips(f: JiraListFilters, boardName: string | undefined, quickNames: Readonly<Record<string, string>> = {}, epicNames: Readonly<Record<string, string>> = {}): ActiveChip[] {
  const out: ActiveChip[] = [];
  // A cross-site view (Mine, Team) carries its own whole scope: the board it was opened over is not a narrowing, so no chip for it.
  if (boardName && !(f.viewCross && f.viewJql?.trim())) out.push({ id: "board", label: boardName, board: true });
  if (f.viewJql?.trim()) out.push({ id: "view", label: `View: ${f.viewJql.trim()}`, clear: { viewJql: null } });
  if (f.query.trim()) out.push({ id: "query", label: `Search: ${f.query.trim()}`, clear: { query: "" } });
  if (f.mineOnly) out.push({ id: "mine", label: "Mine", clear: { mineOnly: false } });
  if (f.assigneePick.length) out.push({ id: "people", label: `People: ${f.assigneePick.length}`, clear: { assigneePick: [] } });
  if (f.spaces?.length) out.push({ id: "spaces", label: `Spaces: ${f.spaces.join(", ")}`, clear: { spaces: [] } });
  if (f.readyOnly) out.push({ id: "ready", label: "Ready", clear: { readyOnly: false } });
  if (f.liveOnly) out.push({ id: "live", label: "Live worker", clear: { liveOnly: false } });
  if (f.needsOnly) out.push({ id: "needs", label: "Needs you", clear: { needsOnly: false } });
  if (f.flaggedOnly) out.push({ id: "flagged", label: "Flagged", clear: { flaggedOnly: false } });
  if (f.blockedOnly) out.push({ id: "blocked", label: "Blocked", clear: { blockedOnly: false } });
  if (f.dueOnly) out.push({ id: "due", label: "Has due date", clear: { dueOnly: false } });
  if (f.tagPick.length) out.push({ id: "tag", label: f.tagPick.map((g) => `#${g}`).join(" "), clear: { tagPick: [] } });
  if (f.epicPick.length) out.push({ id: "epic", label: epicChipLabel(f.epicPick, epicNames), clear: { epicPick: [] } });
  if (f.componentPick.length) out.push({ id: "component", label: componentChipLabel(f.componentPick), clear: { componentPick: [] } });
  if (f.statusPick.length) out.push({ id: "status", label: `Status: ${f.statusPick.join(", ")}`, clear: { statusPick: [] } });
  if (f.showDone) out.push({ id: "showdone", label: "Show done", clear: { showDone: false } });
  else if (!f.statusPick.length) out.push({ id: "done", label: "Hide done", clear: { showDone: true } });
  if (f.built.rules.length) out.push({ id: "built", label: `Filters (${f.built.rules.length})`, clear: { built: EMPTY } });
  if (f.sprintPick?.length) out.push({ id: "sprintPick", label: sprintSentence(f.sprintPick), clear: { sprintPick: [] } });
  if (f.priorityPick?.length) out.push({ id: "priority", label: `Priority: ${f.priorityPick.map((p) => PRIORITY_LABEL[p] ?? p).join(" or ")}`, clear: { priorityPick: [] } });
  if (f.sprintOnly) out.push({ id: "sprint", label: f.sprintOnly === "@running" ? "Current sprint" : `Sprint: ${f.sprintOnly}`, clear: { sprintOnly: null } });
  for (const q of f.quick) out.push({ id: `quick:${q}`, label: quickNames[q] ?? q, clear: { quick: f.quick.filter((x) => x !== q) } });
  return out;
}

/** "Clear all": every narrowing off; only the board's own scope stays. Done cards go back to the default (hidden), since Show done is a lit filter too. */
export const CLEAR_ALL: Partial<JiraListFilters> = {
  query: "", viewJql: null, mineOnly: false, assigneePick: [], spaces: [], readyOnly: false, liveOnly: false, needsOnly: false, flaggedOnly: false, blockedOnly: false,
  dueOnly: false, tagPick: [], epicPick: [], componentPick: [], statusPick: [], showDone: false, built: EMPTY, sprintOnly: null, sprintPick: [], priorityPick: [], notPick: {}, tagAll: false, quick: [],
};
