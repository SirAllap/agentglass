/*
 * The saved-view tabs, the saved queries and the dock width, as plain functions so a test can ask them without a screen.
 * Nothing here reads the site: `useJiraSavedViews` loads the views, `useJiraViewCounts` the counts.
 */
import type { JiraBoardSprint, SavedView } from "../../../../../shared/providers.ts";
import { BOARD_PAD, trackWidth, type BoardDensity } from "./boardModel.ts";
import { sprintLine } from "../../../lib/jiraBoardContext.ts";

/** Tabs drawn before the rest fold into More. */
export const MAX_TABS = 5;
/** The container widths where the bar folds (design-system.md, "The Jira board's folding"). */
export const FOLD = { labels: 820, tabs: 800, lanes: 1160, row: 900, stack: 560 } as const;
/** The card dock never gets narrower than this; the sidebar rail folds before the dock does. */
export const DOCK_MIN = 380;
export const DOCK_MAX = 540;

/** The dock's width for a row `rowW` wide: what is left after three columns, kept between the min and the max. */
export function dockWidth(rowW: number, density: BoardDensity): number {
  if (rowW <= 0) return DOCK_MAX;
  const left = rowW - trackWidth(3, density) - BOARD_PAD;
  return Math.max(DOCK_MIN, Math.min(DOCK_MAX, left));
}

/** Arrow-key step on the dock's resize grip, and the Shift step (the mockup's 10 / 40). */
export const DOCK_RESIZE_STEP = 10;
export const DOCK_RESIZE_BIG_STEP = 40;

/**
 * The widest a hand-dragged dock may be for a row this wide: the mockup's 70% of the window, read here off the row
 * (the board's own container, not the whole screen, since a sidebar already took its share). Never under the floor.
 */
export function dockResizeMax(rowW: number): number {
  return Math.max(DOCK_MIN, Math.round(rowW * 0.7));
}

/** Any width pulled into the dock's hand-dragged range for a row this wide. Not a number: the floor. */
export function clampDockResize(px: number, rowW: number): number {
  if (!Number.isFinite(px)) px = DOCK_MIN;
  return Math.min(dockResizeMax(rowW), Math.max(DOCK_MIN, Math.round(px)));
}

/**
 * Where a key on the focused grip takes the width, or null for a key that is not the grip's. The grip is on the
 * dock's LEFT edge, so ArrowLeft moves the edge left and the dock grows.
 */
export function dockResizeKey(key: string, shift: boolean, cur: number, rowW: number): number | null {
  const step = shift ? DOCK_RESIZE_BIG_STEP : DOCK_RESIZE_STEP;
  if (key === "ArrowLeft") return clampDockResize(cur + step, rowW);
  if (key === "ArrowRight") return clampDockResize(cur - step, rowW);
  if (key === "Home") return DOCK_MIN;
  if (key === "End") return dockResizeMax(rowW);
  return null;
}

/** The tabs and the overflow. The view on screen always has a tab: when it would fold, it takes the last slot. */
export function splitTabs(views: readonly SavedView[], current: string | null, max = MAX_TABS): { tabs: SavedView[]; more: SavedView[] } {
  const tabs = views.slice(0, max);
  const more = views.slice(max);
  const at = current ? more.findIndex((v) => v.id === current) : -1;
  if (at >= 0 && tabs.length) {
    const swap = tabs[tabs.length - 1]!;
    tabs[tabs.length - 1] = more[at]!;
    more[at] = swap;
  }
  return { tabs, more };
}

/** "Sprint 14" is "S14"; a name with no number stays as it is. */
export function sprintShort(name: string): string {
  const n = /(\d+)\s*$/.exec(name.trim());
  return n ? `S${n[1]}` : name.trim();
}

/** The chip over the board: "S14 · 6 days left". Null where the board has no active sprint. */
export function sprintTab(s: JiraBoardSprint | undefined, now: number): { label: string; short: string; left: string; late: boolean } | null {
  if (!s) return null;
  const line = sprintLine(s, now);
  const short = sprintShort(s.name);
  return { label: line.left ? `${short} · ${line.left}` : short, short, left: line.left, late: line.late };
}

export interface SavedQuery { id: string; name: string; jql: string; team: boolean; /** Drawn as a tab above the list. */ tab?: boolean }

/** The search kept in a saved search's address. */
export function jqlOf(v: Pick<SavedView, "url">): string | null {
  try { return new URL(v.url).searchParams.get("jql")?.trim() || null; } catch { return null; }
}

