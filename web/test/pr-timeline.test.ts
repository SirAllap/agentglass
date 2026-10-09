/*
 * The conversation in GitHub's order.
 *
 * Two defects are pinned here. Threads were grouped away from the reviews that
 * opened them — an automation's thread was never nested, and a person's thread
 * that had been answered since was pulled out and re-sorted by its last reply —
 * so the page did not read the way github.com reads. And resolving a thread
 * moved it, where GitHub only folds it shut where it is.
 *
 * The fixture is the shape of an ordinary pull request with an automated
 * reviewer and one person: pushes, a label, three automated reviews each with
 * its thread, a person's review with two, the author answering on the pull
 * request, and a review request between remarks.
 */
import { describe, expect, it } from "bun:test";
import type { PrComment, PrCommit, PrDetail, PrEvent, PrReview, PrThread, PrThreadComment } from "../../shared/types.ts";
import { prTimeline, type TimelineItem } from "../src/lib/prTimeline.ts";

const D = (hhmm: string, day = 1) => `2026-08-0${day}T${hhmm}:00Z`;
const BOT = "orbit-reviewer[bot]";
const AUTHOR = "maya-dev";
const PERSON = "rkestrel";

const tc = (id: string, author: string, createdAt: string): PrThreadComment =>
  ({ id, author, isBot: author === BOT, body: "…", createdAt });
const thread = (id: string, comments: PrThreadComment[], isResolved = false): PrThread =>
  ({ id, path: "src/orbit/ledger.py", line: 42, isResolved, isOutdated: false, comments });
const review = (nodeId: string, author: string, submittedAt: string, state: PrReview["state"], body: string): PrReview =>
  ({ nodeId, author, isBot: author === BOT, submittedAt, state, body });
const comment = (id: number, author: string, createdAt: string): PrComment =>
  ({ id, author, isBot: author === BOT, body: "…", createdAt });
const commit = (oid: string, committedAt: string): PrCommit =>
  ({ oid, short: oid.slice(0, 7), message: "fix(ledger): round once", author: AUTHOR, isMerge: false, committedAt });
const event = (kind: PrEvent["kind"], at: string, detail: string): PrEvent => ({ kind, at, actor: AUTHOR, detail });

function fixture(): Pick<PrDetail, "reviews" | "comments" | "threads" | "timeline" | "commits"> {
  return {
    commits: [commit("aaaa111", D("09:00")), commit("bbbb222", D("09:02")), commit("cccc333", D("13:00"))],
    timeline: [
      event("labeled", D("09:05"), "ready to review"),
      event("review-requested", D("11:05"), PERSON),
    ],
    comments: [
      comment(501, AUTHOR, D("11:00")),
      comment(502, BOT, D("14:00")),
    ],
    reviews: [
      // Newest first, the way the API hands them back.
      review("R4", BOT, D("15:00"), "COMMENTED", "Review summary, third pass"),
      // A reply on a line: a review with no body, which GitHub does not draw.
      review("R-reply", AUTHOR, D("12:30"), "COMMENTED", ""),
      review("R3", BOT, D("12:00"), "COMMENTED", "Review summary, second pass"),
      review("R2", PERSON, D("10:00"), "CHANGES_REQUESTED", "Two things before this goes in."),
      review("R1", BOT, D("09:10"), "COMMENTED", "Review summary, first pass"),
    ],
    threads: [
      // Stamped a second after its review: automation writes both in one request.
      thread("T1", [tc("t1a", BOT, "2026-08-01T09:10:01Z"), tc("t1b", AUTHOR, D("09:40"))], true),
      // Drafted before the review was submitted, and answered two days later —
      // the thread that used to be pulled out and re-sorted by that answer.
      thread("T2", [tc("t2a", PERSON, D("09:50")), tc("t2b", AUTHOR, D("12:30")), tc("t2c", PERSON, D("08:00", 3))]),
      thread("T3", [tc("t3a", PERSON, D("09:55"))]),
      thread("T4", [tc("t4a", BOT, D("12:00"))], true),
      thread("T5", [tc("t5a", BOT, D("15:00"))]),
    ],
  };
}

/** The page as a reader scans it: one line per entry, threads in brackets. */
const shape = (items: TimelineItem[]) => items.map((x) => {
  switch (x.kind) {
    case "review": return `${x.review.nodeId}[${x.threads.map((t) => t.id).join(",")}]`;
    case "thread": return `thread ${x.thread.id}`;
    case "comment": return `comment ${x.comment.id}`;
    case "event": return x.event.kind;
    case "commits": return `commits ${x.commits.map((c) => c.short).join(",")}`;
  }
});

const GITHUB_ORDER = [
  "commits aaaa111,bbbb222",
  "labeled",
  "R1[T1]",
  "R2[T2,T3]",
  "comment 501",
  "review-requested",
  "R3[T4]",
  "commits cccc333",
  "comment 502",
  "R4[T5]",
];

describe("prTimeline", () => {
  it("interleaves everything in GitHub's order, each review carrying its threads", () => {
    expect(shape(prTimeline(fixture()))).toEqual(GITHUB_ORDER);
  });

  it("does not move a thread when it is resolved or unresolved", () => {
    const d = fixture();
    const before = shape(prTimeline(d));
    const toggled = { ...d, threads: d.threads.map((t) => ({ ...t, isResolved: !t.isResolved })) };
    expect(shape(prTimeline(toggled))).toEqual(before);
    // …and the fold travels with it: the nested thread is the toggled one.
    const r1 = prTimeline(toggled).find((x) => x.kind === "review" && x.review.nodeId === "R1");
    expect(r1?.kind === "review" && r1.threads[0]!.isResolved).toBe(false);
  });

  it("keeps a thread under its review however late it was answered", () => {
    const d = fixture();
    d.threads[2] = thread("T3", [tc("t3a", PERSON, D("09:55")), tc("t3b", AUTHOR, D("23:00", 4))]);
    expect(shape(prTimeline(d))).toEqual(GITHUB_ORDER);
  });

  it("stands a thread with no review of its own at its first comment", () => {
    const d = fixture();
    // A draft of the viewer's own, never submitted: no review will ever own it.
    d.threads.push(thread("T6", [tc("t6a", PERSON, D("11:02"))]));
    const got = shape(prTimeline(d));
    expect(got.indexOf("thread T6")).toBe(got.indexOf("comment 501") + 1);
    expect(got.indexOf("review-requested")).toBe(got.indexOf("thread T6") + 1);
  });

  it("files a thread by whoever opened it, not by who replied", () => {
    const d = fixture();
    d.threads.push(thread("T8", [tc("t8a", BOT, D("06:00", 5)), tc("t8b", PERSON, D("07:00", 5))]));
    const t8 = prTimeline(d).find((x) => x.kind === "thread");
    expect(t8?.lane).toBe("bot");
    const r2 = prTimeline(d).find((x) => x.kind === "review" && x.review.nodeId === "R2");
    expect(r2?.lane).toBe("human");
  });

  it("draws a review with no note when it opened a thread, the way a single line comment is", () => {
    const d = fixture();
    d.reviews.push(review("R5", PERSON, D("16:00"), "COMMENTED", ""));
    d.threads.push(thread("T7", [tc("t7a", PERSON, D("16:00"))]));
    expect(shape(prTimeline(d)).at(-1)).toBe("R5[T7]");
  });
});
