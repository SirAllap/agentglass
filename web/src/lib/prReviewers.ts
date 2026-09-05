/*
 * Who is reviewing this, and how it went.
 *
 * The sidebar used to print GitHub's OUTSTANDING request list — the people who
 * have been asked and have not answered — under the heading "Reviewers". On a
 * pull request where everybody has answered, that list is empty, so the panel
 * said "No reviewers" about a pull request with two approvals and one request
 * for changes on it. Reported with both screens side by side: "on GH they show
 * up as reviewers… but in agentglass as participants, with no state or
 * anything".
 *
 * GitHub's own list is the union: everybody who has reviewed, with their latest
 * verdict, plus everybody still being waited on. That is what this builds.
 *
 * Pure, and given the two arrays rather than the detail object, because every
 * awkward case here is about ORDER — three reviews from the same person, a
 * comment after an approval, a re-request after a verdict — and those are worth
 * checking without a network.
 */

/** What a reviewer has said, in the words the sidebar uses. */
export type ReviewerState = "changes" | "awaiting" | "approved" | "commented" | "dismissed";

export interface ReviewerRow {
  login: string;
  state: ReviewerState;
  /** ISO time of the review this state came from. Absent while awaiting. */
  at?: string;
  /** A team, which has no face and no verdict of its own. */
  isTeam?: boolean;
  isBot?: boolean;
  /** They have already reviewed AND been asked again — GitHub's ↻. */
  again?: boolean;
}

interface ReviewLike {
  author: string;
  isBot?: boolean;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt: string;
}

interface RequestedLike { login: string; isTeam?: boolean }

/**
 * The order the list is drawn in, and it is not GitHub's.
 *
 * GitHub keeps request order, which on a pull request that has been round three
 * times says nothing. This is sorted by what it costs you: somebody blocking
 * the merge first, then the people you are still waiting on, then the ones who
 * are already done. Within a group, most recent first.
 */
const RANK: Record<ReviewerState, number> = { changes: 0, awaiting: 1, approved: 2, commented: 3, dismissed: 4 };

/**
 * A verdict, or nothing.
 *
 * `PENDING` is a review being drafted — it is not a verdict and GitHub does not
 * show it as one. `COMMENTED` is a verdict of sorts: it says somebody looked.
 * The rule that matters is that a COMMENT does not overwrite an APPROVAL, which
 * is exactly what happens when a reviewer approves and then answers a thread.
 */
