/*
 * What is standing between a pull request and a merge, one thing per row.
 *
 * The merge sheet said it in one sentence, `mergeVerdict`'s line: right, and
 * the shape of a verdict rather than of a list. "test (ubuntu-latest), lint
 * failing" tells you there is a problem and not which of three it is, and a
 * pull request that is red, behind and still waiting on a reviewer is all
 * three at once — the one line names whichever comes first.
 *
 * So the sheet asks this for the parts. Every row is something GitHub itself
 * reported; nothing here is inferred from a count that could mean two things.
 * The sentence stays the header above them and stays `mergeVerdict`'s, so the
 * sheet and the overview cannot disagree about whether it is blocked.
 *
 * Conversations are not listed. Branch protection CAN require them resolved,
 * but nothing on the wire says whether this branch does, and a row claiming
 * they block the merge on a repository that does not care would be the app
 * inventing a rule.
 */
import type { PrCheckRollup } from "../../../shared/types.ts";

export interface Obstacle {
  title: string;
  sub?: string;
  /** Where a tap goes: the job logs, or nowhere (the fix is on GitHub or on
   *  the branch, and this phone cannot do it from a row). */
  opens?: "checks";
  tone: "bad" | "warn";
}

export interface MergeFacts {
  mergeState: string;
  checks: PrCheckRollup | null | undefined;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  isDraft: boolean;
  baseRefName: string;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
}

/** Three failing checks named, then a count: a list of forty red rows is a
 *  CI log, and the Checks screen is one tap away for that. */
const NAMED = 3;

export function mergeObstacles(pr: MergeFacts): Obstacle[] {
  const out: Obstacle[] = [];
  if (pr.isDraft || pr.mergeState === "DRAFT") {
    out.push({ title: "It is a draft", sub: "Mark it ready for review first", tone: "warn" });
  }
  if (pr.mergeState === "DIRTY" || pr.mergeable === "CONFLICTING") {
    out.push({ title: `Conflicts with ${pr.baseRefName}`, sub: "They are resolved on the branch", tone: "bad" });
  }
  if (pr.mergeState === "BEHIND") {
    out.push({ title: `Behind ${pr.baseRefName}`, sub: "Update the branch, then the checks run again", tone: "warn" });
  }

  const c = pr.checks;
  if (c && c.failure > 0) {
    const named = c.failing.slice(0, NAMED);
    for (const check of named) {
      out.push({ title: `${check.name} failed`, sub: "Open the log", opens: "checks", tone: "bad" });
    }
    // `failing` can be shorter than `failure` when GitHub capped the page; the
    // count is the honest number and the names are what it could show.
    const rest = Math.max(c.failure, c.failing.length) - named.length;
    if (rest > 0) {
      out.push({ title: `${rest} more ${rest === 1 ? "check" : "checks"} failed`, opens: "checks", tone: "bad" });
    }
  }
  if (c && c.pending > 0) {
    out.push({
      title: `${c.pending} ${c.pending === 1 ? "check" : "checks"} still running`,
      sub: "Nothing has failed in them yet",
      opens: "checks",
      tone: "warn",
    });
  }

  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    out.push({ title: "Changes were requested", sub: "The reviewer has to approve again", tone: "bad" });
  } else if (pr.reviewDecision === "REVIEW_REQUIRED") {
    out.push({ title: "Needs an approval", sub: `Branch protection on ${pr.baseRefName}`, tone: "warn" });
  }
  return out;
}

/** Enough of `PrDetail` to decide the merge sheet's warning — named rather
 *  than the whole type so a test can hand in exactly what the decision reads. */
export interface ChangesRequestedFacts {
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  openThreads?: { open: number; more: boolean };
  humanReview?: { who: string[] } | null;
}

export interface ChangesRequestedWarning {
  note: string;
  /** The bottom Merge button's tone. Green reads as "go ahead" — GitHub will
   *  take a CHANGES_REQUESTED pull request when branch protection does not
   *  require review, and `mergeVerdict` (mergeReason.ts) says "Ready to
   *  merge" on the strength of that alone, without ever asking who reviewed
   *  it. This is the sheet's own second question, so the button does not
   *  contradict the row it sits under. */
  buttonTone: "plain";
}

/**
 * Merging is still allowed and the header still says "Ready to merge" —
 * `mergeVerdict` answers "will GitHub take it", not "should you take it
 * over this review" — so the sheet asks that second question here and says
 * it out loud rather than only in the green button matching the green line
 * above it.
 *
 * Null when there is nothing to add: no review has asked for changes, or one
 * did and was superseded (`mergeObstacles`/GitHub's `reviewDecision` already
 * stops saying `CHANGES_REQUESTED` once a fresh review clears it).
 */
export function changesRequestedWarning(pr: ChangesRequestedFacts): ChangesRequestedWarning | null {
  if (pr.reviewDecision !== "CHANGES_REQUESTED") return null;
  const who = pr.humanReview?.who?.[0];
  const threads = pr.openThreads?.open ?? 0;
  const parts = [
    `Changes were requested${who ? ` (by ${who})` : ""}`,
    ...(threads > 0 ? [`${threads} open ${threads === 1 ? "thread" : "threads"}`] : []),
  ];
  return {
    note: `${parts.join(" · ")} — merging lands it over that review.`,
    buttonTone: "plain",
  };
}
