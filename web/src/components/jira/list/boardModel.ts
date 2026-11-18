/*
 * The Jira board's rules, apart from the screen: how wide a column is, how many fit, when the sidebar folds to its rail,
 * how many columns hide past the right edge, which key does what, and the small JQL the search box understands.
 *
 * A column has ONE width in every state: 280 comfortable, 232 compact. It never stretches to fill the room and never
 * shrinks when the card panel opens; the room left over stays empty on the right, and what does not fit scrolls. A
 * column that stretched read as a different card each time the panel moved, and a squeezed one dropped its PR chip.
 */
import type { ProviderTask } from "../../../../../shared/providers.ts";
import type { MoveFacts } from "./menus/menuModel.ts";
import { keyOf } from "./laneModel.ts";

export type BoardMode = "list" | "board";
export type BoardDensity = "comfortable" | "compact";
/** How the board splits its cards into rows; columns stay one set across every row. */
export type BoardLanes = "none" | "epic" | "assignee" | "priority" | "agent";
/** Where an agentglass session stands on a card, for the Agent swimlanes; null is no session. */
export type AgentLane = "needs" | "working" | "finished" | null;
const AGENT_ORDER = ["needs", "working", "finished"] as const;
const AGENT_NAME: Record<(typeof AGENT_ORDER)[number], string> = { needs: "Agent needs you", working: "Agent working", finished: "Agent finished" };

export const CARD_W: Readonly<Record<BoardDensity, number>> = { comfortable: 280, compact: 232 };
/** Between two columns. */
export const BOARD_GAP = 12;
/** The board's own inset, both sides together. */
export const BOARD_PAD = 24;
/** The sidebar folded to its rail. */
export const RAIL_W = 34;
/** How long the pointer rests on the rail before the sidebar opens over the board. */
export const RAIL_PEEK_MS = 150;

/** The width the columns take, edge to edge. */
export const trackWidth = (n: number, d: BoardDensity): number => (n <= 0 ? 0 : n * CARD_W[d] + (n - 1) * BOARD_GAP);

/** Whole columns a board this wide shows without scrolling: the left inset, then columns up to the right edge. */
export function columnsThatFit(width: number, d: BoardDensity): number {
  const room = width - BOARD_PAD / 2;
  if (room < CARD_W[d]) return 0;
  return 1 + Math.floor((room - CARD_W[d]) / (CARD_W[d] + BOARD_GAP));
}

/**
 * Whether the sidebar folds to its rail on its own: only when, with it docked, the board would have room for fewer than
 * two columns. `boardWidth` is what the board has now; `railFolded` says whether that already counts the rail, so the
 * rule asks the same question folded or not and a fold that frees room does not unfold it again on the next frame.
 */
export function railFolds(o: { boardWidth: number; sidebarWidth: number; railFolded: boolean; density: BoardDensity; pinned: boolean }): boolean {
  if (o.pinned) return false;
  const docked = o.railFolded ? o.boardWidth - (o.sidebarWidth - RAIL_W) : o.boardWidth;
  return docked < trackWidth(2, o.density) + BOARD_PAD;
}

/** The columns whose right edge is past what the board shows: the "+N columns" pill. */
export function hiddenRight(o: { scrollLeft: number; clientWidth: number; columns: number; density: BoardDensity }): number {
  const w = CARD_W[o.density];
  const edge = o.scrollLeft + o.clientWidth;
  let n = 0;
  for (let i = 0; i < o.columns; i++) if (BOARD_PAD / 2 + i * (w + BOARD_GAP) + w > edge + 1) n++;
  return n;
}

/** Where to scroll so the first hidden column starts at the left edge. */
export function nextColumnLeft(o: { scrollLeft: number; clientWidth: number; columns: number; density: BoardDensity }): number {
  const step = CARD_W[o.density] + BOARD_GAP;
  const first = o.columns - hiddenRight(o);
  return Math.max(0, first * step);
}

