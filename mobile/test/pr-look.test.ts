/*
 * What a pull request's row says, and how lists across repositories group.
 *
 * The lists showed one repository at a time behind a picker, so "is anything
 * waiting on me" was asked once per repository. They open on all of them now,
 * grouped; these hold the words on a row and the grouping rule.
 */
import { describe, expect, test } from "bun:test";
import type { PrCheckRollup, PrSummary } from "../../shared/types.ts";
import { ciLook, flatten, reviewLook } from "../src/model/prLook.ts";

const checks = (over: Partial<PrCheckRollup>): PrCheckRollup => ({
  total: 12, success: 12, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [], ...over,
});

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 482, title: "Search index rebuilds on every keystroke", author: "kai-m", state: "OPEN", isDraft: false,
  headRefName: "feat/search", baseRefName: "main", url: "", updatedAt: "2026-09-01T10:00:00Z",
  reviewDecision: "REVIEW_REQUIRED", additions: 214, deletions: 38, changedFiles: 6, labels: [], assignees: [],
  milestone: null, checksLoaded: true,
  checks: checks({}),
  ...over,
} as PrSummary);

describe("the checks", () => {
  test("red, running, green — each says how many", () => {
    expect(ciLook(pr({ checks: checks({ failure: 2, success: 10, verdict: "red" }) })))
      .toEqual({ mark: "fail", label: "2 failed", tone: "bad" });
    expect(ciLook(pr({ checks: checks({ pending: 3, success: 9, allDone: false, verdict: null }) })).label)
      .toBe("3 running");
    expect(ciLook(pr()).label).toBe("12 passed");
  });
  test("not read yet is not the same claim as no checks", () => {
    expect(ciLook(pr({ checksLoaded: false })).label).toBe("checks…");
    expect(ciLook(pr({ checks: checks({ total: 0, success: 0, verdict: null }) })))
      .toEqual({ mark: "none", label: null, tone: "neutral" });
  });
  test("a draft is nobody's problem yet", () => {
    expect(ciLook(pr({ isDraft: true })).mark).toBe("draft");
    expect(reviewLook(pr({ isDraft: true }), true)).toEqual({ label: "Draft", tone: "neutral" });
  });
});

describe("the review", () => {
  test("on the Review filter every row is asking you, and says so", () => {
    expect(reviewLook(pr(), true)?.label).toBe("Needs your review");
    expect(reviewLook(pr(), false)?.label).toBe("Needs review");
  });
  test("approved and changes requested", () => {
    expect(reviewLook(pr({ reviewDecision: "APPROVED", humanReview: { kind: "approved", who: ["bob-r"] } }), false))
      .toEqual({ label: "Approved", tone: "good" });
    expect(reviewLook(pr({ reviewDecision: "CHANGES_REQUESTED" }), false)?.tone).toBe("bad");
    expect(reviewLook(pr({ reviewDecision: null }), false)).toBeNull();
  });
  /* `reviewDecision: "APPROVED"` because a bot approved it, while the only
   * human asked for changes: the list said "Approved". */
  test("a bot's approval is not an approval", () => {
    const botOnly = pr({ reviewDecision: "APPROVED", humanReview: null });
    expect(reviewLook(botOnly, false)).toEqual({ label: "Needs review", tone: "warn" });
    expect(reviewLook(pr({ reviewDecision: "APPROVED", humanReview: { kind: "changes", who: ["bob-r"] } }), false))
      .toEqual({ label: "Changes requested", tone: "bad" });
    expect(reviewLook(pr({ reviewDecision: "APPROVED", humanReview: { kind: "awaiting", who: ["bob-r"] } }), true)?.label)
      .toBe("Needs your review");
  });
  test("a person's approval still reads Approved, stale or not counted", () => {
    const ok = pr({ reviewDecision: "APPROVED", humanReview: { kind: "approved", who: ["bob-r"] } });
    expect(reviewLook(ok, false)).toEqual({ label: "Approved", tone: "good" });
    const stale = pr({ reviewDecision: "REVIEW_REQUIRED", humanReview: { kind: "approved", who: ["bob-r"], stale: true } });
    expect(reviewLook(stale, false)?.tone).toBe("warn");
  });
  test("still being read is silence, not a claim", () => {
    expect(reviewLook(pr({ reviewDecision: "APPROVED", checksLoaded: false }), false)).toBeNull();
  });
});

describe("grouping", () => {
  const groups = [
    { root: "/w/orbit", name: "orbit", items: [1, 2] },
    { root: "/w/lantern", name: "lantern", items: [] as number[] },
    { root: "/w/atlas", name: "atlas-api", items: [3] },
  ];
  test("a heading per repository, and none over an empty one", () => {
    expect(flatten(groups)).toEqual([
      { heading: "orbit", count: 2 }, { item: 1, root: "/w/orbit" }, { item: 2, root: "/w/orbit" },
      { heading: "atlas-api", count: 1 }, { item: 3, root: "/w/atlas" },
    ]);
  });
  test("one repository needs no heading: the chip already says which", () => {
    expect(flatten([groups[0]!])).toEqual([{ item: 1, root: "/w/orbit" }, { item: 2, root: "/w/orbit" }]);
  });
});