/** The saved views that are searches (`jql:` ids), with the search they keep. `team` is read when the server marks it. */
export function savedQueries(views: readonly SavedView[]): SavedQuery[] {
  const out: SavedQuery[] = [];
  for (const v of views) {
    if (!v.id.startsWith("jql:")) continue;
    const jql = jqlOf(v);
    if (jql) out.push({ id: v.id, name: v.name, jql, team: (v as SavedView & { team?: boolean }).team === true, ...(v.tab ? { tab: true } : null) });
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The saved search the box holds right now, if any. */
export const queryFor = (queries: readonly SavedQuery[], typed: string): SavedQuery | null => {
  const q = norm(typed);
  return q ? queries.find((s) => norm(s.jql) === q) ?? null : null;
};

/** In-order letter match: the score is lower the tighter the match; null when a letter is missing. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = norm(query);
  if (!q) return 0;
  const t = text.toLowerCase();
  let at = -1;
  let first = -1;
  let gaps = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const next = t.indexOf(ch, at + 1);
    if (next < 0) return null;
    if (first < 0) first = next;
    else gaps += next - at - 1;
    at = next;
  }
  return first + gaps;
}

/** Saved searches that match, best first; with nothing typed, all of them in their own order. */
export function rankQueries<T extends { name: string; jql: string }>(list: readonly T[], typed: string): T[] {
  const scored = list.flatMap((s, i) => {
    const sc = [fuzzyScore(typed, s.name), fuzzyScore(typed, s.jql)].filter((x): x is number => x !== null);
    return sc.length ? [{ s, i, sc: Math.min(...sc) }] : [];
  });
  return scored.sort((a, b) => a.sc - b.sc || a.i - b.i).map((x) => x.s);
}

/** "12 cards · 84 ms" under the search. */
export function queryTiming(n: number, ms: number, cap?: { capped?: boolean; total?: number }): string {
  const t = `${Math.max(1, Math.round(ms))} ms`;
  if (cap?.capped) return `showing ${n} of ${cap.total !== undefined && cap.total > n ? cap.total : `${n}+`} cards · ${t}`;
  return `${n}${n === 1 ? " card" : " cards"} · ${t}`;
}

/** A name for a search saved in one click: the JQL, cut where it is still readable. */
export function nameForQuery(jql: string): string {
  const one = jql.replace(/\s+order\s+by\s+.*$/i, "").replace(/\s+/g, " ").trim();
  return one.length > 40 ? `${one.slice(0, 39)}…` : one;
}

/* ---------- the named view tabs (mockup `VIEWS`, index.html:216) ---------- */

/** Tabs at most: the default views plus the saved searches whose "Show as tab" box is checked. */
export const MAX_VIEW_TABS = 8;
export const TAB_PREFIX = "tab:";
export interface NamedTab { id: string; name: string; /** The search the app owns for it; null is the board's own, all of it. */ jql: string | null }

/* How many named tabs the board on screen draws (4 when it has no Review stage), so the save dialog can tell when the strip is full. */
let namedCount = 5;
export const setNamedTabCount = (n: number): void => { namedCount = n; };
export const namedTabCount = (): number => namedCount;

/** Whether another saved search can be a tab: the named ones and the checked searches stay within the cap. */
export const tabRoom = (named: number, checked: number): boolean => named + checked < MAX_VIEW_TABS;

/**
 * The strip's order: the named tabs, then the saved searches checked as tabs, then every other saved search or starred
 * filter while there is room (up to the cap); only what does not fit folds into More. A board is never a tab: it is a
 * different board, not a view of this one. `shown` is how many of the list are tabs.
 *
 * Measured: with "only a checked search is a tab", a person with one default view left and one starred filter had a
 * strip of one tab and the filter behind More, beside a row of empty space.
 */
export function orderTabs(named: readonly NamedTab[], views: readonly SavedView[]): { list: SavedView[]; shown: number } {
  const head = named.map((t): SavedView => ({ id: t.id, name: t.name, url: "", addedAt: 0 }));
  const room = Math.max(0, MAX_VIEW_TABS - head.length);
  const tabbable = (v: SavedView) => !v.id.startsWith("board:");
  const checked = views.filter((v) => tabbable(v) && v.tab);
  const others = views.filter((v) => tabbable(v) && !v.tab);
  const tabs = [...checked, ...others].slice(0, room);
  const rest = views.filter((v) => !tabs.includes(v));
  return { list: [...head, ...tabs, ...rest], shown: head.length + tabs.length };
}