/** Dropping a card on a column: the move that gets it there, or why it can't be made from a drop. */
export type DropOutcome = { ok: true; key: string; toStatus: string } | { ok: false; reason: string };

/** Which of a card's reachable steps lands it in `toStatus`, given the same steps the Status menu reads.
 *  A step that needs a form, or a column with no step to it, is refused, so a drop into it snaps the card back. */
export function dropDecision(moves: MoveFacts, toStatus: string): DropOutcome {
  if (moves === "reading") return { ok: false, reason: "Reading the steps…" };
  if ("error" in moves) return { ok: false, reason: moves.error || "Could not read the steps" };
  const m = moves.to.find((x) => x.status === toStatus);
  if (!m || !m.key) return { ok: false, reason: `No step to ${toStatus}` };
  if (m.asks) return { ok: false, reason: "Needs details — use Move to…" };
  return { ok: true, key: m.key, toStatus: m.status };
}

export type BoardKey = "mode" | "density" | "rail" | "search" | "legend" | "view" | "filters" | "agents" | "needs";
/** `b` List/Board, `d` density, `v` the view builder, `Shift+F` the Filters menu (`f` alone is the card dock's maximise), `[` the sidebar, `/` the search box, `?` the key legend; never while typing, never with a modifier. */
export function boardKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }, typing: boolean): BoardKey | null {
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "b" || e.key === "B") return "mode";
  if (e.key === "d" || e.key === "D") return "density";
  if (e.key === "v" || e.key === "V") return "view";
  if (e.key === "F") return "filters";
  // a: the cards by where they stand with their agents, and back (board: swimlanes; list: the grouping).
  if (e.key === "a" || e.key === "A") return "agents";
  // n: only the cards whose agent waits on you, and back: the Needs you quick toggle.
  if (e.key === "n" || e.key === "N") return "needs";
  if (e.key === "[") return "rail";
  if (e.key === "/") return "search";
  if (e.key === "?") return "legend";
  return null;
}

export interface BoardRow { id: string; label: string; cards: ProviderTask[] }
const PRIORITY_ORDER = ["urgent", "high", "normal", "low"] as const;
const PRIORITY_NAME: Record<(typeof PRIORITY_ORDER)[number], string> = { urgent: "Highest", high: "High", normal: "Medium", low: "Low" };

const isSub = (t: Pick<ProviderTask, "issueType">): boolean => /^sub-?task$/i.test((t.issueType ?? "").replace(/\s+/g, ""));

/** A card's epic: its parent, or for a sub-task its parent's epic (the server's `epic`, else the parent's own row when it is on the board). */
export function epicOf(t: ProviderTask, cards: readonly ProviderTask[] = []): { key: string; title: string } | undefined {
  if (!isSub(t)) return t.parent;
  if (t.epic) return t.epic;
  const home = t.parent ? homes(cards).get(t.parent.key) : undefined;
  return home && !isSub(home) ? home.parent : undefined;
}
/* The first card of each key, built once per card list (by identity): a filter pass asks for every sub-task's parent. */
const HOMES = new WeakMap<readonly ProviderTask[], Map<string, ProviderTask>>();
function homes(cards: readonly ProviderTask[]): Map<string, ProviderTask> {
  let m = HOMES.get(cards);
  if (!m) { m = new Map(); for (const c of cards) { const k = c.customId ?? c.id; if (!m.has(k)) m.set(k, c); } HOMES.set(cards, m); }
  return m;
}

/** Which chips a card's header carries. A sub-task shows its parent (`↳ parent`) and, off an epic's own page, its epic too;
 *  on an epic's page every card is in that epic, so the epic chip is dropped. A card with no sub-task parent shows its epic. */
export function headChips(t: Pick<ProviderTask, "issueType" | "parent" | "epic">, epicPage: boolean): { parent: boolean; epic: boolean } {
  if (isSub(t) && t.parent) return { parent: true, epic: !epicPage && !!t.epic };
  return { parent: false, epic: !!(t.parent ?? t.epic) };
}

