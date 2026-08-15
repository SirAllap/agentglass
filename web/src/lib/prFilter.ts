// The PR list's filter model (#pulldash-style facets).
//
// One rule holds the whole thing together: the query STRING is the single
// source of truth. `FilterState` is a pure `parseQuery(query)` derivation, never
// stored; the facet dropdowns are editors of the string (toggle -> parse ->
// mutate -> serialize -> setQuery). Two independent states that must "never
// disagree" is the bug this design refuses to have — there is only one state,
// so the bar and the menus cannot drift.
//
// Grammar: `key:value` tokens plus bare free-text words, space separated, keys
// case-insensitive, double-quotes for values with spaces (`label:"needs work"`).
// parseQuery is TOTAL: unknown keys, partial tokens, and unclosed quotes all
// degrade gracefully (to free text or to no-constraint), never throw, never
// silently empty the list.
//
// Semantics: OR within a facet, AND across facets. Two authors selected shows
// PRs by either; adding a label then intersects. This is a deliberate
// divergence from github.com's raw search (where repeated `label:` is AND) —
// a multi-select checkbox facet has to be OR, or ticking a second box can only
// ever shrink the result to zero, which reads as broken.
import type { PrSummary } from "../../../shared/types.ts";

export type ReviewTok = "approved" | "changes-requested" | "required" | "none";
export type ChecksTok = "green" | "red" | "pending";
export type IsTok = "draft" | "ready";
export type SortTok = "recently-updated" | "newest" | "oldest" | "most-changed" | "title" | "checks";

export const REVIEW_TOKS: ReviewTok[] = ["approved", "changes-requested", "required", "none"];
export const CHECKS_TOKS: ChecksTok[] = ["green", "red", "pending"];
export const IS_TOKS: IsTok[] = ["draft", "ready"];
export const SORT_TOKS: SortTok[] = ["recently-updated", "newest", "oldest", "most-changed", "title", "checks"];
export const DEFAULT_SORT: SortTok = "recently-updated";

export const SORT_OPTIONS: { value: SortTok; label: string }[] = [
  { value: "recently-updated", label: "Recently updated" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "most-changed", label: "Most changed" },
  { value: "title", label: "Title" },
  { value: "checks", label: "Checks status" },
];

export interface FilterState {
  authors: string[];
  assignees: string[];
  labels: string[];
  milestones: string[];
  reviews: ReviewTok[];
  checks: ChecksTok[];
  is: IsTok[];
  base: string[];
  text: string; // free words, matched as today: number / title / author substring
  sort: SortTok;
}

// The array-valued facets, in display order. `queryKey` is the token key in the
// string; `field` reads the token(s) a PR matches for this facet — returning
// `null` means "unknown, fail open" (only checks, and only before its second
// fetch pass has landed). `label` names the facet in the UI.
type ArrayKey = "authors" | "assignees" | "labels" | "milestones" | "reviews" | "checks" | "is" | "base";

export interface FacetDef {
  key: ArrayKey;
  queryKey: string;
  label: string;
  /** Fixed option set (enum facets); free-form facets derive options from the rows. */
  fixed?: string[];
  field: (p: PrSummary) => string[] | null;
}

export function reviewTokenOf(d: PrSummary["reviewDecision"]): ReviewTok {
  return d === "APPROVED" ? "approved"
    : d === "CHANGES_REQUESTED" ? "changes-requested"
    : d === "REVIEW_REQUIRED" ? "required"
    : "none";
}

function checksTokenOf(p: PrSummary): string[] | null {
  if (p.checksLoaded === false) return null; // second pass not in yet — fail open
  const r = p.checks;
  if (!r || r.total === 0) return []; // known: no checks. Matches no checks-token.
  if (r.verdict === "green") return ["green"];
  if (r.verdict === "red") return ["red"];
  return ["pending"]; // has checks, not yet a verdict
}

