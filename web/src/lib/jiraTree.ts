/*
 * The Tasks > Jira sidebar tree, decided apart from the screen.
 *
 * Space > component > epic, with the person's saved boards and filters in a
 * quiet section of their own. This file says WHICH rows exist, in what order,
 * which are dim or hidden, and what the right-click on each one offers; the
 * screen (components/jira/JiraTree.tsx) draws exactly this list.
 *
 * Limit, chosen: one level of epic (the contract's), and "Hide" and "Pin to top"
 * are this sidebar's own housekeeping, kept on this machine; nothing here writes
 * to Jira.
 */
import type { JiraSpace, JiraSpaceTree, JiraTreeComponent, JiraTreeEpic } from "../../../shared/jiraSpaces.ts";
import { scopeId } from "../../../shared/jiraScope.ts";
import type { TipSpec } from "./tip.ts";
import type { CardMenu, MenuItem, MenuRow } from "./prCardMenu.ts";

/** Epics a component shows before "Show N more". The filter box searches all of them. */
export const EPICS_PER_COMPONENT = 6;
/** The row heights, from the spacing table: a rail row is 28, an epic row (two lines) 44. */
export const ROW_H = 28;
export const EPIC_H = 44;
/** The Jira rail opens at 288, wider than the 252 the other boards use: a two-line epic row and a count need the room. Still inside the 208-400 the grip allows. */
export const RAIL_W_JIRA = 288;

/** What a click on a row selects. The pane reads this; the sidebar only writes it. */
export interface TreeTarget {
  kind: "space" | "component" | "epic" | "noepic" | "view";
  /** Component name, for a component, an epic seen under it and "no epic". Absent for the "No component" group. */
  component?: string;
  epic?: string;
  view?: string;
}
/** The one seam: a selected epic or board, with the space it belongs to. */
export type TreeSelection = TreeTarget & { space: string };

/**
 * How one space is laid out under its row. `both` is the tree as it was:
 * component > epic. The others drop a level, or both.
 *
 * Ceiling: two fixed shapes, not an order of levels. "Epic > component" (an epic
 * with its components under it) is the next thing after this and is not here.
 */
export type TreeShape = "both" | "epics";
export const SHAPES: { id: TreeShape; label: string; sub: string }[] = [
  { id: "both", label: "Components", sub: "Each component with its epics under it" },
  { id: "epics", label: "Epics", sub: "Every epic once, under the space, whatever its components" },
];
const isShape = (v: unknown): v is TreeShape => SHAPES.some((x) => x.id === v);