/** True when the board is one epic's page: lanes by epic, or every card sits in the same single epic. */
export function isEpicPage(cards: readonly ProviderTask[], lanes: BoardLanes): boolean {
  if (lanes === "epic") return true;
  if (!cards.length) return false;
  const keys = new Set(cards.map((c) => epicOf(c, cards)?.key ?? ""));
  return keys.size === 1 && !keys.has("");
}

/** The board's rows: one unnamed row, or one per epic, person, priority or agent state, the "none of these" row last. Order inside a row is kept. */
export function laneOf(cards: readonly ProviderTask[], by: BoardLanes, agentOf: (t: ProviderTask) => AgentLane = () => null): BoardRow[] {
  if (by === "none") return [{ id: "all", label: "", cards: [...cards] }];
  const rows = new Map<string, BoardRow>();
  const put = (id: string, label: string, t: ProviderTask) => {
    const r = rows.get(id) ?? { id, label, cards: [] };
    r.cards.push(t);
    rows.set(id, r);
  };
  for (const t of cards) {
    if (by === "epic") { const e = epicOf(t, cards); if (e) put(`e:${e.key}`, e.title || e.key, t); else put("~", "No epic", t); }
    else if (by === "assignee") { const who = t.people?.[0]?.name ?? t.assignees[0]; if (who) put(`a:${who}`, who, t); else put("~", "Unassigned", t); }
    else if (by === "agent") { const a = agentOf(t); if (a) put(`g:${a}`, AGENT_NAME[a], t); else put("~", "No agent", t); }
    else { if (t.priority) put(`p:${t.priority}`, PRIORITY_NAME[t.priority], t); else put("~", "No priority", t); }
  }
  const out = [...rows.values()];
  const rank = (r: BoardRow) => (r.id === "~" ? 1e9 : by === "priority" ? PRIORITY_ORDER.indexOf(r.id.slice(2) as (typeof PRIORITY_ORDER)[number])
    : by === "agent" ? AGENT_ORDER.indexOf(r.id.slice(2) as (typeof AGENT_ORDER)[number]) : 0);
  return out.sort((a, b) => rank(a) - rank(b) || (by === "priority" || by === "agent" ? 0 : a.label.localeCompare(b.label)));
}

/* ---------- the search box's JQL ---------- */

