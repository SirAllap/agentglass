// A failing test's history, from facts: what it says, and what it refuses to say.
import { describe, expect, test } from "bun:test";
import { testVerdict, verdictLabel, cardOwnership, type Seen } from "../../shared/failureVerdict.ts";

const S = "orbit sync > gives its slot back :: timeout";
const seen = (o: Partial<Seen> & { job: string }): Seen => ({ signature: S, pr: null, main: false, ...o });
const me = { job: "1", pr: 482, passedOnRetry: false, weak: false };

describe("testVerdict", () => {
  test("nothing else seen: this PR, which claims no more than the reads show", () => {
    expect(testVerdict(S, [seen({ job: "1", pr: 482 })], me)).toEqual({ kind: "this-pr" });
  });
  test("the same signature on other PRs counts distinct PRs, not runs", () => {
    const v = testVerdict(S, [seen({ job: "2", pr: 475 }), seen({ job: "3", pr: 475 }), seen({ job: "4", pr: 471 }), seen({ job: "1", pr: 482 })], me);
    expect(v).toEqual({ kind: "others", prs: 2, nums: [475, 471] });
  });
  test("it names the pull requests, newest first, and counts apart the runs whose pull request is not known", () => {
    const v = testVerdict(S, [seen({ job: "2", pr: 475 }), seen({ job: "3", pr: null }), seen({ job: "4", pr: null }), seen({ job: "1", pr: 482 })], me);
    expect(v).toEqual({ kind: "others", prs: 1, nums: [475], unknown: 2 });
  });
  test("runs whose pull request is unknown say nothing on their own: still this PR", () => {
    expect(testVerdict(S, [seen({ job: "3", pr: null })], me)).toEqual({ kind: "this-pr" });
  });
  test("another test's failure on another PR is not this one's", () => {
    expect(testVerdict(S, [seen({ job: "2", pr: 475, signature: "orbit board > x :: y" })], me)).toEqual({ kind: "this-pr" });
  });
  test("a re-run of this very PR is not 'another PR'", () => {
    expect(testVerdict(S, [seen({ job: "9", pr: 482 })], me)).toEqual({ kind: "this-pr" });
  });
  test("red on the default branch outranks other PRs", () => {
    expect(testVerdict(S, [seen({ job: "2", pr: 475 }), seen({ job: "5", main: true })], me)).toEqual({ kind: "main" });
  });
  test("failed then passed on the same commit is flaky, whatever else is said", () => {
    expect(testVerdict(S, [seen({ job: "5", main: true })], { ...me, passedOnRetry: true })).toEqual({ kind: "flaky" });
  });
  test("a step's exit code is too weak to compare: it says it was seen", () => {
    expect(testVerdict(S, [seen({ job: "5", main: true })], { ...me, weak: true })).toEqual({ kind: "once" });
  });
});

describe("words", () => {
  test("each says what was seen", () => {
    expect(verdictLabel({ kind: "main" })).toBe("Red on main");
    expect(verdictLabel({ kind: "flaky" })).toBe("Flaky test");
    expect(verdictLabel({ kind: "others", prs: 3 })).toBe("Also failed on 3 other PRs");
    expect(verdictLabel({ kind: "others", prs: 1 })).toBe("Also failed on 1 other PR");
    expect(verdictLabel({ kind: "others", prs: 1, nums: [475] })).toBe("Also failed on #475");
    expect(verdictLabel({ kind: "others", prs: 1, nums: [475], unknown: 1 })).toBe("Also failed on 1 other PR");
    expect(verdictLabel({ kind: "others", prs: 2, nums: [475, 471] })).toBe("Also failed on 2 other PRs");
    expect(verdictLabel({ kind: "this-pr" }, 482)).toBe("This PR only · #482");
    expect(verdictLabel({ kind: "once" })).toBe("Seen once");
  });
});

describe("whose problem a card's failures are", () => {
  test("no failures read: nothing is claimed", () => expect(cardOwnership([])).toEqual({ notYours: false }));
  test("one new failure among shared ones is still yours", () => {
    expect(cardOwnership([{ kind: "others", prs: 3 }, { kind: "this-pr" }])).toEqual({ notYours: false });
  });
  test("every failure red elsewhere: not yours, with the smallest count so it is true of each", () => {
    expect(cardOwnership([{ kind: "others", prs: 3 }, { kind: "others", prs: 2 }])).toEqual({ notYours: true, main: false, prs: 2 });
  });
  test("all on main", () => expect(cardOwnership([{ kind: "main" }, { kind: "main" }])).toEqual({ notYours: true, main: true, prs: 0 }));
  test("flaky or once is never 'not yours'", () => {
    expect(cardOwnership([{ kind: "flaky" }])).toEqual({ notYours: false });
    expect(cardOwnership([{ kind: "once" }])).toEqual({ notYours: false });
  });
});
