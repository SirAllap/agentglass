/*
 * Past sessions: a list you can page through and search, not the eight that
 * happened to fit.
 *
 * The old sheet drew `past.slice(0, 8)` and said how many it had left — a
 * sentence about a list you could not reach. A checkout that has run an agent
 * for a year has a hundred of these, and "which one was I on" is a question
 * about the end of a conversation: the row that matters is often older than
 * eight, and the one you are looking for is one you half remember the words of.
 *
 * So: groups (open now, today, this week, earlier), a page of eight that grows,
 * and a search that reads titles, last lines and ids. The chips are what the
 * search is scoped to — the same read, narrowed, never a second request.
 *
 * Pure, because all four of those are decisions and none of them needs a
 * renderer. `mobile/test/past-sessions.test.ts` holds them as data.
 */
import { oneLine } from "../../../shared/notifyPayload.ts";
import type { AgentSessionRow } from "../../../shared/types.ts";
import { since } from "../lib/dates.ts";

/** The page the sheet opens on. Eight is what a 75 % sheet holds above the
 *  fold on a 360 dp screen with the search field and the chips drawn. */
export const PAGE = 8;

/** The chip is a set, not a filter on one field: "this checkout" and "last 7
 *  days" answer different questions, and both are read from the same rows. */
export type PastChip = "checkout" | "all" | "week";

export const CHIPS: readonly { id: PastChip; label: string }[] = [
  { id: "checkout", label: "This checkout" },
  { id: "all", label: "All checkouts" },
  { id: "week", label: "Last 7 days" },
];

const DAY = 24 * 60 * 60_000;

/** Under this directory, or in it. Worktrees of one repository are siblings,
 *  so a prefix test is exactly "this checkout and not its siblings". */
const under = (cwd: string, root: string): boolean =>
  !!root && (cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`));

/**
 * Every word has to be somewhere in the row.
 *
 * "Every", not "any": two words from the title and the last line together are
 * how somebody remembers a session, and requiring both is what makes a search
 * usable with three words in it. Case and the id are included because a session
 * is sometimes referred to by the id nobody can read.
 */
export function matches(row: AgentSessionRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${row.title} ${row.opening} ${row.last} ${row.id}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function inChip(row: AgentSessionRow, chip: PastChip, root: string, now = Date.now()): boolean {
  if (chip === "checkout") return under(row.cwd, root);
  if (chip === "week") return row.at >= now - 7 * DAY;
  return true;
}

/** The rows the sheet draws, newest first: the chip's set, then the words. */
export function filterSessions(
  rows: readonly AgentSessionRow[],
  o: { chip: PastChip; query?: string; root: string; now?: number },
): AgentSessionRow[] {
  const now = o.now ?? Date.now();
  return rows
    .filter((r) => inChip(r, o.chip, o.root, now) && matches(r, o.query ?? ""))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

export type PastGroupId = "open" | "today" | "week" | "older";

export const GROUPS: readonly { id: PastGroupId; label: string }[] = [
  { id: "open", label: "Open now" },
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "older", label: "Earlier" },
];

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Where a session belongs. A running one is not filed by its age: "open now"
 *  is the row you go back to rather than resume, and it is the one you came for. */
export function groupOf(row: AgentSessionRow, now = Date.now()): PastGroupId {
  if (row.openIn) return "open";
  const midnight = startOfDay(now);
  if (row.at >= midnight) return "today";
  if (row.at >= midnight - 6 * DAY) return "week";
  return "older";
}

/** The page, in groups, keeping the order the rows came in. A group with no
 *  rows is not drawn — the label would be a heading over nothing. */
export function groupsOf(
  rows: readonly AgentSessionRow[], now = Date.now(),
): { id: PastGroupId; label: string; rows: AgentSessionRow[] }[] {
  return GROUPS
    .map((g) => ({ ...g, rows: rows.filter((r) => groupOf(r, now) === g.id) }))
    .filter((g) => g.rows.length > 0);
}

export interface Page {
  /** What to draw, in order. */
  rows: AgentSessionRow[];
  /** How many are past the page, for "Show older sessions · 12". */
  more: number;
  total: number;
}

/** The first `shown` of the list, and how much is left. `shown` grows by PAGE
 *  each press, so a second press is never a re-read of the computer. */
export function page(rows: readonly AgentSessionRow[], shown = PAGE): Page {
  const n = Math.max(0, Math.floor(shown));
  return { rows: rows.slice(0, n), more: Math.max(0, rows.length - n), total: rows.length };
}

/** The line under a session's title. A running one says where, because that is
 *  what the tap does (it goes there rather than resuming); a finished one says
 *  the last thing said and how long ago. */
export function sessionLine(row: AgentSessionRow, now = Date.now()): string {
  if (row.openIn) return `open now in ${row.openIn.windowName}`;
  const said = oneLine(row.last || row.opening || "", 60);
  return [said, since(row.at, now)].filter(Boolean).join(" · ");
}

/** What the sheet says under the list once nothing is hidden. */
export function countLine(p: Page): string {
  if (p.total === 0) return "No session in this scope.";
  if (p.more > 0) return `${p.rows.length} of ${p.total} shown`;
  return p.total === 1 ? "One session" : `${p.total} sessions`;
}
