/**
 * What the Overview box says about an open pull request, decided away from the
 * screen: the verdict sentence and the four rows under it (Checks, Review,
 * Conflicts, Branch). The staged path in shared/mergePath.ts still decides WHO
 * has to move; this is the short answer to "can it land, and if not what is in
 * the way", in the words the mockup uses.
 */
import type { ReviewerState } from "./prReviewers.ts";

export type Tone = "ok" | "warn" | "bad";
export type RowKey = "checks" | "review" | "conflicts" | "branch";
export type OverviewRow = {
  key: RowKey;
  tone: Tone;
  label: string;
  text: string;
  /** The button on the row: See checks / Open conversation. */
  go?: "checks" | "conversation";
  /** Red checks can be run again from their own row. */
  rerun?: boolean;
};
export type Verdict = { tone: Tone; lead: string; text: string };

export type OverviewFacts = {
  checks: { success: number; failure: number; pending: number; skipped: number; total: number };
  /** Said when the checks have not started yet and an empty list is not a green one. */
  awaitingChecks?: boolean;
  /** People only: a bot or a team has no verdict to read out. */
  reviewers: { login: string; state: ReviewerState; again?: boolean; isBot?: boolean; isTeam?: boolean }[];
  conflicted: boolean;
  conflictFiles?: number;
  head: string;
  base: string;
  behind: number | null;
  /** GitHub says the base has moved but the count is not in yet. */
  behindMoved?: boolean;
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const SAID: Record<ReviewerState, string> = {
  approved: "approved", changes: "asked for changes", awaiting: "has not answered", commented: "commented", dismissed: "had a review dismissed",
};

export function overviewRows(f: OverviewFacts): OverviewRow[] {
  const c = f.checks;
  const ran = c.success + c.failure + c.pending;
  const checks: OverviewRow = c.failure > 0
    ? { key: "checks", tone: "bad", label: "Checks", text: `${c.failure} failing, ${c.success} passing`, go: "checks", rerun: true }
    : c.pending > 0
    ? { key: "checks", tone: "warn", label: "Checks", text: `${c.pending} still running`, go: "checks" }
    : c.total === 0
    ? { key: "checks", tone: f.awaitingChecks ? "warn" : "ok", label: "Checks", text: f.awaitingChecks ? "Waiting for them to start" : "None reported", go: "checks" }
    : { key: "checks", tone: "ok", label: "Checks", text: `${c.success} of ${ran} passing${c.skipped > 0 ? ` · ${c.skipped} skipped` : ""}`, go: "checks" };

  const people = f.reviewers.filter((r) => !r.isBot && !r.isTeam);
  const review: OverviewRow = {
    key: "review",
    tone: people.some((r) => r.state === "changes") ? "bad" : people.some((r) => r.state === "approved") ? "ok" : "warn",
    label: "Review",
    text: people.length
      ? people.map((r) => `${r.login} ${r.again && r.state === "awaiting" ? "was asked to look again" : SAID[r.state]}`).join(", ")
      : "Nobody has been asked yet",
    go: "conversation",
  };

  const conflicts: OverviewRow = f.conflicted
    ? { key: "conflicts", tone: "bad", label: "Conflicts", text: `${f.head} conflicts with ${f.base}${f.conflictFiles ? ` in ${plural(f.conflictFiles, "file")}` : ""}` }
    : { key: "conflicts", tone: "ok", label: "Conflicts", text: `No conflicts with ${f.base}` };

  const behind = f.behind ?? 0;
  const branch: OverviewRow = behind > 0
    ? { key: "branch", tone: "warn", label: "Branch", text: `${plural(behind, "commit")} behind ${f.base}` }
    : f.behindMoved
    ? { key: "branch", tone: "warn", label: "Branch", text: `${f.base} has moved on` }
    : { key: "branch", tone: "ok", label: "Branch", text: `Up to date with ${f.base}` };

  return [checks, review, conflicts, branch];
}

/**
 * "Ready to land. Approved by A and B, 12 checks green, no conflicts." or
 * "Merging is blocked. <why>." The why is the dock's own sentence, so the box
 * and the dock cannot say two different things about the same pull request.
 */
export function overviewVerdict(i: { ready: boolean; why: string; conflicted: boolean; checksFailing: number; approvedBy: string[]; checksPassed: number }): Verdict {
  if (i.ready) {
    const by = i.approvedBy.length ? i.approvedBy.join(" and ") : "reviewers";
    return { tone: "ok", lead: "Ready to land.", text: `Approved by ${by}, ${plural(i.checksPassed, "check")} green, no conflicts.` };
  }
  const why = i.why.replace(/[.\s]+$/, "");
  return {
    tone: i.conflicted || i.checksFailing > 0 ? "bad" : "warn",
    lead: "Merging is blocked.",
    text: `${why}.${i.conflicted ? " Resolve it here or hand it to a terminal." : ""}`,
  };
}
