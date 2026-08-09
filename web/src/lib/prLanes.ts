// Which lane a pull request belongs in, and why.
//
// The board answers one question — what wants something from me — and a lane is
// the answer for one pull request. The classification is here, on its own,
// because it is the whole design: get it wrong and the board is a prettier list
// with the rows in a worse order.
//
// Two rules shape everything below.
//
// A pull request is filed by WHAT IT NEEDS, not by what it is. "Approved and
// green" is not a state, it is a job — press merge. "Red checks" is not a state
// either, it is "reviewing this is wasted work until it moves". So the lanes
// are verbs, and the order they are tested in is the order of what would stop
// you: something in your way before something in somebody else's.
//
// And every card carries the sentence that put it there. A board that sorts
// without saying why is a board you have to re-derive every morning; the
// sentence is the difference between "this is in Blocked" and "this is blocked
// because the same two checks have failed three runs running, so it is not
// flake". That sentence is built here too, from the same facts the lane was
// decided on, so the two can never disagree.

import type { PrSummary } from "../../../shared/types.ts";

export type LaneId = "review" | "land" | "blocked" | "others" | "flight";

export interface Lane {
  id: LaneId;
  /** What the column is called. */
  label: string;
  /** Why this lane exists, said once at the top of it. */
  why: string;
  /** Which CSS variable tints it. */
  tint: string;
}

export const LANES: Lane[] = [
  { id: "review", label: "Needs your review", tint: "var(--warning)",
    why: "Somebody asked you by name, and nobody else can unblock it." },
  { id: "land", label: "Green, ready to land", tint: "var(--success)",
    why: "Approved, green, no conflicts. Only a human press is missing." },
  { id: "blocked", label: "Blocked", tint: "var(--error)",
    why: "Red checks or conflicts. Reviewing these is wasted work until they move." },
  { id: "others", label: "Waiting on someone else", tint: "var(--info)",
    why: "Not yours to move. The only useful action is a poke." },
  { id: "flight", label: "Yours, in flight", tint: "var(--primary)",
    why: "Open by you and still moving. Nothing is owed by you right now." },
];

/**
 * What this viewer's stake in a pull request is.
 *
 * Taken from WHICH LIST the pull request arrived in, not looked up per card,
 * and that is a cache decision rather than a shortcut. `viewerRequested` lives
 * on PrDetail and not on PrSummary, so asking it per row would be one request
 * per card on a board of twenty — behind a view whose whole promise is a
 * glance. The server already answers both questions in bulk: the `mine` scope
 * and the `review` scope are two list calls the panel makes anyway to fill the
 * tab counts, and membership in them IS the stake.
 *
 * So the board costs the same two calls the pill row already cost. Nothing new
 * is polled, nothing is fetched per card, and the numbers on screen can never
 * disagree with the lists they came from.
 */
export interface Stake {
  /** You opened it — it came back in the `mine` scope. */
  mine: boolean;
  /** You, or a team you are in, was asked — it came back in the `review` scope. */
  asked: boolean;
}

/**
 * Build the stake reader from the two lists the panel already has.
 *
 * Numbers rather than objects, because the same pull request arrives as two
 * different objects in the two lists and identity would quietly fail.
 */
export function stakeFrom(mine: { number: number }[], review: { number: number }[]) {
  const m = new Set(mine.map((p) => p.number));
  const r = new Set(review.map((p) => p.number));
  return (p: { number: number }): Stake => ({ mine: m.has(p.number), asked: r.has(p.number) });
}

