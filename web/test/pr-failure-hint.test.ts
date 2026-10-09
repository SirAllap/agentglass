/*
 * The board card names WHICH test is failing, from failures already read and
 * kept, and says whose problem it is only on a fact. It never asks for a log.
 */
import { describe, expect, it } from "bun:test";
import { failureHint, jobIdOf } from "../src/lib/prFailureHint.ts";
import { fileInLane, board } from "../src/lib/prLanes.ts";
import type { CheckFailureSummary, PrCheck, PrSummary } from "../../shared/types.ts";

const chk = (job: string, name = "build"): PrCheck => ({ name, workflow: "CI", state: "failure", done: true, url: `https://github.com/acme/orbit/actions/runs/9/job/${job}` });
const sum = (titles: string[], verdicts: CheckFailureSummary["verdicts"], o: Partial<CheckFailureSummary> = {}): CheckFailureSummary => ({ state: "read", source: "log", count: titles.length, more: 0, titles, verdicts, ...o });
const pr = (failing: PrCheck[]): PrSummary => ({
  number: 482, title: "t", author: "someone", state: "OPEN", isDraft: false, headRefName: "h", baseRefName: "main", url: "", updatedAt: "", reviewDecision: null,
  additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
  checks: { total: 9, success: 9 - failing.length, failure: failing.length, skipped: 0, pending: 0, allDone: true, verdict: "red", failing },
}) as unknown as PrSummary;
const MINE = { mine: true, asked: false };

describe("jobIdOf", () => {
  it("reads the job a check ran as", () => {
    expect(jobIdOf(chk("1234"))).toBe("1234");
    expect(jobIdOf({ url: undefined })).toBeNull();
    expect(jobIdOf({ url: "https://github.com/acme/orbit/runs/77" })).toBeNull();
  });
});

describe("failureHint", () => {
  it("names the first test and counts the rest", () => {
    const h = failureHint([chk("1")], () => sum(["orbit board > keeps four lanes", "orbit sync > gives its slot back"], [{ kind: "this-pr" }, { kind: "this-pr" }]));
    expect(h).toMatchObject({ title: "orbit board > keeps four lanes", more: 1, ownership: { notYours: false } });
  });
  it("nothing read: no hint, and the card says what it always did", () => {
    expect(failureHint([chk("1")], () => undefined)).toBeNull();
  });
  it("a step's tail names no test: no hint", () => {
    expect(failureHint([chk("1")], () => sum(["Smoke"], [{ kind: "once" }], { source: "step" }))).toBeNull();
  });
  it("'not yours' needs EVERY failing check read: one unread check could be this PR's own", () => {
    const only = (job: string) => (job === "1" ? sum(["a"], [{ kind: "others", prs: 3 }]) : undefined);
    expect(failureHint([chk("1")], only)?.ownership).toEqual({ notYours: true, main: false, prs: 3 });
    expect(failureHint([chk("1"), chk("2", "e2e")], only)?.ownership).toEqual({ notYours: false });
  });
});

describe("the sentence", () => {
  const hint = (v: CheckFailureSummary["verdicts"]) => failureHint([chk("1")], () => sum(["orbit sync > gives its slot back", "x"], v));
  it("unchanged when nothing was read", () => {
    const f = fileInLane(pr([chk("1")]), MINE, null);
    expect(f.reason).toBe("build failing — yours to fix.");
    expect(f.test).toBeUndefined();
  });
  it("yours, with the test beside it", () => {
    const f = fileInLane(pr([chk("1")]), MINE, hint([{ kind: "this-pr" }, { kind: "this-pr" }]));
    expect(f.reason).toBe("build failing — yours to fix.");
    expect(f.test).toEqual({ title: "orbit sync > gives its slot back", more: 1 });
  });
  it("red on other PRs: not yours, and says how many", () => {
    const f = fileInLane(pr([chk("1")]), MINE, hint([{ kind: "others", prs: 3 }, { kind: "others", prs: 5 }]));
    expect(f.reason).toBe("build failing — red on 3 other PRs, not yours.");
  });
  it("red on main: not yours", () => {
    expect(fileInLane(pr([chk("1")]), MINE, hint([{ kind: "main" }, { kind: "main" }])).reason).toBe("build failing — red on main, not yours.");
  });
  it("one failure that is new keeps it yours", () => {
    expect(fileInLane(pr([chk("1")]), MINE, hint([{ kind: "others", prs: 3 }, { kind: "this-pr" }])).reason).toContain("yours to fix");
  });
  it("a card that is not yours keeps its reviewing sentence", () => {
    const f = fileInLane(pr([chk("1")]), { mine: false, asked: false }, hint([{ kind: "others", prs: 3 }, { kind: "others", prs: 3 }]));
    expect(f.reason).toContain("reviewing it is wasted work");
  });
  it("the board hands each card its own hint", () => {
    const lanes = board([pr([chk("1")])], () => MINE, () => hint([{ kind: "this-pr" }, { kind: "this-pr" }]));
    expect([...lanes.values()].flat()[0]!.filed.test?.title).toBe("orbit sync > gives its slot back");
  });
});
