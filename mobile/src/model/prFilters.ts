/*
 * The filter sheet's decisions, apart from the sheet.
 *
 * Every facet here is answered from the rows already loaded: the row carries
 * its review verdict, its check counts, its draft flag, its author and (when
 * the boards hold it) its tracker card, so narrowing costs no request. The
 * ceiling is the same one the page size sets: a filter narrows what has been
 * loaded, and "Load more" widens it. The sheet says so rather than implying it
 * searched the repository.
 *
 * Semantics follow the desktop's (web/src/lib/prFilter.ts): values inside one
 * facet are OR-ed, facets are AND-ed, and a check the second pass has not
 * landed yet fails OPEN, because hiding a row for a fact nobody knows yet
 * would make the list flicker as the rollup arrives. The card is the opposite,
 * as on the desk: a row with no card is not "In Review", so a card filter
 * leaves it out unless "No card" was ticked.
 */
import type { PrSummary } from "../../../shared/types.ts";
import type { StateView } from "./prState.ts";
import { byState, stateQuery } from "./prState.ts";

export type ReviewSel = "any" | "needs-me" | "approved" | "changes";
export type ChecksSel = "any" | "passing" | "failing" | "running";
export type DraftSel = "any" | "ready" | "draft";

export const REVIEW_SELS: { id: ReviewSel; label: string }[] = [
  { id: "any", label: "Any" }, { id: "needs-me", label: "Needs me" },
  { id: "approved", label: "Approved" }, { id: "changes", label: "Changes" },
];
export const CHECKS_SELS: { id: ChecksSel; label: string }[] = [
  { id: "any", label: "Any" }, { id: "passing", label: "Passing" },
  { id: "failing", label: "Failing" }, { id: "running", label: "Running" },
];
export const DRAFT_SELS: { id: DraftSel; label: string }[] = [
  { id: "any", label: "Any" }, { id: "ready", label: "Ready" }, { id: "draft", label: "Draft" },
];

export interface PrFilters {
  /** Null = not chosen: Open while browsing, Any while searching. See effectiveState. */
  state: StateView | null;
  review: ReviewSel;
  checks: ChecksSel;
  draft: DraftSel;
  /** Tracker card statuses, by name, OR-ed. */
  cardStatus: string[];
  /** Also let the rows with no linked card through the card filter. */
  noCard: boolean;
  authors: string[];
}

export const NO_FILTERS: PrFilters = {
  state: null, review: "any", checks: "any", draft: "any", cardStatus: [], noCard: false, authors: [],
};

/** The pieces of a row that filtering reads — what a fixture has to supply. */
export type FilterRow = Pick<PrSummary, "author" | "state" | "isDraft" | "checks" | "checksLoaded" | "humanReview" | "card">;

/** What the list asks the server for: a search looks through everything unless
 *  the person picked a state on purpose. */
export function effectiveState(f: Pick<PrFilters, "state">, searching: boolean): StateView {
  return f.state ?? (searching ? "all" : "open");
}

const hasCard = (f: PrFilters): boolean => f.cardStatus.length > 0 || f.noCard;

function reviewOk(p: FilterRow, sel: ReviewSel): boolean {
  if (sel === "any") return true;
  // The HUMANS' verdict, as on the card's banner: a bot's approval is not
  // "Approved" here either.
  const h = p.humanReview && typeof p.humanReview === "object" ? p.humanReview : null;
  if (sel === "approved") return h?.kind === "approved";
  if (sel === "changes") return h?.kind === "changes";
  // Needs me: waiting on the reader, or the reader's own "changes" since
  // re-asked — the two places the banner says "Waiting on you" / "Asked again".
  return !!h?.mine && (h.kind === "awaiting" || !!h.askedAgain);
}

function checksOk(p: FilterRow, sel: ChecksSel): boolean {
  if (sel === "any") return true;
  if (p.checksLoaded === false) return true; // not read yet: fail open
  const c = p.checks;
  if (!c || !c.total) return false; // known: no checks at all
  // Failing outranks running, as it does on the banner: a red row with one
  // job still going is a red row.
  if (sel === "failing") return c.failure > 0;
  if (sel === "running") return c.failure === 0 && c.pending > 0;
  return c.failure === 0 && c.pending === 0;
}

export function matchesFilters(p: FilterRow, f: PrFilters): boolean {
  if (f.draft !== "any" && p.isDraft !== (f.draft === "draft")) return false;
  if (f.authors.length && !f.authors.includes(p.author)) return false;
  if (!reviewOk(p, f.review) || !checksOk(p, f.checks)) return false;
  if (hasCard(f) && !(p.card ? f.cardStatus.includes(p.card.status) : f.noCard)) return false;
  return true;
}