function verdictOf(rs: ReviewLike[]): { state: ReviewerState; at: string } | null {
  const said = rs.filter((r) => r.state !== "PENDING")
    .sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
  if (!said.length) return null;
  const strong = [...said].reverse().find((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED");
  const last = said[said.length - 1]!;
  if (!strong) return { state: "commented", at: last.submittedAt };
  return {
    state: strong.state === "APPROVED" ? "approved" : strong.state === "CHANGES_REQUESTED" ? "changes" : "dismissed",
    at: strong.submittedAt,
  };
}

export function reviewerRoster(d: { reviewers?: RequestedLike[]; reviews?: ReviewLike[] }): ReviewerRow[] {
  const asked = d.reviewers ?? [];
  const byPerson = new Map<string, ReviewLike[]>();
  for (const r of d.reviews ?? []) {
    if (!r.author) continue;
    (byPerson.get(r.author) ?? byPerson.set(r.author, []).get(r.author)!).push(r);
  }

  const rows: ReviewerRow[] = [];
  const seen = new Set<string>();
  for (const [login, rs] of byPerson) {
    const v = verdictOf(rs);
    if (!v) continue;                      // a draft review is nobody's verdict
    seen.add(login);
    rows.push({
      login, state: v.state, at: v.at,
      isBot: rs.some((r) => r.isBot),
      // Asked again after answering: the ↻ GitHub draws beside the tick.
      again: asked.some((a) => a.login === login && !a.isTeam),
    });
  }
  for (const a of asked) {
    if (seen.has(a.login)) continue;
    rows.push({ login: a.login, state: "awaiting", isTeam: a.isTeam });
  }

  return rows.sort((x, y) =>
    RANK[x.state] - RANK[y.state]
    || (y.at ?? "").localeCompare(x.at ?? "")
    || x.login.localeCompare(y.login));
}

/** The people blocking a merge, for the sentence that says a merge is blocked.
 *  Naming them is the difference between "somebody asked for changes" and
 *  knowing whose thread to answer. */
export function blockingReviewers(rows: ReviewerRow[]): string[] {
  return rows.filter((r) => r.state === "changes").map((r) => r.login);
}

/**
 * WHAT THE REVIEWERS DECIDED, as one fact.
 *
 * Written after a pull request that had been approved sixteen hours earlier
 * was read as unapproved: "has this PR been approved for me... because in the
 * overview it looks like it has not". It had been. The Overview drew a red "Merging is
 * blocked" over a list of everything standing in the way, and nowhere on the
 * screen did it say a reviewer had said yes.
 *
 * Blocked and approved are different facts and both were true: the reviewer
 * decided, and CI had not caught up. Drawing only the blocking one answers
 * "can I merge" and silently drops "has anybody looked" — which is the question
 * asked first, and the only one a machine cannot answer.
 *
 * ORDER OF PRECEDENCE, and it is not alphabetical. `changes` outranks
 * `approved` because two humans disagreeing is not an approval with a caveat:
 * somebody is waiting for an answer and that is the state of the pull request.
 * Everything else ranks under both, because a comment is not a verdict.
 */
export type ReviewVerdict = {
  kind: "changes" | "approved" | "commented" | "awaiting" | "none";
  /** The people whose verdict this is, newest first. Empty for `none`. */
  who: string[];
  /** At least one of `who` has also been re-requested since — GitHub's ↻. The
   *  verdict still blocks exactly as GitHub shows it; this is the other half
   *  of that same screen. */
  askedAgain?: boolean;
};

/**
 * A BOT'S APPROVAL IS NOT A REVIEW.
 *
 * `claude` sits in the reviewer list with the same tick a person gets, and the
 * rule for this repository is explicit: an auto-review is a gate BEFORE the
 * human one, never a substitute for it. A summary that counted it would report
 * a pull request as approved when nobody had read it — which is the failure
 * this whole function exists to prevent, arrived at from the other side.
 *
 * Bots are still shown in the roster; they are just not a decision.
 */
const humans = (rows: readonly ReviewerRow[]) => rows.filter((r) => !r.isBot && !r.isTeam);

export function reviewVerdict(rows: readonly ReviewerRow[]): ReviewVerdict {
  const people = humans(rows);
  const of = (s: ReviewerState) => people.filter((r) => r.state === s).map((r) => r.login);

  const changes = of("changes");
  if (changes.length) {
    return { kind: "changes", who: changes,
      askedAgain: people.some((r) => r.state === "changes" && r.again) };
  }
  const approved = of("approved");
  if (approved.length) return { kind: "approved", who: approved };
  const commented = of("commented");
  if (commented.length) return { kind: "commented", who: commented };
  const awaiting = of("awaiting");
  if (awaiting.length) return { kind: "awaiting", who: awaiting };
  /* `dismissed` lands here on purpose: a dismissed review is a decision that
     has been taken back, which is the same standing as never having one. */
  return { kind: "none", who: [] };
}

/** The verdict in the words a person would use, naming at most two. */
export function verdictLine(v: ReviewVerdict): string {
  /* Guarded for the same reason `cardVerdict` is: this shape crosses a wire and
     a page can be held open across an install. A view that dies on a missing
     field takes the whole screen with it. */
  const list = Array.isArray(v?.who) ? v.who : [];
  const who = list.slice(0, 2).join(" and ") + (list.length > 2 ? ` +${list.length - 2}` : "");
  switch (v.kind) {
    case "approved": return `Approved by ${who}`;
    case "changes": return v.askedAgain ? `Changes requested by ${who} — asked to look again` : `Changes requested by ${who}`;
    case "commented": return `${who} commented without a verdict`;
    case "awaiting": return `Waiting on ${who}`;
    default: return "No review yet";
  }
}
