/*
 * A tile's pull request facts, joined from stores the PR board already fills (the list row, the checks, a held behind count).
 * Nothing here asks for anything: with the board not loaded the tile still has the number and the link.
 */
import type { CardPr } from "./cardPrPick.ts";
import { checksForUrl } from "./jiraCardWork.ts";
import { listFactsFor, type ListFacts } from "./prListChecks.ts";
import { prRefFromUrl } from "./openPrs.ts";
import { checksOf } from "./paneChip.ts";
import { ringFor } from "./prCardView.ts";
import { knownBehindByNumber } from "./prBehindStore.ts";
import type { TilePr, TileReview } from "./jiraTileModel.ts";

const DECISION: Record<string, TileReview["kind"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "awaiting" };
function reviewOf(f: ListFacts | null, decision?: string | null): TileReview {
  if (!f) return decision && DECISION[decision] ? { kind: DECISION[decision]!, who: null } : { kind: "unknown", who: null };
  const h = f.humanReview;
  if (h && h.kind !== "awaiting") return { kind: h.kind, who: h.who[0] ?? null };
  const asked = f.reviewers?.[0]?.login ?? null;
  if (h?.kind === "awaiting") return { kind: "awaiting", who: h.who[0] ?? asked };
  return asked ? { kind: "awaiting", who: asked } : { kind: "none", who: null };
}

/** The tile's view of one pull request; `behind` is a count somebody already asked for, or null. */
export function tilePrFrom(pr: CardPr, behind: number | null = null): TilePr {
  const ref = prRefFromUrl(pr.url);
  const f = ref ? listFactsFor(ref.repo, pr.number) : null;
  // The PR board's own readings win; the project read's rollup fills in for a PR the board never loaded.
  const got = checksForUrl(pr.url) ?? (pr.checks ? { checks: pr.checks, at: pr.checksAt ?? 0 } : null);
  const read = checksOf(got);
  // The PR board's own count (ringFor): skipped counts as passed, pending as running, failing is failure only.
  const ring = got?.checks ? ringFor(got.checks, "open", false) : null;
  const state = pr.state === "OPEN" || pr.state === "CLOSED" || pr.state === "MERGED" ? pr.state : "";
  return {
    number: pr.number, state, draft: !!pr.draft || !!f?.isDraft, url: pr.url, ...(pr.title ? { title: pr.title } : {}),
    base: f?.baseRefName || pr.base || null,
    branch: pr.branch || null,
    ci: ring && (read.state === "failing" || read.state === "passing" || read.state === "running")
      ? { state: read.state, passed: ring.green, total: ring.green + ring.red + ring.running, failing: read.failing, failed: ring.red }
      : { state: "unknown", passed: 0, total: 0, failing: [], failed: 0 },
    review: reviewOf(f, pr.reviewDecision),
    behind,
    additions: f ? f.additions : null,
    deletions: f ? f.deletions : null,
    ...(pr.mergeable ? { mergeable: pr.mergeable } : null),
  };
}

/** The tile view with the behind count the board holds, read-only. */
export const tilePrOf = (pr: CardPr): TilePr => tilePrFrom(pr, knownBehindByNumber(pr.number));
