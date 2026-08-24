/*
 * Why merging is blocked, said from what is actually true.
 *
 * Reported with a screenshot of our own panel: "Merging is blocked — A check is
 * failing", above a line reading "46 checks passed, no conflicts with master",
 * while GitHub said "Some checks haven't completed yet" and our own Checks tab
 * said "2 still running · 0 failing". Nothing was failing. Two were running.
 *
 * The cause is that GitHub's mergeable state is coarser than the sentence a
 * person needs — `UNSTABLE` means failing OR pending — and it was being
 * translated to "failing" unconditionally. Contradicting yourself inside one
 * box is worse than saying nothing, because the half that says "failing" is the
 * half that sends you to the browser.
 */
import { describe, expect, it } from "bun:test";
import { mergeBlockedWhy, checksLine, checksStanding, standingLine, mergeVerdict } from "../../shared/mergeReason.ts";
import type { PrCheckRollup, PrCheck } from "../../shared/types.ts";

const check = (name: string): PrCheck =>
  ({ name, state: "FAILURE", done: true } as unknown as PrCheck);

const rollup = (p: Partial<PrCheckRollup>): PrCheckRollup => ({
  total: 0, success: 0, failure: 0, skipped: 0, pending: 0,
  allDone: true, verdict: null, failing: [], ...p,
});

describe("what it says under 'Merging is blocked'", () => {
  it("says checks are RUNNING when nothing is red — the reported case", () => {
    // 46 green, 2 going, 0 failing. This exact shape said "A check is failing".
    const why = mergeBlockedWhy("UNSTABLE", rollup({ total: 48, success: 35, skipped: 11, pending: 2 }));
    expect(why).toContain("still running");
    expect(why).not.toContain("failing check");
    // And it says so out loud, because "still running" alone still reads as
    // "something might be wrong".
    expect(why).toContain("nothing has failed");
  });

  it("names what is failing when something is", () => {
    const why = mergeBlockedWhy("UNSTABLE", rollup({ total: 3, failure: 1, failing: [check("django-tests")] }));
    // A count alone is what sends people to the browser.
    expect(why).toContain("django-tests");
    expect(why).toContain("failing");
  });

  it("names two and counts the rest", () => {
    const why = mergeBlockedWhy("UNSTABLE", rollup({
      total: 9, failure: 4,
      failing: [check("a"), check("b"), check("c"), check("d")],
    }));
    expect(why).toBe("a, b +2 more failing");
  });

  it("prefers the red one over the running ones", () => {
    // Something red is the reason whatever else is true.
    const why = mergeBlockedWhy("UNSTABLE", rollup({ total: 5, failure: 1, pending: 3, failing: [check("x")] }));
    expect(why).toContain("x");
    expect(why).not.toContain("still running");
  });

  it("lets the branch's own problems win over the checks", () => {
    /*
     * A conflicted pull request whose checks are still running is blocked by
     * the conflict. "Checks are still running" would be true and useless.
     */
    const running = rollup({ total: 5, pending: 5 });
    expect(mergeBlockedWhy("DIRTY", running)).toContain("conflicts");
    expect(mergeBlockedWhy("BEHIND", running)).toContain("base branch has moved");
    expect(mergeBlockedWhy("DRAFT", running)).toContain("draft");
  });

  it("falls back to GitHub's sentence when the checks cannot say more", () => {
    expect(mergeBlockedWhy("BLOCKED", rollup({ total: 3, success: 3 }))).toContain("required review");
    expect(mergeBlockedWhy("UNKNOWN", null)).toContain("not finished");
    expect(mergeBlockedWhy("SOMETHING_NEW", null)).toBe("Not mergeable");
  });
});

describe("the line about the checks", () => {
  it("does NOT claim they all passed while some are running", () => {
    // The half of the contradiction that lived below the header.
    const line = checksLine(rollup({ total: 48, success: 35, skipped: 11, pending: 2 }), "master")!;
    expect(line).toContain("2 checks still running");
    expect(line).not.toMatch(/^48 checks passed/);
  });

  it("says they passed when they have", () => {
    expect(checksLine(rollup({ total: 46, success: 46 }), "master")).toBe("46 checks passed, no conflicts with master");
  });

  it("says nothing when something is red — the line above already named it", () => {
    expect(checksLine(rollup({ total: 3, failure: 1, failing: [check("x")] }))).toBeNull();
  });

  it("says nothing when there are no checks at all", () => {
    expect(checksLine(rollup({}))).toBeNull();
    expect(checksLine(null)).toBeNull();
  });

  it("leaves the conflict clause out when there is a conflict", () => {
    expect(checksLine(rollup({ total: 2, success: 2 }))).toBe("2 checks passed");
  });

  it("counts one check as one, not as 1 checks", () => {
    expect(checksLine(rollup({ total: 1, success: 1 }))).toBe("1 check passed");
  });
});