/** A clause or two of JQL: `field = value`, `!=`, `~`, `in (...)`, joined by AND. Anything else is plain search. */
const CLAUSE = /^\s*([a-z][a-z ]*?)\s*(!=|=|~|not in|in)\s*(\([^)]*\)|"[^"]*"|'[^']*'|[^\s"']+)\s*$/i;
const FIELD: Record<string, (t: ProviderTask) => string[]> = {
  key: (t) => [keyOf(t)],
  issuekey: (t) => [keyOf(t)],
  status: (t) => [t.status],
  assignee: (t) => [...t.assignees, ...(t.people ?? []).map((p) => p.name)],
  labels: (t) => t.tags,
  label: (t) => t.tags,
  priority: (t) => (t.priority ? [t.priority] : []),
  type: (t) => (t.issueType ? [t.issueType] : []),
  issuetype: (t) => (t.issueType ? [t.issueType] : []),
  epic: (t) => (t.parent ? [t.parent.key, t.parent.title] : []),
  parent: (t) => (t.parent ? [t.parent.key, t.parent.title] : []),
  sprint: (t) => (t.sprint ? [t.sprint] : []),
  summary: (t) => [t.title],
  text: (t) => [t.title, keyOf(t)],
};
const unquote = (v: string): string => v.replace(/^["']|["']$/g, "");

/** Whether the box holds JQL rather than words: an operator in it. The site is asked only then. */
export const looksJql = (q: string): boolean => /(!=|=|~|\bin\s*\()/i.test(q.replace(/\s+order\s+by\s+.*$/i, ""));
/** How long the box rests before the site is asked: one search per pause, never per keystroke. */
export const JQL_REST_MS = 400;

/** The clauses of a query that reads as JQL, or null for plain search text. An unknown field is plain text too. */
export function parseJql(q: string): { field: string; op: string; values: string[] }[] | null {
  const body = q.replace(/\s+order\s+by\s+.*$/i, "").trim();
  if (!looksJql(body)) return null;
  const out: { field: string; op: string; values: string[] }[] = [];
  for (const part of body.split(/\s+and\s+/i)) {
    const m = CLAUSE.exec(part);
    if (!m) return null;
    const field = m[1]!.trim().toLowerCase().replace(/\s+/g, "");
    if (!FIELD[field]) return null;
    const raw = m[3]!;
    const values = raw.startsWith("(") ? raw.slice(1, -1).split(",").map((v) => unquote(v.trim())).filter(Boolean) : [unquote(raw)];
    out.push({ field, op: m[2]!.toLowerCase(), values });
  }
  return out.length ? out : null;
}

/** Whether a card answers every clause. Comparisons ignore case, as Jira's do for these fields. */
export function matchesJql(t: ProviderTask, clauses: readonly { field: string; op: string; values: string[] }[]): boolean {
  return clauses.every((c) => {
    const have = FIELD[c.field]!(t).map((v) => v.toLowerCase());
    const want = c.values.map((v) => v.toLowerCase());
    if (c.op === "~") return want.every((w) => have.some((h) => h.includes(w)));
    const hit = want.some((w) => have.includes(w));
    return c.op === "=" || c.op === "in" ? hit : !hit;
  });
}

/** A column starts as a thin bar when the person folded it, or when it is empty and they never opened it by hand. A column that gains cards opens. */
export function startsCollapsed(o: { count: number; folded: boolean; opened: boolean }): boolean {
  return o.folded || (o.count === 0 && !o.opened);
}

/** While a card is dragged, a bar opens only when the card could land there; the others stay bars. */
export function opensForDrag(o: { collapsed: boolean; allowed: boolean }): boolean {
  return o.collapsed && o.allowed;
}

/** After a drop the target stays open (kept as "opened by hand") only when it was a bar: a column with cards needs no entry, and an entry would keep it open after it empties. */
export function staysOpenAfterDrop(opened: ReadonlySet<string>, target: string, wasBarred = true): ReadonlySet<string> {
  return wasBarred ? new Set([...opened, target]) : opened;
}

/** "Opened by hand" is kept per board, so a column opened on one board does not open the same-named empty column on another. Pruned to the board's own columns on write. */
export function openedKey(board: string, status: string): string {
  return `${board}\u0000${status}`;
}
export function pruneOpened(opened: ReadonlySet<string>, board: string, statuses: readonly string[]): ReadonlySet<string> {
  const mine = `${board}\u0000`;
  const live = new Set(statuses.map((s) => openedKey(board, s)));
  return new Set([...opened].filter((k) => !k.startsWith(mine) || live.has(k)));
}

/** Shift on a column header. A bar (empty or folded) brings every column back; an open column keeps only itself open (the others fold). Lane folds are left alone. */
export function shiftToggle(o: { status: string; all: readonly string[]; barred: boolean; folded: ReadonlySet<string>; opened: ReadonlySet<string>; laneKey: string; board: string }): { folded: ReadonlySet<string>; opened: ReadonlySet<string> } {
  const lanes = [...o.folded].filter((k) => k.startsWith(o.laneKey));
  if (o.barred) return { folded: new Set(lanes), opened: new Set([...o.opened, ...o.all.map((s) => openedKey(o.board, s))]) };
  return { folded: new Set([...lanes, ...o.all.filter((s) => s !== o.status)]), opened: o.opened };
}
