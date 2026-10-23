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

import type { FailureHint } from "./prFailureHint.ts";
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
  /**
   * Drawn only when it holds something.
   *
   * An empty lane is usually the most valuable thing on this board — "Needs
   * your review · Nothing here. Good." is the answer somebody came for. That
   * only holds where the zero is news. `others` can only ever be fed by the two
   * lists the board is given, yours and the ones you were asked to look at, so
   * for it to have a card at all somebody must have asked you to review a draft
   * or something conflicting. Reported after weeks of use: the "waiting on
   * someone else" count was zero and no card had ever been in it. A column that is always empty is
   * a column that teaches you to skip a fifth of the screen.
   */
  hideWhenEmpty?: boolean;
}

export const LANES: Lane[] = [
  { id: "review", label: "Needs your review", tint: "var(--warning)",
    why: "Somebody asked you by name, and nobody else can unblock it." },
  { id: "land", label: "Green, ready to land", tint: "var(--success)",
    why: "Approved, green, no conflicts. Only a human press is missing." },
  { id: "blocked", label: "Blocked", tint: "var(--error)",
    why: "Red checks or conflicts. Reviewing these is wasted work until they move." },
  { id: "others", label: "Waiting on someone else", tint: "var(--info)",
    why: "Not yours to move. The only useful action is a poke.", hideWhenEmpty: true },
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
  /** The failing test, when the app has read one for this card: the board draws it under the sentence. */
  test?: { title: string; more: number };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * File it.
 *
 * The order of the tests IS the policy, so it is written as a straight sequence
 * rather than a table: read top to bottom and you have read the rules.
 */
export function fileInLane(p: PrSummary, stake: Stake, hint?: FailureHint | null): Filed {
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
   *
   * Even APPROVED. This used to read `stake.asked && !approved`, guarding
   * against "your own approval keeps the card in your face for ever" — a case
   * that cannot happen: `asked` comes from `review-requested:@me`, and GitHub
   * drops a pull request from that search the moment you review it. So `asked`
   * already means "your review is still outstanding", and the guard only ever
   * fired when somebody ELSE had approved.
   *
   * Seen in the app exactly that way: the pill said "Needs my review 1"
   * and the board's own review lane said "Nothing here. Good." One screen, one
   * fact, two answers — which is worse than either answer alone.
   */
  if (stake.asked) {
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
    if (approved) {
      // Said plainly, because it changes what you do with it: read it if you
      // want to, or press merge — you are not the thing standing in its way.
      return { lane: "review",
        reason: !red && !running && p.checks.total > 0
          ? "Asked of you — and somebody else has already approved it, so it is green and can land whenever you like."
          : "Asked of you — somebody else has already approved it, so your review is not what it is waiting on." };
    }
    return { lane: "review",
      reason: changesAsked
        ? "You asked for changes and were re-requested — this is the fix, not the first look."
        : "Asked of you. Nobody else can unblock it." };
  }

  /*
   * The checks have not come back yet, and that is not the same as none.
   *
   * The list arrives in two passes on purpose — the rows in 1.5s, the check
   * rollups four seconds behind them — so for a moment every pull request has
   * an empty rollup. Read as fact, that empty rollup says "no checks", and the
   * board filed a whole repository under "Open, green, and nobody has been
   * asked to look yet". Reported exactly that way: every card in the wrong lane
   * after a restart, correct after pressing Refresh.
   *
   * Said as a wait instead. `checksLoaded === false` is the server telling us
   * the second pass is still out; `undefined` is a caller that never had two
   * passes, and is left alone.
   */
  if (p.checksLoaded === false) {
    return { lane: stake.mine ? "flight" : "others",
      reason: "Still reading its checks — this card is not finished loading." };
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
   * A required check that never reported is a wall too, and the list cannot
   * see it: GitHub's rollup only holds the checks that exist, so a required job
   * a path filter skipped is absent from it and the suite reads green. The
   * detail's merge box knows (it asks which checks the base requires) and
   * hands it to the row as `requiredMissing`; until the card has been opened
   * once it can only say what the list says.
   */
  if (p.requiredMissing) {
    return { lane: stake.mine ? "blocked" : "others",
      reason: stake.mine
        ? "A required check never reported — GitHub will not merge until it does."
        : "A required check never reported, so it cannot land yet." };
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
   * Still running beats red, and that is a correction — for a failure that may
   * be on its way out, not for one that is going to stay.
   *
   * Measured against GitHub on a pull request whose failing check had just been
   * re-run: their aggregate answers `FAILURE: 1` and `IN_PROGRESS: 2`, because
   * the run that failed is still counted alongside the one replacing it.
   * github.com does not show it that way — it keeps the latest run per check
   * name and says "Some checks haven't completed yet" — and neither should we.
   * A card sat in Blocked reading "2 checks failing" over a suite that was
   * green and busy, and no amount of pressing Refresh could move it, because
   * the number was real and its meaning was not.
   *
   * So a suite with anything still in flight is a wait while the failure it is
   * carrying might be the attempt being replaced. That is knowable only when
   * the failures are NAMED: `failing` is filled from the latest run per name
   * (the board swaps the list's aggregate for that read on a card that claims
   * red), so a name in it has no run of the same name in flight — the run that
   * would have replaced it is not there. The list's own aggregate has no names,
   * `failing` is empty, and that is the only case left that is still a guess.
   *
   * The other way round was measured too: a pull request whose roll-up job,
   * REQUIRED, had failed in three seconds, with one other job still running and
   * fifty-six passed, sat in "in flight" with no red anywhere while its own
   * detail said "Merging is blocked". Waiting on a suite does not unblock a
   * check that has already failed and is not coming back.
   */
  const standing = red && c.failing.length > 0;
  if (running && !standing) {
    return { lane: stake.mine ? "flight" : "others",
      reason: red
        ? `${c.success} of ${c.total} checks in — ${plural(c.failure, "failure")} so far, which a re-run may be replacing.`
        : `${c.success} of ${c.total} checks in, nothing red yet.` };
  }

  /*
   * Blocked: something has to change before anybody can move.
   */
  if (red) {
    const names = c.failing.slice(0, 2).map((f) => f.name).join(", ");
    const rest = c.failing.length > 2 ? ` +${c.failing.length - 2} more` : "";
    const test = hint ? { title: hint.title, more: hint.more } : undefined;
    /* "Not yours" only on a fact the app read: every failing test is red on
       another pull request (or on main). Nothing read, nothing claimed. */
    const own = hint?.ownership;
    const elsewhere = own?.notYours ? (own.main ? "red on main" : `red on ${plural(own.prs, "other PR")}`) : null;
    /* Said, because the card must not read as finished when it is not: the
       failure stands, and the rest of the suite is still going. */
    const busy = running ? `, and ${plural(c.pending, "other check")} still running` : "";
    return { lane: stake.mine ? "blocked" : "others", test,
      reason: names
        ? `${names}${rest} failing${stake.mine ? (elsewhere ? ` — ${elsewhere}, not yours` : " — yours to fix") : ", so reviewing it is wasted work until it moves"}${busy}.`
        : `${plural(c.failure, "check")} failing${busy}.` };
  }

  if (changesAsked) {
    /*
     * A re-request moves the ball back, and the sentence has to say so.
     *
     * Applying the review and pressing "Re-request review" left this reading
     * exactly as it had before either happened — "the ball is with you" over
     * a pull request where it plainly was not, the second the author had
     * already done both things. `askedAgain` comes from the same
     * `reviewRequests` GitHub's own ↻ reads.
     */
    const again = p.humanReview?.askedAgain;
    /* CLEARED: every changes-requester has been re-asked, so this reads the
       same amber fact the card header and the merge box now both draw —
       waiting on THEIR review, not still-blocked. Matched in wording so the
       header strip and the line under it do not disagree. */
    const cleared = p.humanReview?.cleared;
    return { lane: stake.mine ? "flight" : "others",
      reason: stake.mine
        ? (cleared ? "Changes applied, and you've asked them to look again — waiting on their review now."
          : again ? "Changes were asked for, and you've asked them to look again — the ball is with them now."
          : "Changes were asked for. The ball is with you.")
        : (cleared ? "Changes applied, and the author has asked for another look — waiting on the reviewer now."
          : again ? "Changes were asked for, and the author has asked for another look."
          : "Changes were asked for. The ball is with the author, not you.") };
  }

  if (stake.mine) {
    return { lane: "flight",
      reason: p.reviewers?.length
        ? `Waiting on ${p.reviewers.slice(0, 2).map((r) => r.login).join(", ")}.`
        : "Open, green, and nobody has been asked to look yet." };
  }

  return { lane: "others", reason: "Nothing for you to do — here so it is not invisible." };
}

/**
 * Another person's point of view.
 *
 * The filing above is written from the owner's chair — "Asked of you", "yours to
 * fix" — and the policy under it is not about the owner at all: a stake is two
 * booleans, and whose they are is the caller's business. So a person's board
 * files with the same rules and only the WORDS are re-voiced, here, in one
 * table. `viewer` absent is the owner's own board, and nothing below touches it.
 *
 * The ceiling: the table covers the sentences `fileInLane` writes today, and
 * pr-lanes.test.ts files every shape of card and fails if a second-person word
 * is left in one, so a new sentence cannot slip through unvoiced.
 */
export function voice(text: string, viewer?: string): string {
  if (!viewer) return text;
  const v = viewer;
  return text
    .replace(/\bYou asked for changes\b/g, `${v} asked for changes`)
    .replace(/\bwere re-requested\b/g, "was re-requested")
    .replace(/\byou've asked them\b/g, `${v} has asked them`)
    .replace(/\bnot yours\b/g, `not ${v}'s`)
    .replace(/\byours to fix\b/g, `${v}'s to fix`)
    .replace(/\bwhenever you like\b/g, `whenever ${v} likes`)
    .replace(/\band you can do it\b/g, `and ${v} can do it`)
    .replace(/\bso your review\b/g, `so ${v}'s review`)
    .replace(/\b(Asked of|including|not|ball is with|for) you\b/g, `$1 ${v}`);
}

/**
 * The lanes as a person's board words them; the owner's are `LANES` itself.
 *
 * A person's board has the four the owner's has, never "Waiting on someone
 * else": that lane is the owner's own "not yours to move", and on somebody
 * else's board it would be a fifth kind of thing to read. The only cards that
 * ever reach it are drafts the person was asked to review, and `board` files
 * those under the review lane, draft sentence intact.
 */
export function lanesFor(viewer?: string): Lane[] {
  if (!viewer) return LANES;
  return LANES.filter((l) => l.id !== "others").map((l) => ({
    ...l,
    label: l.id === "review" ? `Needs ${viewer}'s review` : l.label === "Yours, in flight" ? `${viewer}'s, in flight` : l.label,
    why: l.id === "review" ? `Somebody asked ${viewer} by name, and nobody else can unblock it.`
      : l.id === "others" ? `Not ${viewer}'s to move. The only useful action is a poke.`
      : l.id === "flight" ? `Open by ${viewer} and still moving. Nothing is owed by ${viewer} right now.`
      : l.why,
  }));
}

/** The whole board, in lane order, from a list and a way to read your stake. */
export function board(prs: PrSummary[], stakeOf: (p: PrSummary) => Stake, hintOf?: (p: PrSummary) => FailureHint | null, viewer?: string): Map<LaneId, (PrSummary & { filed: Filed })[]> {
  const out = new Map<LaneId, (PrSummary & { filed: Filed })[]>();
  for (const l of LANES) out.set(l.id, []);
  for (const p of prs) {
    const f = fileInLane(p, stakeOf(p), hintOf?.(p));
    const filed = viewer ? { ...f, reason: voice(f.reason, viewer), lane: f.lane === "others" ? "review" as const : f.lane } : f;
    out.get(filed.lane)!.push({ ...p, filed });
  }
  return out;
}

/**
 * How many a lane may draw.
 *
 * A lane is allowed to be forty on a bad week, and forty cards in a column is a
 * scroll inside a scroll — worse than the flat list the board replaced. The
 * rest are counted, not hidden, and the table is one click away.
 *
 * Six was that argument taken too far. On a real board the green lane held
 * thirteen, so the button appeared with SEVEN left over — and pressing a button to see seven more cards
 * on a screen with room for them is a click that buys nothing. Twenty is where
 * a column stops fitting and starts being a list; below that the fold costs
 * more than it saves.
 */
export const LANE_CAP = 20;

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
  /*
   * A review asked of you on something already approved and green: the press
   * that moves it is Merge, not Review. It sits in the review lane because your
   * name is on it — see `fileInLane` — but offering "Review" on a pull request
   * whose only missing step is a button would be the board answering a question
   * nobody asked.
   */
  /* `humanReview`, not `reviewDecision`: GitHub counts the auto-review bot, so
     this offered "merge" on a pull request no person had read. And never on a
     stale approval — the reviewer approved a different commit. */
  if (filed.lane === "review" && p.humanReview?.kind === "approved" && !p.humanReview.stale
    && p.checks.failure === 0 && p.checks.pending === 0 && p.checks.total > 0
    && p.mergeable !== "CONFLICTING") return "merge";
  /* A conflict is the one thing that has to move first: no amount of reviewing
     or re-running gets past it, and the button that says so is the useful one. */
  if (p.mergeable === "CONFLICTING") return "open";
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

/**
 * The views on the panel's pill row, as filters over the board.
 *
 * Each one is a question about the cards already in hand, so none of them
 * costs a request. `review` is the viewer's stake, read the same
 * way the lanes read it (there is no "mine" pill: the board is already only
 * what they opened and what they were asked for); `failing` and `ready` are the two lanes named for
 * what is wrong and what can land. The stake is judged AFTER filing, which is
 * the point: a pull request that is yours and asked of you keeps the lane it
 * would have everywhere else instead of moving when a pill is pressed.
 * Every view is a filter over the viewer's two queues, and the default one
 * (no pill) is those queues whole: what wants something from them. Somebody
 * else's pull request reaches the board only through a search.
 */
export type BoardView = "all" | "review" | "failing" | "ready";

/**
 * Whether a view reaches past the viewer's own two queues, to the repository.
 *
 * None does. The default board once took in a page of the repository, which put
 * other people's pull requests under "Waiting on someone else" and a "Load
 * more" under the board. The question stays a function so a board for another
 * person can say yes without the callers changing; "failing" and "ready" are
 * stake-only until a view needs a page of the repository badly enough to pay
 * for its request.
 */
export function viewIsWide(_view: BoardView): boolean {
  return false;
}

/**
 * `p` is read only by `failing`: somebody else's red pull request files under
 * "others" (not yours to move), which is not "blocked", yet it is exactly what
 * the old `checks:red` search listed.
 */
export function viewKeeps(view: BoardView, lane: LaneId, stake: Stake, p?: { checks?: { failure?: number }; mergeable?: string }): boolean {
  switch (view) {
    case "review": return stake.asked;
    case "failing": return lane === "blocked" || (p?.checks?.failure ?? 0) > 0 || p?.mergeable === "CONFLICTING";
    case "ready": return lane === "land";
    default: return true;
  }
}
