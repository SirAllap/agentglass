// Who has said what on the review side of a pull request, one entry per person.
//
// The merge box used to know two review facts, GitHub's `reviewDecision` and the
// server's `humanReview` (one verdict for the whole set), so a pull request with
// five reviewers in five different states read as one sentence and the box could
// not say "2 of 3 approvals". This is the per-person read behind the tally, the
// rows and the owners, in one pure function so every state a reviewer can be in
// is a row of one table-driven test.
//
// It reads nothing GitHub does not already hand over: the reviews and the
// requested reviewers of the detail, the branch's rule (`gate.approvals`,
// `dismissStale`, both read once with the gate), and the first author of each
// open thread. A number the rule did not give is `null`, never a guess.
//
// What it does not know: whether a person may count (write access, a code-owner
// path), and which person a requested TEAM will answer with. Those stay
// GitHub's word, through `reviewDecision`.

import type { PrMergeGate, PrReview, PrReviewer } from "./types.ts";

export type ReviewerState =
  /** Approved, and the code has not moved since. */
  | "approved"
  /** Approved before the last push, and the repository keeps it: it still counts. */
  | "approved-old"
  /** Approved before the last push, and the repository dismisses those: it does not count. */
  | "approved-void"
  | "changes"
  /** Asked to look again after wanting changes: the old request still blocks. */
  | "changes-again"
  | "commented"
  /** Asked, and no verdict yet (or the verdict was dismissed and they were asked again). */
  | "requested"
  /** The review was dismissed and nobody asked again. */
  | "dismissed"
  | "team";

export interface RosterEntry {
  login: string;
  state: ReviewerState;
  /** Counts toward the approvals the branch asks for. */
  counts: boolean;
  /** When they last said something (or, for a request, when it was made). */
  at?: string;
  /** Asked to look again since their verdict. */
  askedAgain: boolean;
  /** Open threads that person started. */
  threads: number;
  /** For a verdict: the review it comes from, so a press can land on it. */
  review?: PrReview;
}

export interface RosterInput {
  reviews?: PrReview[];
  /** Reviewers still asked, people and teams. */
  reviewers?: PrReviewer[];
  author?: string;
  /** The commit at the tip of the branch. Without it nothing is called stale. */
  headSha?: string;
  reviewDecision?: string | null;
  gate?: Pick<PrMergeGate, "approvals" | "dismissStale" | "protectionVisible" | "codeOwners"> | null;
  /** First author of each open thread, so a thread belongs to the person who opened it. */
  threadAuthors?: string[];
  askedAt?: Record<string, string>;
  /** People the server knows were asked to look again even where the request list no longer shows them. */
  askedAgain?: string[];
}

export interface Roster {
  entries: RosterEntry[];
  counted: number;
  /** Approvals the branch asks for. `0`: none. `null`: nobody said, and no number is made up. */
  needed: number | null;
}

const lc = (s: string | undefined) => (s ?? "").toLowerCase();

const ORDER: ReviewerState[] = ["approved", "approved-old", "approved-void", "changes", "changes-again", "requested", "team", "commented", "dismissed"];

export function buildRoster(i: RosterInput): Roster {
  const author = lc(i.author);
  const gate = i.gate ?? null;
  const head = i.headSha || "";

  const needed = gate && gate.approvals > 0 ? gate.approvals
    : gate && gate.protectionVisible && i.reviewDecision !== "REVIEW_REQUIRED" ? 0
    : null;

  const asked = new Map<string, PrReviewer>();
  for (const r of i.reviewers ?? []) if (r.login && !(!r.isTeam && lc(r.login) === author)) asked.set(lc(r.login), r);

  const seen = new Map<string, { login: string; verdict?: PrReview; commented?: PrReview }>();
  const humans = (i.reviews ?? [])
    .filter((r) => !r.isBot && lc(r.author) !== author && r.state !== "PENDING")
    .sort((a, b) => (a.submittedAt || "").localeCompare(b.submittedAt || ""));
  for (const r of humans) {
    const p = seen.get(lc(r.author)) ?? { login: r.author };
    if (r.state === "COMMENTED") p.commented = r; else p.verdict = r;
    seen.set(lc(r.author), p);
  }
  for (const [k, r] of asked) if (!r.isTeam && !seen.has(k)) seen.set(k, { login: r.login });

  const askedAgain = new Set((i.askedAgain ?? []).map(lc));
  const openBy = new Map<string, number>();
  for (const a of i.threadAuthors ?? []) openBy.set(lc(a), (openBy.get(lc(a)) ?? 0) + 1);

  const entries: RosterEntry[] = [];
  for (const [k, p] of seen) {
    const again = (asked.has(k) && !asked.get(k)!.isTeam) || (askedAgain.has(k) && !!p.verdict);
    const v = p.verdict;
    const base = { login: p.login, askedAgain: again && !!v && v.state !== "DISMISSED", threads: openBy.get(k) ?? 0 };
    if (v?.state === "APPROVED") {
      const old = !!(v.commit && head && v.commit !== head);
      const void_ = old && gate?.dismissStale === true;
      entries.push({ ...base, state: void_ ? "approved-void" : old ? "approved-old" : "approved", counts: !void_, at: v.submittedAt, review: v });
    } else if (v?.state === "CHANGES_REQUESTED") {
      entries.push({ ...base, state: base.askedAgain ? "changes-again" : "changes", counts: false, at: v.submittedAt, review: v });
    } else if (again) {
      entries.push({ ...base, state: "requested", counts: false, at: i.askedAt?.[k] ?? p.commented?.submittedAt });
    } else if (v?.state === "DISMISSED") {
      entries.push({ ...base, state: "dismissed", counts: false, at: v.submittedAt, review: v });
    } else if (p.commented) {
      entries.push({ ...base, state: "commented", counts: false, at: p.commented.submittedAt, review: p.commented });
    }
  }
  for (const [k, r] of asked) {
    if (r.isTeam) entries.push({ login: r.login, state: "team", counts: false, askedAgain: false, threads: 0, at: i.askedAt?.[k] });
  }
  entries.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (b.at || "").localeCompare(a.at || ""));
  return { entries, counted: entries.filter((e) => e.counts).length, needed };
}

