/*
 * What the Overview leads with: is it blocked and whose move is it, and who
 * has reviewed. The fixture is a pull request with a person's request for
 * changes, a bot's approval, a person still to answer, and a red required
 * check.
 */
import { describe, expect, test } from "bun:test";
import type { PrCheckRollup, PrReview, PrThread } from "../../shared/types.ts";
import { mergeBanner, reviewerRows } from "../src/model/prOverview.ts";

const checks = (over: Partial<PrCheckRollup> = {}): PrCheckRollup =>
  ({ total: 4, success: 4, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [], ...over });
const review = (author: string, state: PrReview["state"], at: string, isBot = false): PrReview =>
  ({ author, isBot, state, body: "", submittedAt: at });
const openThread = { id: "t1", isResolved: false, comments: [{ author: "bob" }] } as unknown as PrThread;

// acme/orbit#101
const base = {
  state: "OPEN", isDraft: false, mergeState: "CLEAN", checks: checks(), reviewDecision: null, baseRefName: "main", author: "ada",
  humanReview: null, threads: [] as PrThread[],
} as Parameters<typeof mergeBanner>[0];

describe("mergeBanner", () => {
  test("blocked says so, why, and whose move it is", () => {
    const b = mergeBanner({
      ...base, mergeState: "BLOCKED", reviewDecision: "CHANGES_REQUESTED", threads: [openThread],
      humanReview: { kind: "changes", who: ["bob"] },
    });
    expect(b.title).toBe("Merging is blocked");
    expect(b.tone).toBe("bad");
    expect(b.text).toBe("bob asked for changes and 1 thread is open. bob has to approve again.");
  });

  test("red checks are the author's to fix", () => {
    const b = mergeBanner({
      ...base, mergeState: "BLOCKED",
      checks: checks({ failure: 1, success: 3, allDone: true, verdict: "red", failing: [{ name: "test (ubuntu-latest)" }] as never }),
    });
    expect(b.title).toBe("Merging is blocked");
    expect(b.text).toBe("test (ubuntu-latest) failed. ada has to fix it.");
  });

  test("a person's objection that GitHub would not enforce is said as it is, not as a block", () => {
    const b = mergeBanner({ ...base, humanReview: { kind: "changes", who: ["bob"] } });
    expect(b.title).not.toBe("Merging is blocked");
    expect(b.tone).toBe("warn");
    expect(b.text).toBe("bob asked for changes. bob has to approve again.");
  });

  test("a clean one is ready and says nothing else", () => {
    expect(mergeBanner(base)).toMatchObject({ tone: "good", title: "Ready to merge", open: true });
  });

  test("merged and closed are not a question any more", () => {
    expect(mergeBanner({ ...base, state: "MERGED", mergedBy: "cy" })).toMatchObject({ title: "Merged", text: "Merged into main by cy.", open: false });
    expect(mergeBanner({ ...base, state: "CLOSED" })).toMatchObject({ title: "Closed", open: false });
  });

  test("a draft is blocked whatever GitHub says", () => {
    expect(mergeBanner({ ...base, isDraft: true }).title).toBe("Merging is blocked");
  });
});

describe("reviewerRows", () => {
  const d = {
    author: "ada", reviewDecision: "CHANGES_REQUESTED", threads: [openThread], timeline: [],
    reviewers: [{ login: "cy" }],
    reviews: [
      review("bob", "CHANGES_REQUESTED", "2026-09-30T10:00:00Z"),
      review("orbit-review[bot]", "APPROVED", "2026-09-30T10:05:00Z", true),
    ],
  } as unknown as Parameters<typeof reviewerRows>[0];
  const rows = reviewerRows(d);

  test("people in the desk's order, then automation", () => {
    expect(rows.map((r) => `${r.login}:${r.word}`)).toEqual(["bob:Changes requested", "cy:Pending", "orbit-review[bot]:Approved"]);
  });

  test("automation is tagged as such and never counted as a person", () => {
    expect(rows.map((r) => r.bot)).toEqual([false, false, true]);
  });

  test("the author is not their own reviewer", () => {
    const r = reviewerRows({ ...d, reviewers: [{ login: "ada" }, { login: "cy" }] });
    expect(r.some((x) => x.login === "ada")).toBe(false);
  });

  test("a requested team is a row that is not a person", () => {
    const r = reviewerRows({ ...d, reviewers: [{ login: "core", isTeam: true }] });
    expect(r.find((x) => x.login === "core")).toMatchObject({ team: true, word: "Team pending" });
  });

  test("nobody asked, nobody reviewed: no rows, so no empty card", () => {
    expect(reviewerRows({ ...d, reviews: [], reviewers: [] })).toEqual([]);
  });
});
