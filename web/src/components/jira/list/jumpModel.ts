/*
 * The jump palette's rules as plain functions (index.html:325-327 and 1001-1004 in the mockup): what a typed line means,
 * and which rows each section shows. Nothing here reads the site or the screen.
 *
 * Ceiling: RECENT keeps the last 4 searches per project in this browser; it is not synced between machines.
 */
import type { JiraBoardEpic, ProviderTask } from "../../../../../shared/providers.ts";
import type { JiraSpaceTree } from "../../../../../shared/jiraSpaces.ts";
import { looksJql } from "./boardModel.ts";
import { keyOf } from "./laneModel.ts";
import { rankQueries, type SavedQuery } from "./tabsModel.ts";

export const SAVED_CAP = 7;
export const CARDS_CAP = 6;
export const RECENT_KEEP = 4;

export type Typed =
  | { kind: "none" }
  | { kind: "key"; key: string }
  | { kind: "jql"; jql: string };

const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** The project the board's cards live in: the prefix most of their keys share. "" when there are no cards. */
export function projectOf(cards: readonly ProviderTask[]): string {
  const n = new Map<string, number>();
  for (const t of cards) {
    const m = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(keyOf(t));
    if (m) { const p = m[1]!.toUpperCase(); n.set(p, (n.get(p) ?? 0) + 1); }
  }
  let best = ""; let top = 0;
  for (const [k, v] of n) if (v > top) { best = k; top = v; }
  return best;
}

/** A bare number is `<PROJECT>-n`, a full key is itself, `q:` or text that parses as JQL is a search. */
export function readTyped(text: string, project: string): Typed {
  const t = text.trim();
  if (!t) return { kind: "none" };
  if (/^q:/i.test(t)) { const jql = t.slice(2).trim(); return jql ? { kind: "jql", jql } : { kind: "none" }; }
  if (/^\d+$/.test(t)) return project ? { kind: "key", key: project + "-" + t } : { kind: "none" };
  if (KEY.test(t)) return { kind: "key", key: t.toUpperCase() };
  if (looksJql(t)) return { kind: "jql", jql: t };
  return { kind: "none" };
}

/**
 * How well `hay` answers what was typed: 0 is no match. Every typed word must match; a whole word scores 4, the start of a
 * word 3, any stretch inside one 1, so "ssrf" finds "Security - SSRF" and "sec" ranks it above "insecure".
 * Ceiling: no typo tolerance and no reordering of letters; that is the saved-query ranker's job, not the words'.
 */
export function matchScore(hay: string, needle: string): number {
  const ws = needle.toLowerCase().split(/\s+/).filter(Boolean);
  if (!ws.length) return 1;
  const h = hay.toLowerCase();
  const words = h.split(/[^a-z0-9]+/).filter(Boolean);
  let total = 0;
  for (const w of ws) {
    const s = words.includes(w) ? 4 : words.some((x) => x.startsWith(w)) ? 3 : h.includes(w) ? 1 : 0;
    if (!s) return 0;
    total += s;
  }
  return total;
}
const has = (hay: string, needle: string) => matchScore(hay, needle) > 0;