export interface TreePrefs {
  open: Record<string, boolean>;
  all: Record<string, boolean>;
  hideEmpty: Record<string, boolean>;
  /** Per space; a space not named here is `both`. */
  shape: Record<string, TreeShape>;
  hidden: Record<string, boolean>;
  pinned: Record<string, boolean>;
  hideMe: boolean;
  names: Record<string, string>;
  /** The target last chosen in each space: what the pane opens on when the space is picked again. */
  sel: Record<string, TreeTarget>;
  last: string | null;
}
export const EMPTY_PREFS: TreePrefs = { open: {}, all: {}, hideEmpty: {}, shape: {}, hidden: {}, pinned: {}, hideMe: false, names: {}, sel: {}, last: null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
/** Only the shapes this build knows, so a hand-edited or newer value is the default and not a broken tree. */
function shapesIn(v: unknown): Record<string, TreeShape> {
  return Object.fromEntries(Object.entries(obj(v)).filter(([, x]) => isShape(x) && x !== "both")) as Record<string, TreeShape>;
}
export const shapeOf = (prefs: TreePrefs, space: string): TreeShape => prefs.shape[space] ?? "both";
/** `INF:epics,ORB:flat` — the form the settings door reads and writes. "" is every space as it was. */
export const shapesText = (m: Record<string, TreeShape>): string => Object.entries(m).filter(([, v]) => v !== "both").map(([k, v]) => `${k}:${v}`).sort().join(",");
/** Null for text that is not that form: one bad pair refuses the whole value. */
export function parseShapes(text: string): Record<string, TreeShape> | null {
  const out: Record<string, TreeShape> = {};
  for (const part of text.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [k, v, ...rest] = part.split(":");
    if (rest.length || !k || !/^[A-Z][A-Z0-9_]{0,19}$/.test(k) || !isShape(v)) return null;
    if (v !== "both") out[k] = v;
  }
  return out;
}

/** Reads the stored text back; anything unreadable is the default, never an error. */
export function parsePrefs(raw: string | null): TreePrefs {
  if (!raw) return EMPTY_PREFS;
  try {
    const j = obj(JSON.parse(raw));
    return {
      open: obj(j.open), all: obj(j.all), hideEmpty: obj(j.hideEmpty), shape: shapesIn(j.shape), hidden: obj(j.hidden), pinned: obj(j.pinned),
      hideMe: j.hideMe === true, names: obj(j.names), sel: obj(j.sel), last: typeof j.last === "string" ? j.last : null,
    };
  } catch { return EMPTY_PREFS; }
}

export const keyS = (space: string): string => `s:${space}`;
export const keyC = (space: string, comp: string | undefined): string => `c:${space}/${comp ?? ""}`;
export const keyE = (space: string, comp: string | undefined, epic: string): string => `e:${space}/${comp ?? ""}/${epic}`;

/** Where one space's read stands. A failure is that space's own and keeps the last good tree when there is one. */
export type SpaceRead =
  | { state: "loading"; tree?: JiraSpaceTree }
  | { state: "ready"; tree: JiraSpaceTree }
  | { state: "error"; error: string; throttled?: boolean; staleAt?: number; tree?: JiraSpaceTree };

/** A saved board, filter or search, as the rail draws it. */
export interface TreeView { id: string; label: string; kind: "board" | "filter" | "jql"; count?: number; spaceKey?: string; url?: string }

export type TreeRow =
  | { key: string; kind: "caption"; label: string; level: 0 }
  | { key: string; kind: "me"; label: string; level: 0; count?: number }
  | { key: string; kind: "looked"; label: string; level: 0; count: number }
  | { key: string; kind: "sprint"; label: string; level: 0 }
  | { key: string; kind: "space"; level: 0; space: JiraSpace; open: boolean; count?: number; error?: string; throttled?: boolean; loading: boolean }
  | { key: string; kind: "components"; level: 1; space: string; hid: number; hideEmpty: boolean; canHide: boolean; shape: TreeShape }
  | { key: string; kind: "component"; level: 1; space: string; name: string; issues: number; empty: boolean; none: boolean; open: boolean; hasKids: boolean }
  | { key: string; kind: "epic"; level: 1 | 2; space: string; component?: string; epic: JiraTreeEpic; shared: boolean; also: string[]; dim: boolean }
  | { key: string; kind: "noepic"; level: 1 | 2; space: string; component?: string; n: number }
  | { key: string; kind: "more"; level: 1 | 2; space: string; component?: string; n: number }
  | { key: string; kind: "note"; level: 0 | 1 | 2; text: string; error?: boolean }
  | { key: string; kind: "skeleton"; level: 0; widths: number[] }
  | { key: string; kind: "view"; level: 0 | 1; view: TreeView; space?: string };

export interface TreeInput {
  spaces: JiraSpace[];
  reads: Record<string, SpaceRead | undefined>;
  prefs: TreePrefs;
  /** The filter box. */
  q: string;
  views: TreeView[];
  /** Count of the cards assigned to you, when known. */
  meCount?: number;
  /** Cards looked up by id this session. */
  looked: number;
  /** The active sprint's name, when the open board has one. */
  sprint?: string;
  /** False until the list of spaces has been read. */
  listed: boolean;
  /** The list of spaces failed to read. */
  listError?: string;
}

const has = (s: string, q: string): boolean => s.toLowerCase().includes(q);

/** Which components start open: the first space, and in it the first with something. */
export function isSpaceOpen(i: TreeInput, space: JiraSpace, idx: number): boolean {
  if (i.q.trim()) return true;
  return i.prefs.open[keyS(space.key)] ?? idx === 0;
}

function pinFirst<T>(list: T[], keyOf: (t: T) => string, pinned: Record<string, boolean>): T[] {
  if (!list.some((t) => pinned[keyOf(t)])) return list;
  return [...list.filter((t) => pinned[keyOf(t)]), ...list.filter((t) => !pinned[keyOf(t)])];
}

/** The component names an epic shares, other than the one it is drawn under. */
const alsoUnder = (e: JiraTreeEpic, comp: string | undefined): string[] => e.components.filter((c) => c !== comp);

/** Epics straight under the space: every component's, once each, in the order they were first met. */
function epicOnlyRows(i: TreeInput, space: JiraSpace, tree: JiraSpaceTree, out: TreeRow[]): void {
  const q = i.q.trim().toLowerCase();
  const sk = space.key;
  const seen = new Set<string>();
  const all = tree.components.flatMap((c) => c.epics).filter((e) => !seen.has(e.key) && !!seen.add(e.key));
  const epics = pinFirst(all.filter((e) => !i.prefs.hidden[keyE(sk, undefined, e.key)]), (e) => keyE(sk, undefined, e.key), i.prefs.pinned);
  const list = q ? epics.filter((e) => has(e.summary, q) || has(e.key, q)) : epics;
  const ck = keyC(sk, undefined);
  if (!q) out.push({ key: `cap:${sk}`, kind: "components", level: 1, space: sk, hid: 0, hideEmpty: false, canHide: false, shape: "epics" });
  if (!epics.length && !tree.noEpic) { out.push({ key: `note:${sk}`, kind: "note", level: 1, text: "This space has no epics yet." }); return; }
  const cap = q || i.prefs.all[ck] ? list.length : EPICS_PER_COMPONENT;
  for (const e of list.slice(0, cap)) {
    out.push({ key: keyE(sk, undefined, e.key), kind: "epic", level: 1, space: sk, epic: e, shared: false, also: [], dim: e.status.category === "done" });
  }
  if (list.length > cap) out.push({ key: `more:${ck}`, kind: "more", level: 1, space: sk, n: list.length - cap });
  if (tree.noEpic > 0 && !q) out.push({ key: `noepic:${ck}`, kind: "noepic", level: 1, space: sk, n: tree.noEpic });
}

function componentRows(i: TreeInput, space: JiraSpace, tree: JiraSpaceTree, out: TreeRow[]): void {
  const q = i.q.trim().toLowerCase();
  const sk = space.key;
  const shape = shapeOf(i.prefs, sk);
  if (shape === "epics") { epicOnlyRows(i, space, tree, out); return; }
  const hideEmpty = i.prefs.hideEmpty[sk] === true;
  const comps = pinFirst(tree.components, (c) => keyC(sk, c.id ? c.name : undefined), i.prefs.pinned);
  const shown = comps.filter((c) => !i.prefs.hidden[keyC(sk, c.id ? c.name : undefined)]);
  const empties = shown.filter((c) => c.empty && c.id !== undefined);
  const canHide = empties.length > 0;
  const firstWithKids = shown.findIndex((c) => c.issues > 0);
  if (!q) out.push({ key: `cap:${sk}`, kind: "components", level: 1, space: sk, hid: hideEmpty ? empties.length : 0, hideEmpty, canHide, shape });
  if (!shown.length) { out.push({ key: `note:${sk}`, kind: "note", level: 1, text: "This space has no epics yet." }); return; }
  shown.forEach((c, ci) => {
    const none = c.id === undefined;
    const ck = keyC(sk, none ? undefined : c.name);
    if (hideEmpty && c.empty && !none && !q) return;
    const epics = pinFirst(c.epics.filter((e) => !i.prefs.hidden[keyE(sk, none ? undefined : c.name, e.key)]), (e) => keyE(sk, none ? undefined : c.name, e.key), i.prefs.pinned);
    const kids = epics.length + (c.noEpic > 0 ? 1 : 0);
    const matchedEpics = q ? epics.filter((e) => has(e.summary, q) || has(e.key, q)) : epics;
    const selfMatch = q ? has(c.name, q) : true;
    if (q && !selfMatch && !matchedEpics.length) return;
    const open = q ? true : i.prefs.open[ck] ?? ci === firstWithKids;
    out.push({ key: ck, kind: "component", level: 1, space: sk, name: c.name, issues: c.issues, empty: c.empty, none, open, hasKids: kids > 0 });
    if (!open || kids === 0) return;
    const list = q ? (selfMatch ? epics : matchedEpics) : epics;
    const cap = q || i.prefs.all[ck] ? list.length : EPICS_PER_COMPONENT;
    for (const e of list.slice(0, cap)) {
      const also = alsoUnder(e, none ? undefined : c.name);
      out.push({ key: keyE(sk, none ? undefined : c.name, e.key), kind: "epic", level: 2, space: sk, component: none ? undefined : c.name, epic: e, shared: also.length > 0, also, dim: e.status.category === "done" });
    }
    if (list.length > cap) out.push({ key: `more:${ck}`, kind: "more", level: 2, space: sk, component: none ? undefined : c.name, n: list.length - cap });
    if (c.noEpic > 0 && (!q || selfMatch)) out.push({ key: `noepic:${ck}`, kind: "noepic", level: 2, space: sk, component: none ? undefined : c.name, n: c.noEpic });
  });
}

/** The whole rail, top to bottom, as rows. */
export function buildRows(i: TreeInput): TreeRow[] {
  const out: TreeRow[] = [];
  const q = i.q.trim().toLowerCase();
  if (!i.prefs.hideMe && (!q || has("assigned to me", q))) out.push({ key: "me", kind: "me", label: "Assigned to me", level: 0, count: i.meCount });
  const viewsFor = (sk?: string) => i.views.filter((v) => (v.spaceKey ?? "") === (sk ?? "") && (!q || has(v.label, q)));
  if (!i.listed) {
    out.push({ key: "cap:spaces", kind: "caption", label: "Spaces", level: 0 });
    out.push({ key: "sk:spaces", kind: "skeleton", level: 0, widths: [70, 50, 62] });
  } else if (i.listError && !i.spaces.length) {
    out.push({ key: "cap:spaces", kind: "caption", label: "Spaces", level: 0 });
    out.push({ key: "note:list", kind: "note", level: 0, text: i.listError, error: true });
  } else if (i.spaces.length) {
    out.push({ key: "cap:spaces", kind: "caption", label: "Spaces", level: 0 });
    const order = pinFirst(i.spaces, (s) => keyS(s.key), i.prefs.pinned);
    order.forEach((s, idx) => {
      const read = i.reads[s.key];
      const tree = read?.tree;
      const own = viewsFor(s.key);
      const spaceHit = !q || has(s.name, q) || has(s.key, q);
      // A filter that matches nothing under a space leaves the space out, so a search is a list of hits.
      if (q && !spaceHit) {
        const probe: TreeRow[] = [];
        if (tree) componentRows(i, s, tree, probe);
        if (!probe.some((r) => r.kind === "component" || r.kind === "epic") && !own.length) return;
      }
      const open = isSpaceOpen(i, s, idx);
      out.push({
        key: keyS(s.key), kind: "space", level: 0, space: s, open,
        count: tree?.total ?? s.count,
        error: read?.state === "error" ? read.error : undefined,
        throttled: read?.state === "error" ? read.throttled : undefined,
        loading: read?.state === "loading" && !tree,
      });
      if (!open) return;
      if (!read || (read.state === "loading" && !tree)) {
        out.push({ key: `sk:${s.key}`, kind: "skeleton", level: 0, widths: [58, 44, 66] });
      } else if (tree) componentRows(i, s, tree, out);
      else if (read.state === "error") out.push({ key: `note:${s.key}`, kind: "note", level: 1, text: "Could not read this space.", error: true });
      if (own.length) {
        out.push({ key: `capv:${s.key}`, kind: "caption", label: "Boards and filters", level: 0 });
        for (const v of own) out.push({ key: `v:${v.id}`, kind: "view", level: 1, view: v, space: s.key });
      }
    });
  }
  const loose = viewsFor(undefined);
  if (loose.length) {
    out.push({ key: "cap:views", kind: "caption", label: "Boards and filters", level: 0 });
    for (const v of loose) out.push({ key: `v:${v.id}`, kind: "view", level: 0, view: v });
  }
  if (i.sprint && (!q || has(i.sprint, q))) {
    out.push({ key: "cap:sprints", kind: "caption", label: "Sprints", level: 0 });
    out.push({ key: "sprint", kind: "sprint", label: i.sprint, level: 0 });
  }
  if (i.looked > 0 && (!q || has("looked up", q))) {
    out.push({ key: "cap:looked", kind: "caption", label: "Looked up", level: 0 });
    out.push({ key: "looked", kind: "looked", label: `${i.looked} card${i.looked === 1 ? "" : "s"} by id`, level: 0, count: i.looked });
  }
  return out;
}

/** True when the row is the one the pane is on. */
export function rowSelected(r: TreeRow, sel: TreeSelection | null): boolean {
  if (!sel) return false;
  switch (r.kind) {
    case "space": return sel.kind === "space" && sel.space === r.space.key;
    case "component": return sel.kind === "component" && sel.space === r.space && (sel.component ?? "") === (r.none ? "" : r.name);
    case "epic": return sel.kind === "epic" && sel.space === r.space && sel.epic === r.epic.key && (sel.component ?? "") === (r.component ?? "");
    case "noepic": return sel.kind === "noepic" && sel.space === r.space && (sel.component ?? "") === (r.component ?? "");
    case "view": return sel.kind === "view" && sel.view === r.view.id;
    default: return false;
  }
}

/** What a click on a row selects; null for rows that select nothing (captions, notes, "Show N more"). */
export function targetOf(r: TreeRow): TreeSelection | null {
  switch (r.kind) {
    case "space": return { kind: "space", space: r.space.key };
    case "component": return { kind: "component", space: r.space, component: r.none ? undefined : r.name };
    case "epic": return { kind: "epic", space: r.space, component: r.component, epic: r.epic.key };
    case "noepic": return { kind: "noepic", space: r.space, component: r.component };
    case "view": return r.space ? { kind: "view", space: r.space, view: r.view.id } : null;
    default: return null;
  }
}

/**
 * The centre list a tree click opens: the cards of that place, read through a `scope:` id.
 * An epic with no component is the whole epic (the "Epics" layout, where one epic spans
 * components); an epic under a component is that component's share of it.
 * Ceiling: an epic under the "No component" group also reads as the whole epic.
 */
export function scopeIdOf(t: TreeSelection): string | null {
  switch (t.kind) {
    case "space": return scopeId({ space: t.space });
    case "component": return scopeId({ space: t.space, component: t.component ?? "" });
    case "epic": return t.epic ? scopeId({ space: t.space, component: t.component, epic: t.epic }) : null;
    case "noepic": return scopeId({ space: t.space, component: t.component, noEpic: true });
    default: return null;
  }
}

/** The rows a keyboard can land on, in order. */
export const focusable = (rows: TreeRow[]): TreeRow[] => rows.filter((r) => r.kind !== "caption" && r.kind !== "components" && r.kind !== "note" && r.kind !== "skeleton");

/** The text under the epic's name: done of total, or a zero. */
export function epicProgress(e: Pick<JiraTreeEpic, "done" | "total">): { pct: number; text: string; zero: boolean } {
  if (!e.total) return { pct: 0, text: "0", zero: true };
  return { pct: Math.round((e.done / e.total) * 100), text: `${e.done}/${e.total}`, zero: false };
}

/**
 * The tip an epic row wears, whole row: the summary, its key and status, then who holds it, who raised it,
 * how far along it is and where its cards are. The assignee's face carries no tip of its own.
 */
export function epicTip(e: JiraTreeEpic, also: string[]): TipSpec {
  const where = [...new Set([...e.components, ...also])];
  return {
    name: e.summary, detail: e.key, tag: e.status.name || undefined,
    rows: [
      { k: "Assignee", v: e.assignee?.name ?? "Unassigned" },
      { k: "Reporter", v: e.reporter?.name ?? "Unknown" },
      { k: "Progress", v: e.total ? `${e.done} of ${e.total} cards done` : "No cards" },
      ...(where.length ? [{ k: "Components", v: where.join(", ") }] : []),
    ],
  };
}

/* ------------------------------------------------------------------ menus */

export type TreeMenuId =
  | "open" | "jira" | "under" | "pin" | "hide" | "reread" | "copykey" | "copylink" | "copyaddr"
  | "collapse" | "hideempty" | "showhidden" | "takeoff" | "hideme" | "rename" | "edit"
  | "shape:both" | "shape:epics" | "shape:components" | "shape:flat";
type TItem = MenuItem<TreeMenuId>;
type TRow = MenuRow<TreeMenuId>;

const it = (id: TreeMenuId, label: string, icon: TItem["icon"], o: Partial<TItem> = {}): TItem => ({ kind: "item", id, label, icon, ...o });
const sect = (text: string, ...items: TItem[]): TRow[] => [{ kind: "heading", text }, ...items];
const rule: TRow = { kind: "rule" };
const join = (...groups: TRow[][]): TRow[] => groups.flatMap((g, i) => (i ? [rule, ...g] : g));
const cut = (s: string, n = 32): string => (s.length > n ? `${s.slice(0, n - 2)}…` : s);
const menu = (head: string, rows: TRow[], close?: TItem): CardMenu<TreeMenuId> =>
  ({ head: cut(head), rows, more: [], close: close ?? it("takeoff", "", "x"), closeAbsent: !close });

export interface MenuFacts { hidden: number; site: boolean; pinned: boolean }

/** The layout section of a space's menu and of the Components header's: one entry per shape, the one in force marked. */
export const shapeItems = (now: TreeShape): TItem[] =>
  SHAPES.map((x) => it(`shape:${x.id}`, x.label, x.id === "epics" ? "box" : "layers", { sub: x.sub, hint: x.id === now ? "On" : undefined, strong: x.id === now }));
/** The menu the layout button opens. */
export function shapeMenu(space: string, now: TreeShape): CardMenu<TreeMenuId> {
  return menu(`${space} · Layout`, sect("Show this space as", ...shapeItems(now)), it("takeoff", "", "x"));
}

export function spaceMenu(s: JiraSpace, f: MenuFacts, shape: TreeShape = "both"): CardMenu<TreeMenuId> {
  return menu(`${s.name} · ${s.key} · Space`, join(
    sect(`Space · ${s.name}`, it("open", "Open space", "lines", { sub: "Every epic and board", hint: "⏎", strong: true }), it("jira", "Open in Jira", "ext", f.site ? { sub: "In your browser", hint: "O" } : { why: "No site connected", hint: "O" })),
    sect("Show this space as", ...shapeItems(shape)),
    sect("In the sidebar", it("collapse", "Collapse components", "down", { hint: "←" }), it("pin", f.pinned ? "Unpin" : "Pin to top", "pin", { hint: "T" }), it("reread", "Read this space again", "refresh", { sub: "No other space is touched", hint: "R" }),
      ...(f.hidden ? [it("showhidden", `Show what you hid (${f.hidden})`, "eyeon", { sub: "Components and epics hidden here", hint: "V" })] : [])),
    sect("Copy", it("copykey", "Copy key", "copy", { sub: s.key, hint: "K" }), it("copyaddr", "Copy address", "copy", f.site ? { sub: "Address of the project", hint: "L" } : { why: "No site connected", hint: "L" })),
  ), it("takeoff", "Take off this bar", "x", { sub: "Only here, Jira keeps everything", danger: true }));
}

export function componentMenu(space: string, c: Pick<JiraTreeComponent, "name" | "issues" | "empty">, f: MenuFacts & { empties: string[]; none: boolean }): CardMenu<TreeMenuId> {
  const isEmpty = c.empty && !f.none;
  return menu(`${c.name} · Component`, join(
    sect(`Component · ${c.name}`,
      it("open", c.issues ? `Open all ${c.issues} issues` : "Open all issues", "lines", c.issues ? { sub: "Every epic and card in it", hint: "⏎", strong: true } : { why: "No issues in it", hint: "⏎", strong: true }),
      it("jira", "Open in Jira", "ext", f.site ? { sub: "Issues in this component", hint: "O" } : { why: "No site connected", hint: "O" })),
    sect("In the sidebar",
      ...(isEmpty && f.empties.length ? [it("hideempty", "Hide empty components", "eyeon", { sub: `${f.empties.slice(0, 2).join(" and ")}${f.empties.length > 2 ? ` +${f.empties.length - 2}` : ""}, ${f.empties.length} of them`, hint: "V" })] : [
        it("collapse", "Collapse its epics", "down", { hint: "←" }), it("pin", f.pinned ? "Unpin" : "Pin to top", "pin", { sub: `Keeps it first in ${space}`, hint: "T" })]),
      ...(f.none ? [] : [it("hide", "Hide this component", "eye", { sub: "Only here, not in Jira", hint: "H" })]),
      ...(isEmpty ? [] : [it("reread", "Read it again", "refresh", { hint: "R" })])),
    ...(isEmpty || !f.site ? [] : [sect("Copy", it("copylink", "Copy link", "copy", { sub: "The Jira address of its issues", hint: "L" }))]),
  ));
}

export function epicMenu(e: JiraTreeEpic, component: string, also: string[], f: MenuFacts): CardMenu<TreeMenuId> {
  return menu(`${e.key} · ${e.summary}`, join(
    sect(`Epic · ${e.key}`,
      it("open", "Open this epic", "lines", { sub: e.total ? `${e.done} of ${e.total} cards done` : "No cards yet", hint: "⏎", strong: true }),
      it("jira", "Open in Jira", "ext", f.site ? { sub: "In your browser", hint: "O" } : { why: "No site connected", hint: "O" }),
      ...(also.length ? [it("under", `Show it under ${also[0]}`, "down", { sub: `It sits under ${also.length + 1} components`, hint: "G" })] : [])),
    sect("In the sidebar", it("pin", f.pinned ? "Unpin" : "Pin to top", "pin", { sub: component ? `Keeps it first under ${component}` : "Keeps it first", hint: "T" }), it("hide", component ? "Hide from this component" : "Hide from the sidebar", "eye", { sub: "Only here, not in Jira", hint: "H" }), it("reread", "Read this epic again", "refresh", { hint: "R" })),
    sect("Copy", it("copykey", "Copy key", "copy", { sub: e.key, hint: "K" }), it("copylink", "Copy link", "copy", f.site ? { sub: "The Jira address of this epic", hint: "L" } : { why: "No site connected", hint: "L" })),
  ));
}

export function meMenu(count: number | undefined): CardMenu<TreeMenuId> {
  return menu(`Assigned to me${count != null ? ` · ${count}` : ""}`, join(
    sect("View · Assigned to me", it("open", "Open", "user", { sub: "Your open cards", hint: "⏎", strong: true }), it("reread", "Read it again", "refresh", { sub: "All your spaces", hint: "R" })),
    sect("In the sidebar", it("hideme", "Hide from the sidebar", "eye", { sub: "Bring it back from the + menu", hint: "H" })),
  ));
}

export function viewMenu(v: TreeView, f: MenuFacts): CardMenu<TreeMenuId> {
  const what = v.kind === "board" ? "Board" : v.kind === "filter" ? "Filter" : "Search";
  return menu(`${v.label} · ${what}`, join(
    sect(`${what} · ${v.label}`, it("open", "Open", "lines", { sub: v.count != null ? `${v.count} cards` : undefined, hint: "⏎", strong: true }), it("jira", "Open in Jira", "ext", f.site ? { sub: `The ${what.toLowerCase()}, in your browser`, hint: "O" } : { why: "No site connected", hint: "O" })),
    sect("Edit", it("rename", "Rename", "edit", { sub: "Only in this sidebar", hint: "N" }), it("edit", "Edit the search", "lines", { why: "Change it in Jira", hint: "E" })),
    sect("Copy", it("copyaddr", "Copy address", "copy", { hint: "L" })),
  ), it("takeoff", "Take off this bar", "x", { sub: "Only here, Jira keeps everything", danger: true }));
}

/* ------------------------------------------------------------ addresses */

const baseOf = (site: string): string => (/^https?:\/\//i.test(site) ? site : `https://${site}`).replace(/\/+$/, "");
/** Jira sends `/browse/KEY` to a card or to a project alike, on Cloud and on Data Center. */
export const browseUrl = (site: string, key: string): string => `${baseOf(site)}/browse/${encodeURIComponent(key)}`;
/** The issues of a component, as a search: the one address Jira has for "everything in it". */
export function componentUrl(site: string, space: string, component: string | undefined): string {
  const clause = component === undefined ? "component is EMPTY" : `component = "${component.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `${baseOf(site)}/issues/?jql=${encodeURIComponent(`project = ${space} AND ${clause} ORDER BY created DESC`)}`;
}

/** A stable colour for a space or an epic, from the graph palette the house already has. */
export function toneOf(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--graph-${(h % 8) + 1})`;
}
