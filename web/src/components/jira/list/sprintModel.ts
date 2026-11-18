/*
 * The Sprint group of the Filters popover as plain data. Values come from the cards' own sprint fields (name, active, closed,
 * start and end), so a card read before the site said anything about its sprint is simply "no sprint".
 *
 * A pick is a token: "@current" (a sprint running now), "@next" (the soonest future one), "@none" (in no sprint) or
 * "n:<name>" for one sprint by name. A card shows when it answers ANY picked token.
 */
import type { ProviderTask } from "../../../../../shared/providers.ts";

export const CURRENT = "@current", NEXT = "@next", NONE = "@none";
export const byName = (name: string): string => `n:${name}`;
export const WEEKS_CLOSED = 6;
const WEEK = 7 * 86_400_000;

type SprintCard = Pick<ProviderTask, "sprint" | "sprintActive" | "sprintState" | "sprintStart" | "sprintEnd">;
const kindOf = (t: SprintCard): "none" | "active" | "closed" | "future" => (!t.sprint ? "none" : t.sprintActive ? "active" : t.sprintState === "closed" ? "closed" : "future");

/** One board's sprints as its context reads them (the card menu's source): the running one and every future one, with dates. */
export interface SprintBoard { active?: { name: string; start?: number; end?: number }; futures: readonly { name: string; start?: number; end?: number }[] }
export const boardOf = (c: { sprint?: { name: string; start?: number; end?: number }; next?: { name: string; start?: number; end?: number }; futures?: readonly { name: string; start?: number; end?: number }[] }): SprintBoard =>
  ({ ...(c.sprint ? { active: c.sprint } : {}), futures: c.futures ?? (c.next ? [c.next] : []) });

/** Next sprint of the boards in view: the earliest future sprint of EACH board (the first one in the board's order on a tie). */
export function boardNextNames(boards: readonly SprintBoard[]): string[] {
  return boards.flatMap((b) => {
    const dated = [...b.futures].sort((x, y) => (x.start ?? Infinity) - (y.start ?? Infinity));
    return dated[0] ? [dated[0].name] : [];
  });
}

/** The future sprint(s) that start soonest: what "Next sprint" means. `known` is the boards' own answer (when read), which wins over the cards,
 *  because the soonest future sprint may hold no card yet. A future sprint with no date never beats a dated one. */
export function nextNames(cards: readonly SprintCard[], known?: readonly string[]): Set<string> {
  if (known?.length) return new Set(known);
  const kept = NEXT_OF.get(cards);
  if (kept) return kept;
  const out = readNext(cards);
  NEXT_OF.set(cards, out);
  return out;
}
/* Read once per card list (by identity), not once per card: a filter pass asks it for every card. */
const NEXT_OF = new WeakMap<readonly SprintCard[], Set<string>>();
function readNext(cards: readonly SprintCard[]): Set<string> {
  const future = cards.filter((t) => kindOf(t) === "future");
  const starts = future.map((t) => t.sprintStart || Infinity);
  const soon = Math.min(...starts);
  if (!future.length) return new Set();
  return new Set(future.filter((t) => (t.sprintStart || Infinity) === soon).map((t) => t.sprint!));
}

/** Whether a card answers the picks; no picks passes everything. `all` is every card the board holds (what "next" is read from). */
export function sprintPasses(t: SprintCard, pick: readonly string[], all: readonly SprintCard[], known?: readonly string[]): boolean {
  if (!pick.length) return true;
  const k = kindOf(t);
  return pick.some((p) => p === CURRENT ? k === "active" : p === NONE ? k === "none" : p === NEXT ? k === "future" && nextNames(all, known).has(t.sprint!) : p === byName(t.sprint ?? "\0"));
}

/** Old state: "sprintOnly" held "@running" or one sprint's name. "@running" reads as the Current pick and the old field is let go;
 *  a sprint's name is the epic-scope Display menu's own and stays in sprintOnly. */
export function migrateSprintOnly(k: { sprintOnly?: string | null; sprintPick?: string[] }): { sprintOnly?: null; sprintPick?: string[] } {
  if (k.sprintOnly !== "@running") return {};
  return { sprintOnly: null, sprintPick: [...new Set([...(k.sprintPick ?? []), CURRENT])] };
}

/** Whether the site is asked for open sprints only: Current is the one pick (or the old running toggle is on). With other picks beside it
 *  (the backlog, a closed sprint) the site's answer would drop the cards they name. */
export const sprintNarrow = (sprintOnly: string | null | undefined, sprintPick: readonly string[] | undefined): boolean =>
  sprintOnly === "@running" || (sprintPick?.length === 1 && sprintPick[0] === CURRENT);

export interface SprintRow { id: string; label: string; count: number; on: boolean; section: "Now" | "Other open sprints" | "Recently closed" | "Older"; /** "INF 47 · ends Thu". */ tag?: string; /** "active", "closed 31 Oct". */ note?: string }

const day = (ms: number, withWeekday: boolean): string => new Date(ms).toLocaleDateString("en-GB", withWeekday ? { weekday: "short", day: "numeric", timeZone: "UTC" } : { day: "numeric", month: "short", timeZone: "UTC" });

