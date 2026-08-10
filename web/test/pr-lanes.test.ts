/*
 * Which lane a pull request lands in, and why.
 *
 * The board answers one question — what wants something from me — so the
 * classification IS the design: get it wrong and it is a prettier list in a
 * worse order. What is pinned down here is the ORDER of the rules, because that
 * order is the policy, and every case below is one somebody would notice.
 */
import { describe, expect, it } from "bun:test";
import { fileInLane, board, LANES, LANE_CAP } from "../src/lib/prLanes.ts";
import type { PrSummary, PrCheck } from "../../shared/types.ts";

/*
 * A failing check shaped the way the lanes actually receive one. `state` is
 * lower case because the server normalises GitHub's `FAILURE` into `"failure"`
 * (prs.ts, `checkState`) before any of this ever sees it, so the "FAILURE" that
 * stood here was a value no PrCheckState has and no consumer would have counted
 * as failing. `as unknown as PrCheck` hid that; naming `workflow` — the field
 * the cast was really covering for — makes the cast unnecessary.
 */
const check = (name: string): PrCheck => ({ name, workflow: "CI", state: "failure", done: true });

/** A PrSummary's own fields, plus the four knobs the check rollup is built from. */
type PrOverrides = Partial<PrSummary> & { fail?: number; pend?: number; ok?: number; failing?: string[] };

const pr = (o: PrOverrides = {}): PrSummary => {
  // This destructured `o as never`, which is TS2700 in a clean checkout of the
  // commit — a rest element needs an object type and `never` is not one. The
  // cast bought nothing: PrOverrides is an object type and destructures as is,
  // and losing it is what gives `failing` back its `string[]` for `.map`.
  const { fail = 0, pend = 0, ok = 14, failing = [], ...rest } = o;
  return {
    number: 1, title: "t", author: "someone", state: "OPEN", isDraft: false,
    headRefName: "h", baseRefName: "main", url: "", updatedAt: "", reviewDecision: null,
    additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
    checks: { total: ok + fail + pend, success: ok, failure: fail, skipped: 0, pending: pend,
      allDone: pend === 0, verdict: pend ? null : fail ? "red" : "green",
      failing: failing.map(check) },
    ...rest,
  } as unknown as PrSummary;
};
const MINE = { mine: true, asked: false };
const ASKED = { mine: false, asked: true };
const NEITHER = { mine: false, asked: false };

describe("what is asked of you comes first", () => {
  it("files a review request under review even when the checks are red", () => {
    /*
     * The rule that costs the most to get wrong. A review somebody asked for is
     * the only card on this board that nobody else can do — burying it under a
     * red check would hide the one thing with your name on it. The state is
     * said in the sentence instead of deciding the lane.
     */
    const f = fileInLane(pr({ fail: 2, failing: ["e2e", "unit"] }), ASKED);
    expect(f.lane).toBe("review");
    expect(f.reason).toContain("red");
  });

  it("says when it is a re-request, because that is a different read", () => {
    const f = fileInLane(pr({ reviewDecision: "CHANGES_REQUESTED" }), ASKED);
    expect(f.lane).toBe("review");
    expect(f.reason).toContain("fix, not the first look");
  });

  it("still asks when somebody ELSE has approved it", () => {
    /*
     * This used to file it anywhere but `review`, guarding against "your own
     * approval keeps the card in your face for ever" — a case that cannot
     * happen. `asked` comes from `review-requested:@me`, and GitHub drops a
     * pull request from that search the moment you review it, so `asked`
     * already means your review is outstanding.
     *
     * Reported from the app: the pill said "Needs my review 1" and the board's
     * review lane said "Nothing here. Good."
     */
    const f = fileInLane(pr({ reviewDecision: "APPROVED" }), ASKED);
    expect(f.lane).toBe("review");
    expect(f.reason).toContain("already approved");
    // And it says the useful part: you are not what it is waiting on.
    expect(f.reason).toContain("can land whenever you like");
  });
});

describe("ready to land", () => {
  it("is approved, green, and nothing running", () => {
    const f = fileInLane(pr({ reviewDecision: "APPROVED" }), MINE);
    expect(f.lane).toBe("land");
    expect(f.reason).toContain("Nobody has pressed merge");
  });

  it("is NOT ready while something is still running", () => {
    // The case that shipped as a bug in the panel this week: an empty or
    // pending rollup is not a green one.
    expect(fileInLane(pr({ reviewDecision: "APPROVED", pend: 3 }), MINE).lane).toBe("flight");
  });

  it("is NOT ready when nothing has reported at all", () => {
    expect(fileInLane(pr({ reviewDecision: "APPROVED", ok: 0 }), MINE).lane).not.toBe("land");
  });
});