describe("an empty list of checks", () => {
  /*
   * The reported bug. Press "Update branch", the push starts CI, and for the
   * seconds between the push landing and the first run being created the rollup
   * is empty — which looked exactly like a green one. Ours said "Ready to merge
   * — nothing is standing in the way" while GitHub said "3 in progress".
   */
  it("is 'waiting' when we just pushed to the branch", () => {
    expect(checksStanding(rollup({}), true)).toBe("awaiting");
    expect(standingLine("awaiting")).toContain("waiting for the checks to start");
  });

  it("is 'none reported' otherwise — calm, because a repo with no CI is fine", () => {
    expect(checksStanding(rollup({}), false)).toBe("none-reported");
    const line = standingLine("none-reported", "master")!;
    expect(line).toContain("No checks have reported");
    // What it must never say on the strength of an empty list.
    expect(line).not.toContain("Nothing is standing in the way");
  });

  it("is never green on an empty list, whichever way you ask", () => {
    expect(checksStanding(rollup({}), true)).not.toBe("green");
    expect(checksStanding(rollup({}), false)).not.toBe("green");
    expect(checksStanding(null, false)).not.toBe("green");
  });

  it("is green only when every one of them has passed", () => {
    expect(checksStanding(rollup({ total: 46, success: 46 }))).toBe("green");
    expect(standingLine("green")).toBeNull();
  });

  it("is mixed while any is running or red, even if we were not waiting", () => {
    expect(checksStanding(rollup({ total: 3, success: 1, pending: 2 }))).toBe("mixed");
    expect(checksStanding(rollup({ total: 3, success: 2, failure: 1 }))).toBe("mixed");
  });
});

/*
 * One ladder, because two of them had already disagreed.
 *
 * Overview and the file rail each carried their own five-rung version. The
 * rail's own comment said a short version reaching a different verdict from the
 * long one "is not short, it is a second opinion", and the dead-code audit
 * measured them being exactly that on two of three cases: with a CLEAN pull
 * request whose checks were still running, Overview said "Nothing is blocking
 * it" with an empty subtitle and the rail said "Waiting for the checks", one
 * tab apart.
 */
describe("mergeVerdict, the one ladder", () => {
  const roll = (o: object) => ({ total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: false, verdict: "none", failing: [], ...o } as never);

  it("green and clean is ready", () => {
    expect(mergeVerdict("CLEAN", roll({ total: 3, success: 3, allDone: true, verdict: "green" })))
      .toEqual({ line: "Ready to merge", blocked: false });
  });

  it("clean with checks running waits — the case the two disagreed on", () => {
    expect(mergeVerdict("CLEAN", roll({ total: 3, pending: 3 })))
      .toEqual({ line: "Waiting for the checks", blocked: false });
  });

  it("clean and red says GitHub is not requiring them, and is not blocked", () => {
    // Not a contradiction: it is the difference between a button you should not
    // press and one you can.
    const v = mergeVerdict("CLEAN", roll({ total: 5, success: 3, failure: 2 }));
    expect(v.line).toBe("2 failing, and GitHub is not requiring them");
    expect(v.blocked).toBe(false);
  });

  it("one failing check is singular, because a sentence is read", () => {
    expect(mergeVerdict("CLEAN", roll({ total: 2, success: 1, failure: 1 })).line)
      .toContain("not requiring it");
  });

  it("right after a push it waits rather than claiming nothing reported", () => {
    expect(mergeVerdict("CLEAN", roll({}), true).line).toBe("Waiting for the checks");
    expect(mergeVerdict("CLEAN", roll({}), false).line).toBe("Nothing is blocking it");
  });

  it("anything GitHub will not take is blocked, and says why", () => {
    for (const state of ["BEHIND", "DIRTY", "DRAFT", "BLOCKED"]) {
      const v = mergeVerdict(state, roll({ total: 3, success: 3 }));
      expect(v.blocked).toBe(true);
      expect(v.line.length).toBeGreaterThan(0);
    }
    expect(mergeVerdict("DIRTY", roll({})).line).toContain("conflicts");
  });
});
