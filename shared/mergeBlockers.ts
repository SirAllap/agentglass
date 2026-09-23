// Every reason a pull request will not merge right now, ranked.
//
// GitHub's merge box lists them all — a locked base, a missing approval, the
// ONE failing check that is required among three that are not — and says which
// is which. This panel had one sentence, built from `mergeStateStatus` and the
// check rollup, and that sentence picked the first two failing names it met.
// On a pull request whose base was locked for a deploy, with three checks red
// of which only the third was required, it said "a, b +1 more failing": the
// lock was not mentioned and the required check was the one hidden in "+1".
//
// So the answer is a list, in the order of what would stop you. `blocks` is
// what GitHub will refuse the merge over; `waits` clears on its own; `warns`
// is true and does not stop anything. Each says what to do about it.
//
// What this cannot see, it says it cannot see. Classic branch protection is
// readable only by admins, and nothing else in the API names a locked branch,
// so for everybody else a lock arrives as BLOCKED with no reason attached.
// That case is a reason of its own ("unexplained") rather than a silence.

import type { PrCheck, PrCheckRollup, PrMergeGate, PrMergeState } from "./types.ts";

export type BlockerWeight = "blocks" | "waits" | "warns";

export type BlockerKind =
  | "draft" | "locked" | "no-permission" | "restricted" | "merge-queue" | "conflicts"
  | "required-failing" | "required-missing" | "changes-requested" | "review-required" | "threads"
  | "behind" | "unexplained" | "computing" | "awaiting" | "required-pending" | "pending"
  | "optional-failing" | "hooks" | "unseen";

export interface MergeBlocker {
  kind: BlockerKind;
  weight: BlockerWeight;
  /** What stands in the way, short enough for a header. */
  title: string;
  /** What to do about it. */
  detail: string;
  /** The checks this is about, required ones first. */
  checks?: PrCheck[];
}