/** "2 approved · 1 changes · 1 re-requested": the tally, in the order a reader scans it. */
export function rosterCounts(entries: RosterEntry[]): string {
  const n = (f: (e: RosterEntry) => boolean) => entries.filter(f).length;
  const bits: [number, string][] = [
    [n((e) => e.state === "approved" || e.state === "approved-old"), "approved"],
    [n((e) => e.state === "approved-void"), "approval no longer counts"],
    [n((e) => e.state === "changes"), "changes"],
    [n((e) => e.state === "changes-again"), "re-requested"],
    [n((e) => e.state === "requested"), "not answered"],
    [n((e) => e.state === "team"), "team asked"],
    [n((e) => e.state === "commented"), "commented"],
    [n((e) => e.state === "dismissed"), "dismissed"],
  ];
  return bits.filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`).join(" · ");
}

/** "2 of 3 approvals needed"; "approval required" when the branch did not say how many. */
export function approvalsNeed(r: Roster, reviewDecision?: string | null): string | null {
  if (r.needed !== null && r.needed > 0) {
    return r.counted >= r.needed ? `${r.counted} of ${r.needed} approvals` : `${r.counted} of ${r.needed} approvals needed`;
  }
  if (r.needed === 0) return "review not required";
  if (reviewDecision === "REVIEW_REQUIRED") return "approval required";
  return null;
}

/**
 * What a merge would skip: a person asked to review who has not answered, or an
 * approval that came only from automation.
 *
 * GitHub allows the merge in both cases (its own decision counts a bot with
 * write access), so this never blocks: it is the fact a person should have in
 * front of them before pressing. Measured on a pull request whose only approval
 * was a review bot's while a named colleague sat requested: the box said "Ready
 * to merge" over "0 of 1 approvals needed", a contradiction, because the roster
 * counts people and GitHub's decision counted the bot.
 */
export interface MergeGuard {
  /** People and teams asked and not answered, in the order GitHub lists them. */
  pending: string[];
  /** Automations whose latest verdict is an approval. */
  botApprovers: string[];
  /** Somebody who is not the author and not a bot approved, latest verdict standing. */
  humanApproved: boolean;
  /** Approved, but only by automation. */
  botOnly: boolean;
}

export function mergeGuard(i: { reviews?: PrReview[]; reviewers?: PrReviewer[]; author?: string }): MergeGuard | null {
  const author = lc(i.author);
  const pending = (i.reviewers ?? []).filter((r) => r.login && (r.isTeam || lc(r.login) !== author)).map((r) => r.login);
  // The latest verdict of each author: a later dismissal or change request undoes an approval.
  const last = new Map<string, PrReview>();
  const verdicts = (i.reviews ?? [])
    .filter((r) => (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED") && lc(r.author) !== author)
    .sort((a, b) => (a.submittedAt || "").localeCompare(b.submittedAt || ""));
  for (const r of verdicts) last.set(lc(r.author), r);
  const approvals = [...last.values()].filter((r) => r.state === "APPROVED");
  const botApprovers = approvals.filter((r) => r.isBot).map((r) => r.author);
  const humanApproved = approvals.some((r) => !r.isBot);
  const botOnly = !humanApproved && botApprovers.length > 0;
  return pending.length || botOnly ? { pending, botApprovers, humanApproved, botOnly } : null;
}

const joinNames = (n: string[]) => n.length <= 2 ? n.join(" and ") : `${n[0]}, ${n[1]} +${n.length - 2}`;

/** The warning lines, one per fact: "bob hasn't reviewed yet", "only a bot has approved". */
export function guardLines(g: MergeGuard): string[] {
  const out: string[] = [];
  if (g.pending.length) out.push(`${joinNames(g.pending)} ${g.pending.length === 1 ? "hasn't" : "haven't"} reviewed yet`);
  if (g.botOnly) out.push(g.botApprovers.length === 1 ? "only a bot has approved" : "only bots have approved");
  return out;
}
