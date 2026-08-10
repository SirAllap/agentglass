/*
 * "Since you last looked", on a pull request.
 *
 * The bug these are written against is concrete: a reply left nine minutes ago
 * inside a thread opened two days earlier was, to the timeline, two days old —
 * so it sorted to the middle of a long page and took minutes to find. Every
 * case below is a shape from that pull request.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import type { PrDetail, PrThread } from "../../shared/types.ts";

/* A real store, not a no-op. Several other test files install a `setItem: () =>
   {}` stub, and under `bun test` they share one process — so a test that reads
   back what it wrote has to own the store, and has to install it BEFORE the
   module under test is imported. */
const cell = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => cell.get(k) ?? null,
  setItem: (k: string, v: string) => { cell.set(k, v); },
  removeItem: (k: string) => { cell.delete(k); },
};

const {
  at, threadLastAt, threadFirstAt, threadMovedOn, newSince, newKeys, foldedIdx,
  readSeen, writeSeen, prSeenKey, SEEN_KEY, SEEN_MAX, anchorId,
} = await import("../src/lib/prNew.ts");

const T = (iso: string) => Date.parse(iso);
const DAY2 = "2026-08-08T09:00:00Z";
const DAY2_LATER = "2026-08-08T11:00:00Z";
const NOW = "2026-08-10T10:00:00Z";

const comment = (id: string, author: string, createdAt: string, extra: Record<string, unknown> = {}) =>
  ({ id, author, isBot: false, body: "…", createdAt, ...extra });

const thread = (id: string, comments: ReturnType<typeof comment>[], extra: Partial<PrThread> = {}): PrThread =>
  ({ id, path: "src/billing/receipts.py", line: 420, isResolved: false, isOutdated: false, comments, ...extra } as PrThread);

const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
  threads: [], comments: [], reviews: [], timeline: [],
  ...over,
} as unknown as PrDetail);

describe("when a thread was last spoken in", () => {
  it("is the newest comment, not the first — the whole ordering bug", () => {
    const t = thread("t1", [
      comment("a", "nordvik", DAY2),
      comment("b", "you", DAY2_LATER),
      comment("c", "nordvik", NOW),
    ]);
    expect(threadFirstAt(t)).toBe(T(DAY2));
    expect(threadLastAt(t)).toBe(T(NOW));
  });

  it("survives a comment with an unreadable date rather than reading as now", () => {
    // A NaN sorting as "just now" would put a NEW badge on the oldest thread on
    // the page, which is the failure this whole feature is about, inverted.
    const t = thread("t1", [comment("a", "nordvik", "not a date"), comment("b", "you", DAY2)]);
    expect(at("not a date")).toBe(0);
    expect(threadLastAt(t)).toBe(T(DAY2));
  });

  it("says nothing about an empty thread", () => {
    expect(threadLastAt({ comments: [] })).toBe(0);
  });
});

describe("a thread that has moved on since its review", () => {
  const t = thread("t1", [comment("a", "nordvik", DAY2), comment("c", "nordvik", NOW)]);

  it("is one whose last reply is newer than the review it came with", () => {
    expect(threadMovedOn(t, DAY2)).toBe(true);
  });

  it("is not one that has been quiet since", () => {
    expect(threadMovedOn(thread("t2", [comment("a", "nordvik", DAY2)]), DAY2_LATER)).toBe(false);
  });

  it("is not decided at all when the review has no date", () => {
    expect(threadMovedOn(t, undefined)).toBe(false);
  });
});