export interface BlockerInput {
  state: "OPEN" | "CLOSED" | "MERGED" | string;
  mergeState: PrMergeState | string;
  mergeable?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  checks?: PrCheckRollup | null;
  checksAll?: PrCheck[];
  baseRefName: string;
  gate?: PrMergeGate;
  /** Unresolved review threads. */
  openThreads?: number;
  /** The caller's own conflict verdict, which can be fresher than GitHub's —
   *  see `conflicted` in PrPanel. Falls back to `mergeable`. */
  conflicted?: boolean;
  /** The branch was pushed a moment ago, so runs are expected and may not
   *  exist yet — see checksStanding in mergeReason.ts. */
  awaitingChecks?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** GitHub's own "the merge button is live" states. See githubWillMerge. */
const WILL_MERGE = new Set(["CLEAN", "UNSTABLE", "HAS_HOOKS"]);

/** Names, required first, cut to what a line can hold. */
export function checkNames(list: PrCheck[], max = 2): string {
  const sorted = [...list].sort((a, b) => Number(!!b.required) - Number(!!a.required));
  const shown = sorted.slice(0, max).map((c) => c.name).join(", ");
  return sorted.length > max ? `${shown} +${sorted.length - max} more` : shown;
}

/**
 * Whether GitHub was asked which checks are required. Without that, "not
 * required" is not something this can say about any of them.
 */
const knowsRequired = (i: BlockerInput) => !!i.gate;

/**
 * What an approval still owed is made of.
 *
 * `REVIEW_REQUIRED` does not say which rule is unmet, so this does not guess
 * one: it names the count and every extra condition the branch sets, and the
 * reader can see which of them their reviews already satisfy.
 */
function reviewTitle(i: BlockerInput): { title: string; detail: string } {
  const g = i.gate;
  const n = g?.approvals ?? 0;
  const also: string[] = [];
  if (g?.codeOwners) also.push("one of them from a code owner of the files it touches");
  if (g?.lastPushApproval) also.push("given after the latest push, by somebody other than who pushed it");
  return {
    title: n > 0 ? `Needs ${plural(n, "approving review")}` : "Needs an approving review",
    detail: also.length
      ? `This branch wants ${also.join(", and ")}.`
      : "Ask for a review, or wait for the one already asked for.",
  };
}

export function mergeBlockers(i: BlockerInput): MergeBlocker[] {
  if (i.state !== "OPEN") return [];
  const out: MergeBlocker[] = [];
  const g = i.gate;
  const base = i.baseRefName || "the base branch";
  const all = i.checksAll ?? [];
  const failing = all.filter((c) => c.state === "failure");
  const reqFailing = failing.filter((c) => c.required);
  const optFailing = failing.filter((c) => !c.required);
  const pending = all.filter((c) => !c.done && c.state !== "failure");
  const reqPending = pending.filter((c) => c.required);
  const blocked = i.mergeState === "BLOCKED";
  /*
   * Required, and not in the rollup at all. GitHub waits on these as
   * "Expected — waiting for status to be reported": right after a push that is
   * a matter of seconds; for a workflow a path filter skipped, it is forever.
   */
  const reported = new Set(all.map((c) => c.name));
  const missing = (g?.requiredContexts ?? []).filter((n) => !reported.has(n));

  if (i.isDraft || i.mergeState === "DRAFT") {
    out.push({ kind: "draft", weight: "blocks", title: "It is a draft", detail: "Mark it ready for review first." });
  }

  if (g?.locked) {
    out.push(g.canBypass
      /* GitHub offers this viewer the merge anyway, so it is a thing to know
         rather than a wall — a release manager during a freeze. */
      ? {
        kind: "locked", weight: "warns", title: `${base} is locked`,
        detail: `Locked${g.lockedBy ? ` (${g.lockedBy})` : ""}, and your role lets you merge past it. Everybody else has to wait for it to be unlocked.`,
      }
      : {
        kind: "locked", weight: "blocks", title: `${base} is locked`,
        detail: `Nothing can be merged into ${base} until it is unlocked${g.lockedBy ? ` (${g.lockedBy})` : ""} — usually a deploy freeze. Checks going green will not clear it.`,
      });
  }

  if (g?.permission === "READ" || g?.permission === "TRIAGE") {
    out.push({
      kind: "no-permission", weight: "blocks", title: "You cannot merge here",
      detail: "Your role on this repository does not include merging; somebody with write access has to.",
    });
  } else if (g?.viewerCanPush === false && !g.locked) {
    // A push restriction on the base refuses merges from anybody not on its
    // list, and branch protection says so through `viewerCanPush`.
    out.push({
      kind: "restricted", weight: "blocks", title: `You are not allowed to push to ${base}`,
      detail: "Branch protection limits who may merge into it. Somebody on that list has to merge it.",
    });
  }

  if (g?.mergeQueue && !g.inQueue) {
    /* A note, not a refusal: the merge still starts here, and GitHub decides
       when the queue lands it. What changes is that "merged" is not the
       immediate result of pressing. */
    out.push({
      kind: "merge-queue", weight: "warns", title: `${base} merges through a queue`,
      detail: "GitHub lands it when the merge queue reaches it, not at the press — and runs the required checks again on the way.",
    });
  }

  const conflicted = i.conflicted ?? (i.mergeable === "CONFLICTING" || i.mergeState === "DIRTY");
  if (conflicted) {
    out.push({ kind: "conflicts", weight: "blocks", title: `Conflicts with ${base}`, detail: "Resolve them and push; nothing else here moves until then." });
  }

  if (reqFailing.length > 0) {
    out.push({
      kind: "required-failing", weight: "blocks",
      title: `${checkNames(reqFailing)} failing — required`,
      detail: `GitHub will not merge until ${reqFailing.length === 1 ? "it passes" : "they pass"}. Fix it, or re-run ${reqFailing.length === 1 ? "it" : "them"} if the failure is not the change's.`,
      checks: reqFailing,
    });
  } else if (!knowsRequired(i) && failing.length > 0 && !WILL_MERGE.has(i.mergeState) && i.mergeState !== "BEHIND") {
    // Not asked which ones count: the old sentence, with its old uncertainty.
    out.push({
      kind: "required-failing", weight: "blocks", title: `${checkNames(failing)} failing`,
      detail: "GitHub did not say which of these are required.", checks: failing,
    });
  }

  if (missing.length > 0) {
    const names = missing.slice(0, 2).join(", ") + (missing.length > 2 ? ` +${missing.length - 2} more` : "");
    /* Not "never" while anything is still running: a job that `needs`
       others gets its check run only when it starts. Measured on a pull
       request whose required summary job was absent from the rollup while two
       checks it waits on were still going. */
    out.push(i.awaitingChecks
      ? { kind: "required-missing", weight: "waits", title: `${names} not reported yet — required`, detail: "The branch just moved; GitHub creates the runs a few seconds after the push." }
      : pending.length > 0
      ? { kind: "required-missing", weight: "waits", title: `${names} not started yet — required`, detail: "It may be waiting on the checks still running; a job that depends on others starts when they finish." }
      : {
        kind: "required-missing", weight: "blocks", title: `${names} never reported — required`,
        detail: `GitHub is waiting for ${missing.length === 1 ? "it" : "them"} and nothing is running. If the workflow did not trigger — a path filter, say — it never will: push, or run it by hand.`,
      });
  }

  if (i.reviewDecision === "CHANGES_REQUESTED") {
    out.push({ kind: "changes-requested", weight: "blocks", title: "Changes requested", detail: "Address them and ask the reviewer to look again." });
  } else if (i.reviewDecision === "REVIEW_REQUIRED") {
    out.push({ kind: "review-required", weight: "blocks", ...reviewTitle(i) });
  }

  if (g?.conversationResolution && (i.openThreads ?? 0) > 0) {
    out.push({
      kind: "threads", weight: "blocks",
      title: `${plural(i.openThreads!, "conversation")} unresolved`,
      detail: "This branch requires every review thread resolved before merging — a reply is not a resolve.",
    });
  }

  if (i.mergeState === "BEHIND") {
    out.push({
      kind: "behind", weight: g?.upToDate === true ? "blocks" : "warns", title: `Behind ${base}`,
      detail: g?.upToDate === true
        ? `This branch has to be up to date with ${base} first — update it and let the checks run again.`
        : `It may need updating first, and the checks that passed ran against an older ${base}.`,
    });
  }

  if (i.mergeState === "UNKNOWN" && !conflicted && !i.isDraft) {
    out.push({ kind: "computing", weight: "waits", title: "GitHub is still working it out", detail: "It computes mergeability lazily; this settles in a few seconds." });
  }

  // Pushed a moment ago and nothing has reported: the checks are the reason,
  // they just do not exist yet.
  if (i.awaitingChecks && all.length === 0 && missing.length === 0) {
    out.push({ kind: "awaiting", weight: "waits", title: "Waiting for the checks to start", detail: "The branch just moved; GitHub creates the runs a few seconds after the push." });
  }

  if (reqPending.length > 0) {
    out.push({
      kind: "required-pending", weight: "waits",
      title: `${checkNames(reqPending)} still running — required`,
      detail: "Nothing to do but wait for it.", checks: reqPending,
    });
  }
  const otherPending = pending.filter((c) => !c.required);
  if (otherPending.length > 0 && reqPending.length === 0) {
    out.push({
      kind: "pending", weight: "waits", title: `${plural(otherPending.length, "check")} still running`,
      detail: knowsRequired(i) ? "None of them is required." : "Nothing has failed.", checks: otherPending,
    });
  }

  /*
   * BLOCKED, and nothing above says why.
   *
   * The measured case: the base was locked for a deploy, and to anybody but an
   * admin the API says nothing about it at all. Saying "Merging is blocked"
   * and then listing nothing was the old behaviour's cousin — the reason is
   * real, it is just the one GitHub keeps to itself. Name the likely ones and
   * send the reader to the page that knows.
   *
   * A required check still running explains BLOCKED as well as a red one does;
   * so does any running check when nobody asked which are required, and so
   * does a push the checks have not caught up with.
   */
  const explained = out.some((b) => b.weight === "blocks"
    || b.kind === "required-pending" || b.kind === "required-missing" || b.kind === "awaiting" || b.kind === "computing"
    || (b.kind === "pending" && !knowsRequired(i)));
  if (blocked && !explained) {
    const maybe: string[] = [];
    if (!g || !g.protectionVisible) maybe.push("a locked branch (a deploy freeze, say)");
    if (g?.signatures) maybe.push("an unsigned commit");
    if (g?.deployments.length) maybe.push(`a deployment to ${g.deployments.join(", ")}`);
    if (!g) maybe.push("a required review or check");
    if (maybe.length === 0) maybe.push("a rule this app cannot read");
    out.push({
      kind: "unexplained", weight: "blocks", title: "GitHub is blocking it without saying why",
      detail: `Most likely ${maybe.join(", or ")}. GitHub's own page names it${g?.canBypass ? " — and offers you, as an admin, a merge past it" : ""}.`,
    });
  }

  /*
   * Explained, and possibly not completely.
   *
   * The pull request this list was built for had a required check failing AND
   * a locked base; to a writer only the first was visible. Fixing the check
   * would have left it just as blocked, by a reason this panel never named.
   *
   * Only when the visible reasons are all checks. A review still owed, a
   * conflict or a draft is the next thing to do whatever else is hiding, and a
   * warning on every blocked pull request is one people learn to skip.
   */
  const CHECK_KINDS = new Set<BlockerKind>(["required-failing", "required-missing"]);
  const visibleBlocks = out.filter((b) => b.weight === "blocks");
  if (blocked && g && !g.protectionVisible && g.locked === null
    && visibleBlocks.length > 0 && visibleBlocks.every((b) => CHECK_KINDS.has(b.kind))) {
    out.push({
      kind: "unseen", weight: "warns", title: "There may be a reason GitHub is not showing you",
      detail: "Branch protection is only readable by admins, and a locked branch is set there. GitHub's own page lists everything.",
    });
  }

  if (optFailing.length > 0 && (knowsRequired(i) || WILL_MERGE.has(i.mergeState))) {
    // Without a gate, GitHub calling it mergeable is itself the answer: a red
    // check it is willing to merge over is one it does not require.
    out.push({
      kind: "optional-failing", weight: "warns",
      title: `${checkNames(optFailing)} failing — not required`,
      detail: "GitHub does not wait for these, but somebody may want to know why they are red.", checks: optFailing,
    });
  }

  if (i.mergeState === "HAS_HOOKS") {
    out.push({ kind: "hooks", weight: "warns", title: "Repository hooks run on merge", detail: "GitHub will merge it; a pre-receive hook may still refuse." });
  }

  // Pushed in the order of what would stop you; the sort only lifts the
  // unexplained block above the waits it was computed after. Stable, so the
  // order within a weight is the order above.
  const rank: Record<BlockerWeight, number> = { blocks: 0, waits: 1, warns: 2 };
  return out.sort((a, b) => rank[a.weight] - rank[b.weight]);
}

/**
 * What refuses a merge from this panel, if anything does.
 *
 * Where GitHub's own state says it will merge (or is BEHIND, where the panel
 * offers "merge anyway" with a confirmation), its answer already accounts for
 * checks, reviews and threads, and second-guessing it is how a check marked
 * required by a name collision would take a working button away. Only what
 * that state cannot see refuses then: a lock, a role without merge rights, a
 * draft, a conflict git found before GitHub did. Anywhere else GitHub has
 * already refused, and this only names why.
 */
export function mergeRefusal(list: MergeBlocker[], mergeState?: string): MergeBlocker | null {
  const unseenByState = new Set<BlockerKind>(["locked", "no-permission", "restricted", "draft", "conflicts"]);
  const lenient = !mergeState || WILL_MERGE.has(mergeState) || mergeState === "BEHIND";
  return list.find((b) => b.weight === "blocks" && b.kind !== "behind" && (!lenient || unseenByState.has(b.kind))) ?? null;
}

/**
 * Whether "Merge when green" is an honest offer.
 *
 * Auto-merge waits for checks and reviews. It does not wait out a lock, a
 * conflict, a draft or a permission you lack, and arming it over one of those
 * promises a merge that is not coming — the "mergeable when green" this panel
 * is not allowed to claim. Nor does it update a branch that must be up to
 * date, so a strict "behind" refuses it too. Returns the reason, or null.
 */
export function autoMergeRefusal(list: MergeBlocker[]): string | null {
  const waitable = new Set<BlockerKind>([
    "required-failing", "required-missing", "required-pending", "pending", "awaiting", "review-required",
    "changes-requested", "threads", "computing", "optional-failing", "hooks", "merge-queue", "unseen",
  ]);
  const hard = list.find((b) => b.weight === "blocks" && !waitable.has(b.kind));
  if (!hard) return null;
  return hard.kind === "unexplained"
    ? "GitHub is blocking it for a reason that is not the checks, so going green would not merge it"
    : `${hard.title} — going green would not merge it`;
}

/**
 * The words for an approval that commits have landed after.
 *
 * "Approved, but it has moved since" read as "that approval is gone", on a
 * repository where GitHub still counted it — two approving reviews, both still
 * valid, because that repository does not dismiss approvals on a push.
 *
 * "Still counts" is said only on GitHub's word: `reviewDecision` APPROVED.
 * Anything short of that — an approval from somebody without write access, a
 * code-owner rule it does not meet, fewer approvals than required — and the
 * honest sentence is the older, weaker one. APPROVED also counts a bot's
 * approval, which is why the note speaks of GitHub counting it rather than of
 * this approval being the one that tipped it.
 *
 * "Keeps approvals across pushes" is said only where the gate knows the branch
 * does not dismiss them: a branch that does still keeps an approval across a
 * push that leaves the diff alone, such as a merge of the base.
 */
export function staleApproval(
  reviewDecision: string | null | undefined,
  /** Who, as the start of the sentence: "Approved by ada", "You approved". */
  subject = "Approved",
  gate?: Pick<PrMergeGate, "lastPushApproval" | "dismissStale"> | null,
): { counts: boolean | null; head: string; note: string } {
  if (gate?.lastPushApproval) {
    // Older approvals still count toward the number; it is the latest push
    // that needs one of its own.
    return {
      counts: reviewDecision === "APPROVED" ? true : false,
      head: `${subject}, but not the latest push`,
      note: "This branch wants the latest push approved by somebody other than who pushed it, and commits landed after this review.",
    };
  }
  if (reviewDecision === "APPROVED") {
    return {
      counts: true, head: `${subject} — still counts`,
      note: gate?.dismissStale === false
        ? "GitHub still counts it: this repository keeps approvals across pushes. Commits landed after it, so it has not seen what is here now."
        : "GitHub still counts it. Commits landed after it, so it has not seen what is here now.",
    };
  }
  return { counts: null, head: `${subject}, but it has moved since`, note: "Commits landed after that review — it does not cover what is here now." };
}
