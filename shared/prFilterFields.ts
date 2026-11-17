// One pull request's values for one filter field, read the same way everywhere.
//
// Shared because the desk's pills and rule engine and the phone's saved views
// ask the same question; a field read twice is how one view keeps different
// rows on two screens. Keys are the ones the query string and a LaneFilter rule
// already use (`author`, `checks`, `cardstatus`, `text`, `updated`…).
//
// A reader answers `string[]` for a field this build knows, and `null` only for
// one it has never heard of. `readPrFieldAt` folds that null into `[]` for
// callers that just count; the evaluator keeps it, so a saved view naming a
// field a newer version wrote narrows nothing instead of emptying the board.
import type { PrSummary } from "./types.ts";
import { botReviewTokens, humanReviewerTokens, humanReviewTokens } from "./reviewStates.ts";

export function reviewTokenOf(d: PrSummary["reviewDecision"]): string {
  return d === "APPROVED" ? "approved"
    : d === "CHANGES_REQUESTED" ? "changes-requested"
    : d === "REVIEW_REQUIRED" ? "required"
    : "none";
}

/** `null` while the second pass has not landed: the rule cannot say "no match". */
export function checksTokenOf(p: PrSummary): string[] | null {
  if (p.checksLoaded === false) return null;
  const r = p.checks;
  if (!r || r.total === 0) return []; // known: no checks. Matches no checks-token.
  if (r.verdict === "green") return ["green"];
  if (r.verdict === "red") return ["red"];
  return ["pending"]; // has checks, not yet a verdict
}

/** A card status as every surface compares and counts it: trimmed, UPPER CASE
 *  (the old tracker writes "ready for qa", Jira "Ready for QA"). */
export const statusKey = (v: string): string => v.trim().toUpperCase();

/** The one fold for a field's values: statuses by `statusKey`, card ids by
 *  case, everything else as given. The rule engine, the editor's counts and
 *  its options all go through this. */
export const foldFieldValue = (field: string, v: string): string =>
  field === "cardstatus" ? statusKey(v) : field === "card" ? v.toLowerCase() : v;

/** The facet readers, by query key. */
export const FACET_FIELDS = {
  author: (p: PrSummary) => (p.author ? [p.author] : []),
  label: (p: PrSummary) => p.labels.map((l) => l.name),
  review: (p: PrSummary) => [reviewTokenOf(p.reviewDecision)],
  /* The three below split people from bots; `review` above is GitHub's word,
     which counts a bot. `null` until the second pass has said. */
  humanreviewer: (p: PrSummary) => humanReviewerTokens(p.reviewStates),
  humanreview: (p: PrSummary) => humanReviewTokens(p.reviewStates),
  botreview: (p: PrSummary) => botReviewTokens(p.reviewStates),
  checks: checksTokenOf,
  is: (p: PrSummary) => [p.isDraft ? "draft" : "ready"],
  base: (p: PrSummary) => (p.baseRefName ? [p.baseRefName] : []),
  assignee: (p: PrSummary) => p.assignees,
  milestone: (p: PrSummary) => (p.milestone ? [p.milestone] : []),
  /* `[]`, not `null`, for a row with no card: "the ones in Ready for QA" does
     not include a pull request with no card. The opposite of the checks
     fail-open above, and deliberate. */
  cardstatus: (p: PrSummary) => (p.card ? [p.card.status] : []),
  cardassignee: (p: PrSummary) => (p.card?.people ?? []).map((x) => x.name).filter(Boolean),
} satisfies Record<string, (p: PrSummary) => string[] | null>;

/*
 * The fields no pill draws, so they stay out of the facet table. `updated` is
 * the age in whole days, which is why the clock is an argument: a test pins it.
 */
const DAY_MS = 86_400_000;
const EXTRA_FIELDS: Record<string, (p: PrSummary, now: number) => string[]> = {
  text: (p) => [p.title, p.headRefName].filter(Boolean),
  number: (p) => [String(p.number)],
  card: (p) => (p.card ? [p.card.customId ?? p.card.id] : []),
  /* Empty rather than "no" for a clean row, so `is not` and `unset` both read
     it the way the sentence does. */
  conflict: (p) => (p.mergeable === "CONFLICTING" ? ["yes"] : []),
  updated: (p, now) => {
    const t = Date.parse(p.updatedAt);
    return Number.isNaN(t) ? [] : [String(Math.max(0, Math.floor((now - t) / DAY_MS)))];
  },
};
export const EXTRA_FIELD_KEYS = Object.keys(EXTRA_FIELDS);

/** `null` for a field this build has never heard of; `[]` for a known field
 *  with nothing on this row. The evaluator tells the two apart.
 *  `Object.hasOwn`, not a truthy lookup: `constructor`, `toString` and
 *  `__proto__` are inherited from Object.prototype and are not fields. */
export function readPrFieldOrNull(p: PrSummary, key: string, now: number): string[] | null {
  if (Object.hasOwn(EXTRA_FIELDS, key)) return EXTRA_FIELDS[key]!(p, now);
  if (Object.hasOwn(FACET_FIELDS, key)) return (FACET_FIELDS as Record<string, (p: PrSummary) => string[] | null>)[key]!(p);
  return null;
}

export function readPrFieldAt(p: PrSummary, key: string, now: number): string[] {
  return readPrFieldOrNull(p, key, now) ?? [];
}

/** The rule engine's reader, with the clock read per row. */
export function readPrField(p: PrSummary, key: string): string[] {
  return readPrFieldAt(p, key, Date.now());
}

/** The reader both boards hand their saved-view evaluator. It keeps `null`
 *  (inert: the rule cannot judge the row) for a field this build does not know
 *  and for a second pass that has not landed; that is the one null policy, so
 *  a view written by a newer build keeps every pull request on both screens,
 *  and a freshly opened board does not hide rows the desk keeps. */
export function viewFieldReader(p: PrSummary, key: string, now: number = Date.now()): string[] | null {
  return readPrFieldOrNull(p, key, now);
}
