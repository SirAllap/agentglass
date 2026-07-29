/*
 * Line threads, which the phone had flattened into their first sentence.
 *
 * The Talk tab took each thread, threw away every reply, and printed
 * `path:line — <the first comment>` as one entry in a sorted list. The
 * back-and-forth about one line — the conversation that decides whether a pull
 * request can merge, and the one you are most likely to be catching up on from
 * a phone — was the one thing reduced to its opening remark. Resolved and
 * unresolved read identically; so did outdated. There was no way to reply and
 * no way to resolve, though the server has had both all along.
 */
import { describe, expect, it } from "bun:test";
import { orderThreads, openCount, replyTarget, where } from "../src/mobile/threads.ts";
import type { PrThread, PrThreadComment } from "../../shared/types.ts";

const c = (over: Partial<PrThreadComment> = {}): PrThreadComment => ({
  id: "IC_1", databaseId: 5001, author: "dana", isBot: false,
  body: "This allocates per row", createdAt: "2026-07-28T08:00:00Z", ...over,
} as PrThreadComment);

const t = (over: Partial<PrThread> = {}): PrThread => ({
  id: "PRRT_1", path: "src/cart.ts", line: 12, startLine: null,
  isResolved: false, isOutdated: false, comments: [c()], ...over,
});

describe("where a thread is", () => {
  it("names the file and the line", () => {
    expect(where(t())).toBe("src/cart.ts:12");
  });

  it("names a range as a range", () => {
    expect(where(t({ startLine: 8, line: 12 }))).toBe("src/cart.ts:8–12");
  });

  it("falls back to where the line used to be", () => {
    // An outdated thread has no current line; the original is the only handle
    // left, and it is more use than nothing.
    expect(where(t({ line: null, originalLine: 40 }))).toBe("src/cart.ts:40");
  });

  it("says just the file rather than a line that is not there", () => {
    // A thread on a deleted or heavily rewritten file arrives with no line at
    // all, and `src/cart.ts:null` is what the old template printed.
    expect(where(t({ line: null, originalLine: null }))).toBe("src/cart.ts");
    expect(where(t({ path: "", line: null }))).toBe("(unknown file)");
  });

  it("does not call a range a range when it is one line", () => {
    expect(where(t({ startLine: 12, line: 12 }))).toBe("src/cart.ts:12");
  });
});

describe("what a reply attaches to", () => {
  it("uses the first comment, which is the one that does not move", () => {
    // The endpoint is `/pulls/{n}/comments/{id}/replies` and the id has to be
    // in the thread. The last comment changes every time somebody answers, so
    // a screen holding a copy from a minute ago would post against an id the
    // server has already superseded.
    const th = t({ comments: [c({ databaseId: 5001 }), c({ databaseId: 5002 }), c({ databaseId: 5003 })] });
    expect(replyTarget(th)).toBe(5001);
  });

  it("skips a comment with no numeric id rather than sending a node id", () => {
    // `id` is a GraphQL node id and `databaseId` is what REST wants; the two
    // are not interchangeable, and sending the wrong one fails at the far end.
    const th = t({ comments: [c({ databaseId: null }), c({ databaseId: 5002 })] });
    expect(replyTarget(th)).toBe(5002);
  });

  it("is null when nothing in the thread can be replied to", () => {
    expect(replyTarget(t({ comments: [] }))).toBeNull();
    expect(replyTarget(t({ comments: [c({ databaseId: undefined })] }))).toBeNull();
    expect(replyTarget(t({ comments: [c({ databaseId: 0 })] }))).toBeNull();
  });
});

describe("the order they are read in", () => {
  it("puts what is still open above what is not", () => {
    const rows = orderThreads([
      t({ id: "resolved", isResolved: true }),
      t({ id: "outdated", isOutdated: true }),
      t({ id: "open" }),
    ]);
    expect(rows.map((r) => r.thread.id)).toEqual(["open", "outdated", "resolved"]);
  });

  it("reads down the diff inside a band, not in GitHub's order", () => {
    const rows = orderThreads([
      t({ id: "c", path: "src/price.ts", line: 4 }),
      t({ id: "b", path: "src/cart.ts", line: 90 }),
      t({ id: "a", path: "src/cart.ts", line: 12 }),
    ]);
    expect(rows.map((r) => r.thread.id)).toEqual(["a", "b", "c"]);
  });

  it("calls a thread that is both resolved and outdated settled", () => {
    // Resolved is the stronger statement: somebody decided. Reading it as
    // merely stale invites re-litigating a closed question.
    const [row] = orderThreads([t({ isResolved: true, isOutdated: true })]);
    expect(row!.quiet).toBe("resolved");
  });

  it("marks an open thread as wanting nothing said about it", () => {
    expect(orderThreads([t()])[0]!.quiet).toBeNull();
    expect(orderThreads([t({ isOutdated: true })])[0]!.quiet).toBe("outdated");
  });

  it("counts the replies, not the comments", () => {
    // The opening remark is the thread; what came after it is the conversation,
    // and "3 comments" on a thread nobody answered is a lie about activity.
    expect(orderThreads([t({ comments: [c()] })])[0]!.replies).toBe(0);
    expect(orderThreads([t({ comments: [c(), c(), c()] })])[0]!.replies).toBe(2);
    expect(orderThreads([t({ comments: [] })])[0]!.replies).toBe(0);
  });

  it("leaves the caller's array alone", () => {
    // The detail payload is shared with the overview and the tab badge; sorting
    // it where it lies would reorder those too.
    const given = [t({ id: "b", isResolved: true }), t({ id: "a" })];
    orderThreads(given);
    expect(given.map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("how many still want an answer", () => {
  it("counts everything unresolved, outdated included", () => {
    // The code moved; that does not mean the question was answered.
    expect(openCount([t(), t({ isOutdated: true }), t({ isResolved: true })])).toBe(2);
    expect(openCount([])).toBe(0);
  });
});