export interface Filed {
  lane: LaneId;
  /** The sentence, already written. Plain text — the caller decides what to
   *  emphasise, and a classifier that returned markup would be deciding how it
   *  looks from where it cannot see. */
  reason: string;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * File it.
 *
 * The order of the tests IS the policy, so it is written as a straight sequence
 * rather than a table: read top to bottom and you have read the rules.
 */
export function fileInLane(p: PrSummary, stake: Stake): Filed {
  const c = p.checks;
  const red = c.failure > 0;
  const running = c.pending > 0;
  const approved = p.reviewDecision === "APPROVED";
  const changesAsked = p.reviewDecision === "CHANGES_REQUESTED";

  /*
   * A draft is nobody's job, including yours. It goes to your own lane rather
   * than to review, however many people it names — asking for a review on a
   * draft is a thing GitHub lets you do and almost nobody means.
   */
  if (p.isDraft) {
    return { lane: stake.mine ? "flight" : "others",
      reason: "Still a draft. Nobody is waiting on it, including you." };
  }

  /*
   * Asked of you, first of all. Even red, even conflicted: a review that was
   * asked for is the one thing on this board that nobody else can do, and
   * burying it under a failing check would hide the only card with your name on
   * it. The state is said in the sentence instead.
   */
  if (stake.asked && !approved) {
    if (red) {
      return { lane: "review",
        reason: `Asked of you — and ${plural(c.failure, "check")} ${c.failure === 1 ? "is" : "are"} red, so read it knowing the author still has work.` };
    }
    if (p.mergeable === "CONFLICTING") {
      // Still yours to read — a review that was asked for is the one thing
      // nobody else can do — but said, because a reviewer who does not know it
      // conflicts will approve something that cannot land.
      return { lane: "review",
        reason: "Asked of you — and it conflicts with the base branch, so it cannot land as it stands." };
    }
    return { lane: "review",
      reason: changesAsked
        ? "You asked for changes and were re-requested — this is the fix, not the first look."
        : "Asked of you. Nobody else can unblock it." };
  }

  /*
   * A conflict, before anything green is said about it.
   *
   * The lane below has always CALLED itself "red checks or conflicts" and never
   * tested the second half: `fileInLane` read the checks and the review and
   * nothing else. So a pull request with every check green and a file
   * conflicting with main was filed as "Open, green, and nobody has been asked
   * to look yet" — reported from a board showing exactly that beside GitHub's
   * own "Merging is blocked". Worse, it could reach "Green, ready to land",
   * whose whole promise is that the only thing missing is a press; pressing it
   * fails.
   *
   * Checks and mergeability are two different facts and the board was reading
   * one of them. `UNKNOWN` is deliberately not treated as a conflict: GitHub
   * answers it while it is still working the merge out, and calling that
   * blocked would flash every fresh pull request through the red lane.
   */
  if (p.mergeable === "CONFLICTING") {
    return { lane: stake.mine ? "blocked" : "others",
      reason: stake.mine
        ? "Conflicts with the base branch — nothing else can move until they are resolved."
        : "Conflicts with the base branch. Reviewing it is wasted work until the author rebases." };
  }

  /*
   * Ready to land. Approved, nothing red, nothing running, no conflict — the
   * only thing missing is somebody pressing a button, which is exactly the case
   * a list buries and a board should shout about.
   */
  if (approved && !red && !running && p.checks.total > 0) {
    return { lane: "land",
      reason: stake.mine
        ? "Approved and green. Nobody has pressed merge — including you."
        : "Approved and green. Waiting on a press, and you can do it." };
  }

  /*
   * Blocked: something has to change before anybody can move. Red beats
   * running, because red is a fact and running is a wait.
   */
  if (red) {
    const names = c.failing.slice(0, 2).map((f) => f.name).join(", ");
    const rest = c.failing.length > 2 ? ` +${c.failing.length - 2} more` : "";
    return { lane: stake.mine ? "blocked" : "others",
      reason: names
        ? `${names}${rest} failing${stake.mine ? " — yours to fix" : ", so reviewing it is wasted work until it moves"}.`
        : `${plural(c.failure, "check")} failing.` };
  }

  if (changesAsked) {
    return { lane: stake.mine ? "flight" : "others",
      reason: stake.mine
        ? "Changes were asked for. The ball is with you."
        : "Changes were asked for. The ball is with the author, not you." };
  }

  /*
   * Still running is not blocked and not ready — it is a wait, and the honest
   * place for a wait of yours is your own lane with the count on it.
   */
  if (running) {
    return { lane: stake.mine ? "flight" : "others",
      reason: `${c.success} of ${c.total} checks in, nothing red yet.` };
  }

  if (stake.mine) {
    return { lane: "flight",
      reason: p.reviewers?.length
        ? `Waiting on ${p.reviewers.slice(0, 2).map((r) => r.login).join(", ")}.`
        : "Open, green, and nobody has been asked to look yet." };
  }

  return { lane: "others", reason: "Nothing for you to do — here so it is not invisible." };
}

/** The whole board, in lane order, from a list and a way to read your stake. */
export function board(prs: PrSummary[], stakeOf: (p: PrSummary) => Stake): Map<LaneId, (PrSummary & { filed: Filed })[]> {
  const out = new Map<LaneId, (PrSummary & { filed: Filed })[]>();
  for (const l of LANES) out.set(l.id, []);
  for (const p of prs) {
    const filed = fileInLane(p, stakeOf(p));
    out.get(filed.lane)!.push({ ...p, filed });
  }
  return out;
}

/**
 * How many a lane may draw.
 *
 * A lane is allowed to be forty on a bad week, and forty cards in a column is a
 * scroll inside a scroll — worse than the flat list the board replaced. Six
 * keeps every lane on one screen at the sizes this app runs at; the rest are
 * counted, not hidden, and the table is one click away.
 */
export const LANE_CAP = 6;

/* ------------------------------------------------------------------ acting */

/**
 * The one thing this card is asking you to do.
 *
 * A lane says what a pull request needs; this says what the button should be.
 * They are separate on purpose — the lane is a fact about the pull request, the
 * action is a fact about what THIS app can perform, and conflating them is how
 * you end up with a button that opens a dialog to say it cannot.
 *
 * Only actions the panel really has. There is no "nudge" here, however well it
 * would read on a card: agentglass cannot poke somebody on GitHub, and a button
 * that looks like it can is worse than a row with no button at all.
 */
export type Suggested = "open" | "merge" | "rerun";

export function suggestedAction(p: PrSummary, filed: Filed): Suggested {
  if (filed.lane === "land") return "merge";
  // Yours and red: the useful press is the one that finds out whether it is
  // flake, and it is the only one of these that does not need a human read.
  if (filed.lane === "blocked" && p.checks.failure > 0) return "rerun";
  /*
   * No "update branch" here, and its absence is the point: how far behind a
   * branch is does not travel on PrSummary — the panel asks for it separately,
   * per pull request, which is exactly the request-per-card this board refuses
   * to make. So the board offers what it can know, and the detail offers the
   * rest.
   */
  return "open";
}

export const ACTION_LABEL: Record<Suggested, string> = {
  open: "Review",
  merge: "Merge",
  rerun: "Re-run failed",
};
