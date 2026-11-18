/*
 * What the Overview leads with: is it blocked and whose move is it, and who
 * has reviewed. The fixture is a pull request with a person's request for
 * changes, a bot's approval, a person still to answer, and a red required
 * check.
 */
import { describe, expect, test } from "bun:test";
import type { PrCheckRollup, PrReview, PrThread } from "../../shared/types.ts";
import { lastSaid, mergeBanner, reviewerRows } from "../src/model/prOverview.ts";

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

  test("each row carries the mock's chip word and when they last said it", () => {
    expect(rows[0]).toMatchObject({ chip: "changes", said: "asked for changes" });
    expect(rows[0]!.at).toBe(Date.parse("2026-09-30T10:00:00Z"));
    expect(rows[1]).toMatchObject({ chip: "waiting", at: undefined });
  });

  test("nobody asked, nobody reviewed: no rows, so no empty card", () => {
    expect(reviewerRows({ ...d, reviews: [], reviewers: [] })).toEqual([]);
  });
});

/* The Overview's Talk preview (mock 32): the newest thing anybody wrote. */
const said = (over: Record<string, unknown>) => lastSaid({
  comments: [], reviews: [], threads: [], ...over,
} as Parameters<typeof lastSaid>[0]);

describe("the last thing said", () => {
  test("nothing said draws nothing", () => {
    expect(said({})).toBeNull();
  });

  test("the newest remark wins, whichever kind it is", () => {
    const out = said({
      comments: [{ id: "c1", author: "ada", body: "first", createdAt: "2026-09-01T10:00:00Z" }],
      reviews: [{ author: "bob", isBot: false, state: "APPROVED", body: "later", submittedAt: "2026-09-01T11:00:00Z" }],
    });
    expect(out).toMatchObject({ who: "bob", text: "later" });
    expect(out!.when).toBe(Date.parse("2026-09-01T11:00:00Z"));
  });

  test("a thread is dated and quoted by its first remark", () => {
    const out = said({
      threads: [{ id: "t9", isResolved: false, comments: [
        { author: "cy", body: "on this line", createdAt: "2026-09-01T09:00:00Z" },
        { author: "ada", body: "answered", createdAt: "2026-09-01T12:00:00Z" },
      ] }],
    });
    expect(out).toMatchObject({ who: "cy", text: "on this line" });
  });

  test("a review that says nothing is not the last word", () => {
    const out = said({
      comments: [{ id: "c1", author: "ada", body: "the only words", createdAt: "2026-09-01T10:00:00Z" }],
      reviews: [{ author: "bob", isBot: false, state: "COMMENTED", body: "", submittedAt: "2026-09-01T11:00:00Z" }],
    });
    expect(out).toMatchObject({ who: "ada", text: "the only words" });
  });
});