/** Matching items best first; the sort is stable, so equal scores keep their order. */
function bestFirst<T>(list: readonly T[], needle: string, hay: (t: T) => string): T[] {
  return list.map((t, i) => ({ t, i, s: matchScore(hay(t), needle) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.t);
}

/** A sidebar place the jump box can open like a click on its row. */
export interface Place { id: string; kind: "space" | "component" | "epic"; name: string; /** Space key, or the epic's key. */ key: string; space: string; component?: string }
export const PLACES_CAP = 8;

/** The sidebar's spaces, their components and their epics, as far as each space has been read. */
export function placesOf(spaces: readonly { key: string; name: string }[], reads: Record<string, { tree?: JiraSpaceTree } | undefined>): Place[] {
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const sp of spaces) {
    out.push({ id: "s:" + sp.key, kind: "space", name: sp.name, key: sp.key, space: sp.key });
    const comps = reads[sp.key]?.tree?.components ?? [];
    for (const c of comps) if (c.id !== undefined) out.push({ id: "c:" + sp.key + "/" + c.name, kind: "component", name: c.name, key: sp.key, space: sp.key, component: c.name });
    for (const c of comps) for (const e of c.epics) if (!seen.has(e.key)) { seen.add(e.key); out.push({ id: "e:" + e.key, kind: "epic", name: e.summary, key: e.key, space: sp.key }); }
  }
  return out;
}
export const rankPlaces = (places: readonly Place[], text: string): Place[] =>
  bestFirst(places, text, (p) => (p.kind === "component" ? p.name : p.name + " " + p.key)).slice(0, PLACES_CAP);

/**
 * The epics the palette can offer: the board's own list, plus any epic the cards themselves show (an epic-type card, or the
 * epic a card sits under). A board context with no epic list (kanban) or one that left an epic out still finds it by name.
 */
export function epicsOf(epics: readonly JiraBoardEpic[], cards: readonly ProviderTask[]): JiraBoardEpic[] {
  const out = new Map<string, JiraBoardEpic>();
  for (const e of epics) out.set(e.key.toUpperCase(), e);
  const add = (key: string, name: string) => { if (key && !out.has(key.toUpperCase())) out.set(key.toUpperCase(), { key, name }); };
  for (const t of cards) {
    if ((t.issueType ?? "").toLowerCase() === "epic") add(keyOf(t), t.title);
    if ((t.parent?.type ?? "").toLowerCase() === "epic") add(t.parent!.key, t.parent!.title);
  }
  return [...out.values()];
}

/** Does a typed key name one of the board's own epics? Matched case-insensitively. */
export function isEpicKey(epics: readonly JiraBoardEpic[], key: string): boolean {
  return epics.some((e) => e.key.toUpperCase() === key.toUpperCase());
}

export interface JumpRows {
  saved: SavedQuery[];
  recent: string[];
  epics: JiraBoardEpic[];
  cards: ProviderTask[];
}

/** The sections for what is typed. SAVED is fuzzy-ranked and capped; the others filter by substring in their own order. */
export function jumpRows(o: { text: string; queries: readonly SavedQuery[]; recent: readonly string[]; epics: readonly JiraBoardEpic[]; cards: readonly ProviderTask[] }): JumpRows {
  const q = o.text.trim().replace(/^q:\s*/i, "");
  const epics = epicsOf(o.epics, o.cards);
  return {
    saved: rankQueries(o.queries, q).slice(0, SAVED_CAP),
    recent: o.recent.filter((r) => !q || has(r, q)).slice(0, RECENT_KEEP),
    epics: epics.filter((e) => !q || has(e.name, q) || has(e.key, q)),
    cards: (q ? bestFirst(o.cards, q, (t) => keyOf(t) + " " + t.title) : [...o.cards]).slice(0, CARDS_CAP),
  };
}

/** A search run goes to the front of RECENT; the same search is not kept twice. */
export function pushRecent(list: readonly string[], jql: string): string[] {
  const j = jql.trim().replace(/\s+/g, " ");
  return j ? [j, ...list.filter((x) => x !== j)].slice(0, RECENT_KEEP) : [...list];
}

const recentKey = (project: string) => "agentglass.jira.recent." + (project || "-");
export function loadRecent(project: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(recentKey(project)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_KEEP) : [];
  } catch { return []; }
}
export function saveRecent(project: string, list: readonly string[]): void {
  try { localStorage.setItem(recentKey(project), JSON.stringify(list)); } catch { /* private mode */ }
}

/** Tab: the first row of the next section (Shift+Tab: the previous one), wrapping round. */
export function sectionStep(secs: readonly string[], at: number, dir: 1 | -1): number {
  if (!secs.length) return 0;
  const starts = secs.flatMap((s, i) => (i === 0 || secs[i - 1] !== s ? [i] : []));
  const cur = starts.filter((i) => i <= at).length - 1;
  return starts[(cur + dir + starts.length) % starts.length]!;
}