describe("blocked, and whose problem it is", () => {
  it("names what is failing rather than counting it", () => {
    const f = fileInLane(pr({ fail: 2, failing: ["django-tests", "typecheck"] }), MINE);
    expect(f.lane).toBe("blocked");
    expect(f.reason).toContain("django-tests");
  });

  it("counts the rest past two names", () => {
    const f = fileInLane(pr({ fail: 4, failing: ["a", "b", "c", "d"] }), MINE);
    expect(f.reason).toContain("+2 more");
  });

  it("is somebody else's when it is not yours", () => {
    // Reviewing a red pull request you were not asked about is wasted work,
    // and the lane says so rather than putting it in front of you.
    const f = fileInLane(pr({ fail: 1, failing: ["x"] }), NEITHER);
    expect(f.lane).toBe("others");
    expect(f.reason).toContain("wasted work");
  });
});

describe("a draft is nobody's job", () => {
  it("goes to your own lane, not to review, however many it names", () => {
    // GitHub lets you request review on a draft and almost nobody means it.
    expect(fileInLane(pr({ isDraft: true }), ASKED).lane).toBe("others");
    expect(fileInLane(pr({ isDraft: true }), MINE).lane).toBe("flight");
  });
});

describe("waiting", () => {
  it("puts your own running suite in your lane with the count", () => {
    const f = fileInLane(pr({ pend: 8, ok: 6 }), MINE);
    expect(f.lane).toBe("flight");
    expect(f.reason).toContain("6 of 14");
  });

  it("puts changes-requested with whoever owes the work", () => {
    expect(fileInLane(pr({ reviewDecision: "CHANGES_REQUESTED" }), MINE).reason).toContain("ball is with you");
    expect(fileInLane(pr({ reviewDecision: "CHANGES_REQUESTED" }), NEITHER).reason).toContain("with the author");
  });
});

describe("the board", () => {
  it("keeps every lane, including the empty ones", () => {
    const b = board([pr({ number: 1 })], () => MINE);
    expect([...b.keys()]).toEqual(LANES.map((l) => l.id));
  });

  it("files every pull request exactly once", () => {
    const list = [pr({ number: 1, reviewDecision: "APPROVED" }), pr({ number: 2, fail: 1, failing: ["x"] }), pr({ number: 3, isDraft: true })];
    const b = board(list, () => MINE);
    expect([...b.values()].flat()).toHaveLength(3);
  });

  it("carries the sentence with the card, so the two cannot disagree", () => {
    const b = board([pr({ number: 7, reviewDecision: "APPROVED" })], () => MINE);
    expect(b.get("land")![0]!.filed.reason).toContain("merge");
  });

describe("a conflict is not a green pull request", () => {
  /*
   * The lane called itself "red checks or conflicts" from the day it was
   * written and only ever tested the checks. Reported from a board showing
   * "Open, green, and nobody has been asked to look yet" beside GitHub's own
   * "Merging is blocked — 1 file conflict with main".
   */
  it("files a conflicting pull request of yours under blocked, however green", () => {
    const { lane, reason } = fileInLane(pr({ mergeable: "CONFLICTING" }), MINE);
    expect(lane).toBe("blocked");
    expect(reason).toContain("Conflicts");
  });

  it("never calls a conflicting one ready to land, even approved and green", () => {
    // The worst case, because that lane's promise is that a press is all that
    // is missing — and the press fails.
    const { lane } = fileInLane(pr({ reviewDecision: "APPROVED", mergeable: "CONFLICTING" }), MINE);
    expect(lane).not.toBe("land");
  });

  it("keeps a review that was asked of you, and says it conflicts", () => {
    // Still yours to read; a reviewer who does not know would approve
    // something that cannot land.
    const { lane, reason } = fileInLane(pr({ mergeable: "CONFLICTING" }), ASKED);
    expect(lane).toBe("review");
    expect(reason).toContain("conflicts");
  });

  it("files somebody else's conflicting one where it is not your problem", () => {
    expect(fileInLane(pr({ mergeable: "CONFLICTING" }), NEITHER).lane).toBe("others");
  });

  it("does NOT treat UNKNOWN as a conflict", () => {
    // GitHub answers UNKNOWN while it is still working the merge out. Calling
    // that blocked would flash every fresh pull request through the red lane.
    expect(fileInLane(pr({ mergeable: "UNKNOWN" }), MINE).lane).toBe("flight");
  });
});

  it("caps a lane at something that fits on a screen", () => {
    // Forty cards in a column is a scroll inside a scroll — worse than the flat
    // list the board replaced.
    expect(LANE_CAP).toBeLessThanOrEqual(8);
  });
});
