/*
 * The decisions the threads screen makes before it draws anything.
 *
 * They live outside the screen because the screen cannot be seen here: showing
 * it with real conversations on it needs a GitHub, and the QA walk that visits
 * every route reaches only its "cannot read it" state. So the parts that can be
 * wrong on their own are pulled out and checked on their own.
 */
import { describe, expect, test } from "bun:test";
import type { PrThread, PrThreadComment } from "../../shared/types.ts";
import { hunkTail, ordered, replyAnchor, whereOf } from "../src/model/threads.ts";

function comment(over: Partial<PrThreadComment> = {}): PrThreadComment {
  return {
    id: "MDEy", author: "someone", isBot: false, body: "",
    createdAt: "2026-08-01T00:00:00Z", ...over,
  };
}

function thread(over: Partial<PrThread> = {}): PrThread {
  return {
    id: "T", path: "src/a.ts", line: 10, isResolved: false, isOutdated: false,
    comments: [comment()], ...over,
  };
}

describe("ordered", () => {
  test("open threads come before resolved ones", () => {
    const got = ordered([
      thread({ id: "done", isResolved: true }),
      thread({ id: "open" }),
    ]);
    expect(got.map((t) => t.id)).toEqual(["open", "done"]);
  });

  test("outdated sits between open and resolved", () => {
    const got = ordered([
      thread({ id: "resolved", isResolved: true }),
      thread({ id: "outdated", isOutdated: true }),
      thread({ id: "open" }),
    ]);
    expect(got.map((t) => t.id)).toEqual(["open", "outdated", "resolved"]);
  });

  test("nothing is hidden — a resolved thread is the record of an argument", () => {
    const all = [thread({ id: "a", isResolved: true }), thread({ id: "b", isOutdated: true })];
    expect(ordered(all).length).toBe(2);
  });

  test("within a group the detail's own order is kept", () => {
    // File order, decided once on the server. Re-sorting here would be a
    // second opinion about the same list.
    const got = ordered([thread({ id: "1" }), thread({ id: "2" }), thread({ id: "3" })]);
    expect(got.map((t) => t.id)).toEqual(["1", "2", "3"]);
  });

  test("the input is not reordered underneath the caller", () => {
    const all = [thread({ id: "done", isResolved: true }), thread({ id: "open" })];
    ordered(all);
    expect(all.map((t) => t.id)).toEqual(["done", "open"]);
  });

  test("an empty list is an empty list", () => {
    expect(ordered([])).toEqual([]);
  });
});

describe("whereOf", () => {
  test("one line", () => {
    expect(whereOf({ path: "src/a.ts", line: 10, startLine: null, originalLine: null })).toBe("src/a.ts:10");
  });

  test("a range keeps both ends", () => {
    expect(whereOf({ path: "src/a.ts", line: 18, startLine: 12, originalLine: null })).toBe("src/a.ts:12-18");
  });

  test("a start equal to the end is not a range", () => {
    expect(whereOf({ path: "src/a.ts", line: 10, startLine: 10, originalLine: null })).toBe("src/a.ts:10");
  });

  test("an outdated thread is labelled where it was written", () => {
    /* The label may fall back to originalLine and applying a suggestion may
       not. Same two numbers, two different questions: this one says where the
       conversation happened, and the other would edit the file. */
    expect(whereOf({ path: "src/a.ts", line: null, startLine: null, originalLine: 42 })).toBe("src/a.ts:42");
  });

  test("no line anywhere is just the file", () => {
    expect(whereOf({ path: "src/a.ts", line: null, startLine: null, originalLine: null })).toBe("src/a.ts");
  });
});

describe("hunkTail", () => {
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  test("keeps the end, because that is the line the comment is on", () => {
    const got = hunkTail(lines(12), 3);
    expect(got.lines).toEqual(["line 10", "line 11", "line 12"]);
    expect(got.clipped).toBe(true);
  });

  test("a short hunk is shown whole and is not marked clipped", () => {
    const got = hunkTail(lines(3), 8);
    expect(got.lines.length).toBe(3);
    expect(got.clipped).toBe(false);
  });

  test("trailing blanks do not eat the budget", () => {
    // `diffHunk` arrives with a trailing newline, sometimes two. Counting them
    // as content spends rows on nothing and pushes real lines off the top.
    const got = hunkTail(`${lines(3)}\n\n`, 3);
    expect(got.lines).toEqual(["line 1", "line 2", "line 3"]);
    expect(got.clipped).toBe(false);
  });

  test("an absent hunk is nothing rather than a crash", () => {
    expect(hunkTail("").lines).toEqual([]);
    expect(hunkTail("" as unknown as string).clipped).toBe(false);
  });
});

describe("replyAnchor", () => {
  test("is the numeric id, never the node id", () => {
    /* The two are not interchangeable, and posting the node id where the REST
       endpoint wants the number fails with a 404 that reads like the thread
       does not exist. */
    expect(replyAnchor({ comments: [comment({ id: "PRRC_kwDO", databaseId: 991 })] })).toBe(991);
  });

  test("is the first comment that carries one", () => {
    // `in_reply_to` the opening comment; GitHub threads the rest itself.
    expect(replyAnchor({ comments: [comment({ databaseId: 1 }), comment({ databaseId: 2 })] })).toBe(1);
  });

  test("skips comments with no numeric id", () => {
    expect(replyAnchor({ comments: [comment(), comment({ databaseId: 7 })] })).toBe(7);
  });

  test("a thread with nothing to reply to says so", () => {
    // The screen does not offer a reply box in this case, rather than offering
    // one that fails on send.
    expect(replyAnchor({ comments: [comment()] })).toBe(null);
    expect(replyAnchor({ comments: [] })).toBe(null);
    expect(replyAnchor({ comments: [comment({ databaseId: null })] })).toBe(null);
  });
});