/** The rows, in the order the pane draws them: Now, other open, recently closed (6 weeks), older. Counts are over `cards`. */
export function sprintRows(cards: readonly SprintCard[], pick: readonly string[], now: number, boards: readonly SprintBoard[] = []): SprintRow[] {
  const count = (fn: (t: SprintCard) => boolean) => cards.filter(fn).length;
  const on = (id: string) => pick.includes(id);
  /* What the boards say about a sprint: its kind and dates, even with no card in it. */
  const meta = new Map<string, { kind: "active" | "future"; start?: number; end?: number }>();
  for (const b of boards) {
    if (b.active) meta.set(b.active.name, { kind: "active", ...(b.active.start ? { start: b.active.start } : {}), ...(b.active.end ? { end: b.active.end } : {}) });
    for (const f of b.futures) if (!meta.has(f.name)) meta.set(f.name, { kind: "future", ...(f.start ? { start: f.start } : {}), ...(f.end ? { end: f.end } : {}) });
  }
  const active = [...new Set([...cards.filter((t) => kindOf(t) === "active").map((t) => t.sprint!), ...[...meta].filter(([, m]) => m.kind === "active").map(([n]) => n)])];
  const soon = nextNames(cards, boardNextNames(boards));
  const finite = (xs: number[]) => (xs.length ? Math.min(...xs) : Infinity);
  const endOf = (name: string) => finite([...cards.filter((t) => t.sprint === name && t.sprintEnd).map((t) => t.sprintEnd!), ...(meta.get(name)?.end ? [meta.get(name)!.end!] : [])]);
  const startOf = (name: string) => finite([...cards.filter((t) => t.sprint === name && t.sprintStart).map((t) => t.sprintStart!), ...(meta.get(name)?.start ? [meta.get(name)!.start!] : [])]);
  const span = (n: string) => (Number.isFinite(startOf(n)) && Number.isFinite(endOf(n)) ? `${day(startOf(n), false)} – ${day(endOf(n), false)}` : "");
  const out: SprintRow[] = [];
  const cur = active.length ? { tag: active.length === 1 ? `${active[0]}${Number.isFinite(endOf(active[0]!)) ? ` · ends ${day(endOf(active[0]!), true)}` : ""}` : `${active.length} running` } : {};
  out.push({ id: CURRENT, label: "Current sprint", count: count((t) => kindOf(t) === "active"), on: on(CURRENT), section: "Now", ...cur });
  const nx = [...soon];
  out.push({ id: NEXT, label: "Next sprint", count: count((t) => kindOf(t) === "future" && soon.has(t.sprint!)), on: on(NEXT), section: "Now",
    ...(nx.length ? { tag: `${nx[0]}${Number.isFinite(startOf(nx[0]!)) ? ` · starts ${day(startOf(nx[0]!), true)}` : ""}` } : {}) });
  out.push({ id: NONE, label: "No sprint", count: count((t) => kindOf(t) === "none"), on: on(NONE), section: "Now", note: "backlog" });
  const names = [...new Set([...cards.filter((t) => t.sprint).map((t) => t.sprint!), ...meta.keys()])];
  const first = (n: string) => cards.find((t) => t.sprint === n);
  const cutoff = now - WEEKS_CLOSED * WEEK;
  const rows = names.map((n): SprintRow | null => {
    const t = first(n), k = t ? kindOf(t) : meta.get(n)!.kind, c = count((x) => x.sprint === n), end = endOf(n);
    const base = { id: byName(n), label: n, count: c, on: on(byName(n)) };
    if (k === "future") return soon.has(n) ? null : { ...base, section: "Other open sprints", note: span(n) ? `future · ${span(n)}` : "future" };
    if (k === "active") return active.length === 1 ? null : { ...base, section: "Other open sprints", note: "active" };
    if (k === "closed") return Number.isFinite(end) && end >= cutoff ? { ...base, section: "Recently closed", note: `closed ${day(end, false)}`, _end: end } as SprintRow : { ...base, section: "Older", note: Number.isFinite(end) ? `closed ${day(end, false)}` : "closed", _end: Number.isFinite(end) ? end : 0 } as SprintRow;
    return null;
  }).filter((r): r is SprintRow => !!r);
  /* A lone active sprint is already under Current sprint, so it is not listed again; with several running they are listed by name so one can be picked alone. */
  const rank = (r: SprintRow) => (r as SprintRow & { _end?: number })._end ?? 0;
  const order = ["Other open sprints", "Recently closed", "Older"] as const;
  for (const sec of order) out.push(...rows.filter((r) => r.section === sec).sort((a, b) => sec === "Other open sprints" ? a.label.localeCompare(b.label) : rank(b) - rank(a)).map(({ ...r }) => { delete (r as { _end?: number })._end; return r; }));
  return out;
}

/** The sentence part for the sprint picks: "current sprint or Orbit Sprint 12". */
export function sprintSentence(pick: readonly string[]): string {
  return pick.map((p) => p === CURRENT ? "current sprint" : p === NEXT ? "next sprint" : p === NONE ? "no sprint" : p.replace(/^n:/, "")).join(" or ");
}