/** The facets' own words, for a chip and for the badge. One chip per facet. */
export interface ActiveChip { id: "state" | "review" | "checks" | "draft" | "card" | "author"; label: string }

const SEL_WORD: Record<string, string> = {
  "needs-me": "needs me", approved: "approved", changes: "changes requested",
  passing: "passing", failing: "failing", running: "running", ready: "ready", draft: "draft",
};

export function activeChips(f: PrFilters, stateLabel: (s: StateView) => string): ActiveChip[] {
  const out: ActiveChip[] = [];
  if (f.state) out.push({ id: "state", label: `State: ${stateLabel(f.state)}` });
  if (f.review !== "any") out.push({ id: "review", label: `Review: ${SEL_WORD[f.review]}` });
  if (f.checks !== "any") out.push({ id: "checks", label: `Checks: ${SEL_WORD[f.checks]}` });
  if (f.draft !== "any") out.push({ id: "draft", label: `Draft: ${SEL_WORD[f.draft]}` });
  if (hasCard(f)) out.push({ id: "card", label: `Card: ${[...f.cardStatus, ...(f.noCard ? ["no card"] : [])].join(", ")}` });
  if (f.authors.length) out.push({ id: "author", label: `Author: ${f.authors.join(", ")}` });
  return out;
}

export function removeChip(f: PrFilters, id: ActiveChip["id"]): PrFilters {
  switch (id) {
    case "state": return { ...f, state: null };
    case "review": return { ...f, review: "any" };
    case "checks": return { ...f, checks: "any" };
    case "draft": return { ...f, draft: "any" };
    case "card": return { ...f, cardStatus: [], noCard: false };
    case "author": return { ...f, authors: [] };
  }
}

/** Tap an item: on if off, off if on. */
export function toggled<T>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export interface CardStatusOption { status: string; count: number }

/**
 * The checklist's rows: each distinct status a loaded row's card carries, with
 * how many rows have it. Workflow order (open, then the ones in flight, then
 * done) by the tracker's own kind, because alphabetical put "Blocked" above
 * "To Do"; the name breaks ties so the list does not shuffle between reads.
 * `none` is the rows without a card at all.
 */
export function cardStatusOptions(rows: readonly Pick<PrSummary, "card">[]): { statuses: CardStatusOption[]; none: number } {
  const seen = new Map<string, { kind: string; count: number }>();
  let none = 0;
  for (const r of rows) {
    if (!r.card) { none++; continue; }
    const at = seen.get(r.card.status) ?? { kind: r.card.statusKind ?? "other", count: 0 };
    at.count++;
    seen.set(r.card.status, at);
  }
  const rank = (k: string): number => (k === "open" ? 0 : k === "done" ? 2 : 1);
  const statuses = [...seen.entries()]
    .sort((a, b) => rank(a[1].kind) - rank(b[1].kind) || a[0].localeCompare(b[0]))
    .map(([status, v]) => ({ status, count: v.count }));
  return { statuses, none };
}

/** The people list: authors of the loaded rows, most pull requests first. */
export function authorOptions(rows: readonly Pick<PrSummary, "author">[], extra: readonly string[] = []): { login: string; count: number }[] {
  const n = new Map<string, number>();
  for (const r of rows) if (r.author) n.set(r.author, (n.get(r.author) ?? 0) + 1);
  for (const x of extra) if (x && !n.has(x)) n.set(x, 0);
  return [...n.entries()].map(([login, count]) => ({ login, count }))
    .sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
}

/**
 * How many of the rows the filters keep, or null when that is not known: a
 * state the loaded rows were not asked for (Open loaded, Merged picked) has to
 * be read before it can be counted, and a number made from the wrong rows is
 * worse than "Show pull requests".
 */
export function shownCount(
  rows: readonly FilterRow[], f: PrFilters, loaded: StateView, searching: boolean,
): number | null {
  const want = effectiveState(f, searching);
  if (stateQuery(want) !== stateQuery(loaded)) return null;
  return byState([...rows], want).filter((p) => matchesFilters(p, f)).length;
}

/** Rows a card filter cannot match, for the line under the chips. */
export function withoutCard(rows: readonly Pick<PrSummary, "card">[]): number {
  return rows.reduce((n, r) => n + (r.card ? 0 : 1), 0);
}