describe("what has been said since you last looked", () => {
  const d = detail({
    threads: [thread("t1", [
      comment("a", "nordvik", DAY2),
      comment("b", "you", DAY2_LATER, { viewerDidAuthor: true }),
      comment("c", "nordvik", NOW),
    ])],
    comments: [{ id: 7, author: "nordvik", createdAt: "2026-08-10T10:05:00Z", body: "…", isBot: false } as never],
    reviews: [{ author: "nordvik", submittedAt: DAY2, state: "COMMENTED", body: "…", isBot: false } as never],
  });

  it("counts the reply in an old thread — the one that was impossible to find", () => {
    const got = newSince(d, T(DAY2_LATER));
    expect(got.map((a) => a.key)).toEqual(["t1:c", "c7"]);
    expect(got[0]!.where).toBe("src/billing/receipts.py:420");
  });

  it("never counts your own — a badge that lights up because you spoke is noise", () => {
    // `b` is newer than this mark and is yours; only the two from nordvik land.
    expect(newSince(d, T(DAY2)).some((a) => a.key === "t1:b")).toBe(false);
  });

  it("says nothing at all on a pull request you have never opened", () => {
    // Everything on it is new to you, and "41 new" on first sight is noise
    // dressed as news. The visit is recorded; the next arrival is the news.
    expect(newSince(d, 0)).toEqual([]);
  });

  it("is oldest first, so 'next' walks forwards in time", () => {
    const got = newSince(d, T("2026-08-01T00:00:00Z"));
    const times = got.map((a) => a.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("has nothing to say about a pull request that has not loaded", () => {
    expect(newSince(null, T(DAY2))).toEqual([]);
  });

  it("hands back a set the rendering can ask once per comment", () => {
    const keys = newKeys(newSince(d, T(DAY2_LATER)));
    expect(keys.has("t1:c")).toBe(true);
    expect(keys.has("t1:a")).toBe(false);
  });
});

describe("folding the middle of a long thread", () => {
  it("keeps the ends and hides what is between them", () => {
    expect([...foldedIdx(5, new Set())]).toEqual([1, 2, 3]);
  });

  it("never hides something new, wherever it sits", () => {
    expect([...foldedIdx(5, new Set([2]))]).toEqual([1, 3]);
  });

  it("leaves a short thread alone", () => {
    expect(foldedIdx(3, new Set()).size).toBe(0);
  });

  it("does not fold one comment — a click to save a line is a bad trade", () => {
    expect(foldedIdx(4, new Set([1])).size).toBe(0);
  });
});

describe("the mark of having looked", () => {
  beforeEach(() => localStorage.removeItem(SEEN_KEY));

  it("is per repository as well as per number", () => {
    expect(prSeenKey("acme/orbit", 482)).toBe("acme/orbit#482");
    expect(prSeenKey(undefined, 482)).toBe("?#482");
  });

  it("comes back after a reload", () => {
    writeSeen("acme/orbit#482", 1000);
    expect(readSeen()["acme/orbit#482"]).toBe(1000);
  });

  it("never moves backwards, so a stale tab cannot resurrect what you read", () => {
    writeSeen("acme/orbit#482", 2000);
    writeSeen("acme/orbit#482", 1000);
    expect(readSeen()["acme/orbit#482"]).toBe(2000);
  });

  it("survives rubbish in storage rather than throwing on every render", () => {
    localStorage.setItem(SEEN_KEY, "{not json");
    expect(readSeen()).toEqual({});
    localStorage.setItem(SEEN_KEY, JSON.stringify({ a: "yesterday", b: 5 }));
    expect(readSeen()).toEqual({ b: 5 });
  });

  it("drops the oldest visits rather than growing without end", () => {
    for (let i = 1; i <= SEEN_MAX + 10; i++) writeSeen(`r#${i}`, i);
    const all = readSeen();
    expect(Object.keys(all).length).toBe(SEEN_MAX);
    expect(all["r#1"]).toBeUndefined();
    expect(all[`r#${SEEN_MAX + 10}`]).toBe(SEEN_MAX + 10);
  });
});

describe("the anchor the jump scrolls to", () => {
  it("is namespaced, because a GitHub node id is not a document id", () => {
    expect(anchorId("t1:c")).toBe("agx-new-t1:c");
  });
});