export const FACETS: FacetDef[] = [
  { key: "authors", queryKey: "author", label: "Author", field: (p) => (p.author ? [p.author] : []) },
  { key: "labels", queryKey: "label", label: "Label", field: (p) => p.labels.map((l) => l.name) },
  { key: "reviews", queryKey: "review", label: "Reviews", fixed: REVIEW_TOKS, field: (p) => [reviewTokenOf(p.reviewDecision)] },
  { key: "checks", queryKey: "checks", label: "Checks", fixed: CHECKS_TOKS, field: checksTokenOf },
  { key: "is", queryKey: "is", label: "Draft", fixed: IS_TOKS, field: (p) => [p.isDraft ? "draft" : "ready"] },
  { key: "base", queryKey: "base", label: "Base", field: (p) => (p.baseRefName ? [p.baseRefName] : []) },
  { key: "assignees", queryKey: "assignee", label: "Assignee", field: (p) => p.assignees },
  { key: "milestones", queryKey: "milestone", label: "Milestone", field: (p) => (p.milestone ? [p.milestone] : []) },
];

const FACET_BY_QKEY = new Map(FACETS.map((f) => [f.queryKey, f]));
const KNOWN_KEYS = new Set([...FACET_BY_QKEY.keys(), "sort"]);

function empty(): FilterState {
  return { authors: [], assignees: [], labels: [], milestones: [], reviews: [], checks: [], is: [], base: [], text: "", sort: DEFAULT_SORT };
}

// Split into tokens, keeping `key:"a b"` whole (a space inside quotes is not a
// separator) and letting an unclosed quote run to the end of the input.
function splitTokens(input: string): string[] {
  const toks: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i])) i++;
    if (i >= n) break;
    let tok = "";
    let inQuote = false;
    while (i < n && (inQuote || !/\s/.test(input[i]))) {
      const c = input[i];
      if (c === '"') inQuote = !inQuote;
      tok += c;
      i++;
    }
    toks.push(tok);
  }
  return toks;
}

function stripQuotes(v: string): string {
  if (v.startsWith('"')) return v.slice(1, v.endsWith('"') && v.length > 1 ? -1 : undefined);
  return v;
}

function pushUnique<T>(arr: T[], v: T): void {
  if (!arr.includes(v)) arr.push(v);
}

export function parseQuery(input: string): FilterState {
  const s = empty();
  const free: string[] = [];
  for (const tok of splitTokens(input || "")) {
    const ci = tok.indexOf(":");
    const key = ci > 0 ? tok.slice(0, ci).toLowerCase() : "";
    if (ci > 0 && KNOWN_KEYS.has(key)) {
      const value = stripQuotes(tok.slice(ci + 1)).trim();
      if (!value) continue; // partial token while typing — no constraint yet
      if (key === "sort") {
        if ((SORT_TOKS as string[]).includes(value)) s.sort = value as SortTok;
        continue;
      }
      const facet = FACET_BY_QKEY.get(key)!;
      // Enum facets validate their value; an out-of-range value is ignored
      // rather than pushed to free text (where it would substring-match nothing
      // and empty the list).
      if (facet.fixed && !facet.fixed.includes(value.toLowerCase())) continue;
      pushUnique(s[facet.key] as string[], facet.fixed ? value.toLowerCase() : value);
    } else {
      free.push(tok);
    }
  }
  s.text = free.join(" ");
  return s;
}

