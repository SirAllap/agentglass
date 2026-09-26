/*
 * The conversation of a pull request, split by who is speaking.
 *
 * The fixture is the shape of a live pull request: two people, one automation
 * account that posts a coverage report, a review with no words of its own (what
 * GitHub records for a batch of line comments), and one line thread.
 */
import { describe, expect, test } from "bun:test";
import type { PrComment, PrReview, PrThread } from "../../shared/types.ts";
import { conversation, countLanes, inLane } from "../../shared/prConversation.ts";

const comment = (id: number, author: string, isBot: boolean, createdAt: string): PrComment =>
  ({ id, author, isBot, body: `remark ${id}`, createdAt });
const review = (author: string, state: PrReview["state"], body: string, submittedAt: string, isBot = false): PrReview =>
  ({ author, isBot, state, body, submittedAt });
const thread = (id: string, author: string, isBot: boolean, createdAt: string): PrThread =>
  ({
    id, path: "src/thing.ts", line: 7, startLine: null, isResolved: false, isOutdated: false,
    diffHunk: "", originalLine: 7, url: "",
    comments: [{ id: `${id}-1`, author, isBot, body: "line remark", createdAt }],
  }) as PrThread;

// acme/orbit#42
const pr = {
  comments: [
    comment(1, "ada", false, "2026-01-05T10:00:00Z"),
    comment(2, "orbit-ci[bot]", true, "2026-01-05T10:05:00Z"),
    comment(3, "grace", false, "2026-01-05T12:00:00Z"),
  ],
  reviews: [
    review("grace", "COMMENTED", "", "2026-01-05T11:00:00Z"),
    review("grace", "APPROVED", "", "2026-01-05T13:00:00Z"),
  ],
  threads: [thread("t1", "grace", false, "2026-01-05T11:00:00Z")],
};

describe("conversation", () => {
  const all = conversation(pr);

  test("oldest first, across comments, reviews and threads", () => {
    expect(all.map((e) => e.key)).toEqual(["comment-1", "comment-2", "thread-t1", "comment-3", "review-2"]);
  });

  test("a review with no words and no verdict is not somebody speaking", () => {
    expect(all.some((e) => e.key === "review-1")).toBe(false);
  });

  test("a bare approval is", () => {
    expect(all.some((e) => e.key === "review-2")).toBe(true);
  });

  test("the lanes add up to the whole", () => {
    expect(countLanes(all)).toEqual({ all: 5, humans: 4, bots: 1 });
  });

  test("Humans and Bots each keep only their own", () => {
    expect(inLane(all, "humans").map((e) => e.key)).not.toContain("comment-2");
    expect(inLane(all, "bots").map((e) => e.key)).toEqual(["comment-2"]);
    expect(inLane(all, "all")).toBe(all);
  });

  test("a thread belongs to whoever opened it", () => {
    const botThread = conversation({ ...pr, threads: [thread("t2", "orbit-ci[bot]", true, "2026-01-05T09:00:00Z")] });
    expect(inLane(botThread, "bots").map((e) => e.key)).toContain("thread-t2");
  });

  test("an empty pull request is an empty conversation", () => {
    expect(conversation({ comments: [], reviews: [], threads: [] })).toEqual([]);
  });
});