function quote(v: string): string {
  return /[\s:"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v;
}

// Canonical form: facets in FACETS order, each value deduped and quoted as
// needed, then free text, then a non-default sort last. parseQuery(serialize(s))
// round-trips to the normalized s.
export function serializeQuery(s: FilterState): string {
  const parts: string[] = [];
  for (const f of FACETS) {
    for (const v of s[f.key] as string[]) parts.push(`${f.queryKey}:${quote(v)}`);
  }
  const text = s.text.trim();
  if (text) parts.push(text);
  if (s.sort !== DEFAULT_SORT) parts.push(`sort:${s.sort}`);
  return parts.join(" ");
}

/** Toggle a value in an array facet, returning a new state (for the menus). */
export function toggleFacet(s: FilterState, key: ArrayKey, value: string): FilterState {
  const cur = s[key] as string[];
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  return { ...s, [key]: next };
}

export function clearFacet(s: FilterState, key: ArrayKey): FilterState {
  return { ...s, [key]: [] };
}

export function setSort(s: FilterState, sort: SortTok): FilterState {
  return { ...s, sort };
}

/** How many facets (plus free text) are actively narrowing the list. */
export function activeCount(s: FilterState): number {
  let n = FACETS.reduce((acc, f) => acc + ((s[f.key] as string[]).length ? 1 : 0), 0);
  if (s.text.trim()) n += 1;
  return n;
}

/**
 * What the box matches: the number, the title, and the PEOPLE.
 *
 * It was number, title and author, which answers "whose pull request is this"
 * and not the question actually asked of a board — "where is Javi on this".
 * Typing a reviewer's name found nothing, while the card under the cursor said
 * "Waiting on javidoe" in as many words.
 *
 * Assignees and requested reviewers both, because on this board they are the
 * same question wearing two hats: the one is who owns it, the other is who is
 * being waited on, and a person looking for their own name does not care which
 * column it landed in. The facets stay the exact filters they were — this is
 * the free-text box, where a partial name is the whole point.
 *
 * Logins, because that is what a row carries. A display name is not on the
 * summary at all, so matching it would need a fetch per row.
 */
/**
 * Who on this row the query names, when that is why it is here.
 *
 * A row that matched on its title explains itself; one that matched because a
 * person's login contains "javi" does not, and a list that answers a name with
 * rows carrying somebody else's name in the author column reads as broken. The
 * caller draws this beside the row — see PrRow.
 *
 * Empty when the text matches the title or the author, because then the row is
 * already legible, and empty when there is no text at all.
 */
export function peopleMatched(p: PrSummary, text: string): string[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  if (p.title.toLowerCase().includes(q) || p.author.toLowerCase().includes(q)) return [];
  const who = [...(p.assignees ?? []), ...(p.reviewers ?? []).map((r) => r.login)];
  return who.filter((l, i) => l.toLowerCase().includes(q) && who.indexOf(l) === i);
}

function textMatch(p: PrSummary, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  if (String(p.number).includes(q) || p.title.toLowerCase().includes(q) || p.author.toLowerCase().includes(q)) return true;
  // `?? []` on both: a row from a fixture, an older cache or a by-branch lookup
  // may carry neither field, and a filter is not the place to find that out.
  if ((p.assignees ?? []).some((a) => a.toLowerCase().includes(q))) return true;
  return (p.reviewers ?? []).some((r) => r.login.toLowerCase().includes(q));
}

// AND across facets, OR within a facet. A facet with nothing selected is a
// no-op. A `null` field (checks still loading) fails open.
function matches(p: PrSummary, f: FilterState): boolean {
  for (const facet of FACETS) {
    const sel = f[facet.key] as string[];
    if (sel.length === 0) continue;
    const vals = facet.field(p);
    if (vals === null) continue; // unknown -> fail open
    if (!sel.some((s) => vals.includes(s))) return false;
  }
  return textMatch(p, f.text);
}

const SORTERS: Record<SortTok, (a: PrSummary, b: PrSummary) => number> = {
  "recently-updated": (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
  newest: (a, b) => b.number - a.number,
  oldest: (a, b) => a.number - b.number,
  "most-changed": (a, b) => (b.additions + b.deletions) - (a.additions + a.deletions),
  title: (a, b) => a.title.localeCompare(b.title),
  // Surface what needs attention first: red, then pending, then green, then no-checks.
  checks: (a, b) => checksRank(a) - checksRank(b) || String(b.updatedAt).localeCompare(String(a.updatedAt)),
};

function checksRank(p: PrSummary): number {
  const v = checksTokenOf(p);
  if (v === null || v.length === 0) return 3;
  return v[0] === "red" ? 0 : v[0] === "pending" ? 1 : 2;
}

/** The filtered + sorted rows, for callers that hold the whole set. */
export function applyFilters(prs: PrSummary[], f: FilterState): PrSummary[] {
  return prs.filter((p) => matches(p, f)).sort(SORTERS[f.sort] ?? SORTERS[DEFAULT_SORT]);
}

/**
 * Sort only, no filtering.
 *
 * What the panel wants now that the filter travels to GitHub: the rows in hand
 * ARE the answer, and re-running the same predicate over them can only remove
 * some — which is how a list ends up showing eight rows under a heading that
 * says 216 total. GitHub's `status:` and this panel's `checks:` are close but
 * not identical, and the page is a page, not the set.
 */
export function sortRows(prs: PrSummary[], f: FilterState): PrSummary[] {
  return [...prs].sort(SORTERS[f.sort] ?? SORTERS[DEFAULT_SORT]);
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
  /** The GitHub login this option stands for, when it is a person. */
  avatar?: string;
}
export interface FacetView {
  key: ArrayKey;
  queryKey: string;
  label: string;
  options: FacetOption[];
  selected: string[];
}

const REVIEW_LABEL: Record<string, string> = {
  approved: "Approved", "changes-requested": "Changes requested", required: "Review required", none: "No review",
};
const CHECKS_LABEL: Record<string, string> = { green: "Passing", red: "Failing", pending: "Pending" };
const IS_LABEL: Record<string, string> = { draft: "Draft", ready: "Ready" };

function optionLabel(key: ArrayKey, value: string): string {
  if (key === "reviews") return REVIEW_LABEL[value] ?? value;
  if (key === "checks") return CHECKS_LABEL[value] ?? value;
  if (key === "is") return IS_LABEL[value] ?? value;
  return value;
}

// Per-facet options with GitHub-style live counts: an option's count is the
// number of rows that pass every OTHER facet and carry that option — so a
// facet's own ticks never shrink its sibling counts. Rows whose field is
// unknown (checks still loading) are left out of the tally.
/** The repository's own options, so the menus are not a sample of one page. */
export interface RepoFacets {
  authors: string[];
  assignees: string[];
  labels: { name: string; color: string }[];
  milestones: string[];
  bases: string[];
}

export function buildFacets(prs: PrSummary[], f: FilterState, repo?: RepoFacets | null): FacetView[] {
  return FACETS.map((facet) => {
    const others: FilterState = { ...f, [facet.key]: [] };
    const pool = prs.filter((p) => matches(p, others));

    const counts = new Map<string, number>();
    const order: string[] = [];
    const note = (v: string) => {
      if (!counts.has(v)) order.push(v);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    };
    for (const p of pool) {
      const vals = facet.field(p);
      if (vals === null) continue; // don't count rows we can't classify yet
      for (const v of vals) note(v);
    }

    // Fixed-enum facets show every option in a stable order. Free-form ones
    // come from the REPOSITORY when we know it — the values on the current page
    // are a sample, and a menu built from a sample cannot offer the contributor
    // whose pull requests are all on page four. The page's own values are the
    // fallback, and are merged in so nothing on screen is missing from the menu.
    let values: string[];
    if (facet.fixed) {
      values = facet.fixed.slice();
    } else {
      const fromRepo =
        facet.key === "authors" ? repo?.authors
        : facet.key === "assignees" ? repo?.assignees
        : facet.key === "labels" ? repo?.labels.map((l) => l.name)
        : facet.key === "milestones" ? repo?.milestones
        : facet.key === "base" ? repo?.bases
        : undefined;
      const seen = order.sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b));
      values = fromRepo?.length ? [...new Set([...fromRepo, ...seen])] : seen;
    }
    // Keep a selected value visible even if it currently matches nothing, so its
    // checkbox stays tickable (the escape hatch out of an empty filter).
    for (const v of f[facet.key] as string[]) if (!values.includes(v)) values.push(v);

    return {
      key: facet.key,
      queryKey: facet.queryKey,
      label: facet.label,
      selected: f[facet.key] as string[],
      // No count. It could only ever count the page in hand, and GitHub's own
      // facet menus do not show one either — a number that means "on this page"
      // beside a filter that searches everything is worse than no number.
      options: values.map((v) => ({
        value: v,
        label: optionLabel(facet.key, v),
        count: counts.get(v) ?? 0,
        // Authors and assignees are people; a face finds a name in a list of a
        // dozen faster than reading down it does.
        ...(facet.key === "authors" || facet.key === "assignees" ? { avatar: v } : {}),
      })),
    };
  });
}
