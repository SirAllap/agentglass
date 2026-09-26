/*
 * "New since I last looked" on the phone, from the marks the server holds.
 *
 * Fixtures are the shape of a live pull request: two people, one automation
 * account, the viewer's own remark, and a line thread that got a reply after
 * the viewer last looked. Everything is acme/orbit#42.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MarkRow, PrDetail, PrSummary } from "../../shared/types.ts";
import { conversation } from "../../shared/prConversation.ts";
import { prMarkKey, unreadOf } from "../../shared/prUnread.ts";
import { applyMarkRows, newness } from "../src/model/readMarks.ts";
import { applyMarks, loadPrMarks, markPrRead, resetMarks, seenNow } from "../src/state/read-marks.ts";
import type { Host } from "../src/lib/host.ts";

const T = (min: number): string => new Date(Date.UTC(2026, 0, 5, 10, min)).toISOString();
const ms = (min: number): number => Date.parse(T(min));
const KEY = "github.com/acme/orbit#42";

const row = (key: string, seenAt: number, kind: MarkRow["kind"] = "pr"): MarkRow =>
  ({ kind, key, seenAt, state: "", updatedAt: 1 });

const summary = (talk: PrSummary["talk"]): Pick<PrSummary, "number" | "url" | "talk"> =>
  ({ number: 42, url: "https://github.com/acme/orbit/pull/42", talk });

describe("the key", () => {
  test("is the one the browser writes: host/owner/name#number", () => {
    expect(prMarkKey(summary([]))).toBe(KEY);
  });
  test("a row with no readable url falls back to the browser's own '?'", () => {
    expect(prMarkKey({ number: 7, url: "" })).toBe("?#7");
  });
});

describe("applyMarkRows", () => {
  test("a row sets the mark, a later row moves it, zero clears it", () => {
    let seen = applyMarkRows({}, [row(KEY, ms(5))]);
    expect(seen[KEY]).toBe(ms(5));
    seen = applyMarkRows(seen, [row(KEY, ms(9))]);
    expect(seen[KEY]).toBe(ms(9));
    seen = applyMarkRows(seen, [row(KEY, 0)]);
    expect(KEY in seen).toBe(false);
  });
  test("other kinds are not pull requests", () => {
    expect(applyMarkRows({}, [row("123", ms(1), "inbox"), row("c1", ms(1), "card")])).toEqual({});
  });
  test("a key that would poison a plain object is refused", () => {
    expect(Object.keys(applyMarkRows({}, [row("__proto__", ms(1))]))).toEqual([]);
  });
  test("returns the same object when nothing changed, so nothing repaints", () => {
    const seen = { [KEY]: ms(5) };
    expect(applyMarkRows(seen, [row(KEY, ms(5))])).toBe(seen);
  });
});

describe("the list badge follows the mark", () => {
  const talk: PrSummary["talk"] = [
    { kind: "comment", who: "grace", at: T(20), mine: false },
    { kind: "comment", who: "me", at: T(25), mine: true },
  ];
  test("counts what came after the mark, yours left out", () => {
    const u = unreadOf(summary(talk), "github.com/acme/orbit", { [KEY]: ms(10) });
    expect(u?.count).toBe(1);
  });
  test("goes out once the mark passes it", () => {
    expect(unreadOf(summary(talk), "github.com/acme/orbit", { [KEY]: ms(30) })).toBeNull();
  });
});

describe("newness in the conversation", () => {
  const detail = {
    comments: [
      { id: 1, author: "ada", isBot: false, body: "a", createdAt: T(0) },
      { id: 2, author: "me", isBot: false, body: "b", createdAt: T(10), viewerDidAuthor: true },
      { id: 3, author: "orbit-ci[bot]", isBot: true, body: "c", createdAt: T(20) },
      { id: 4, author: "grace", isBot: false, body: "d", createdAt: T(30) },
    ],
    reviews: [{ author: "grace", isBot: false, state: "APPROVED", body: "", submittedAt: T(40) }],
    threads: [{
      id: "t1", path: "src/thing.ts", line: 7, isResolved: false, isOutdated: false, diffHunk: "",
      comments: [
        { id: "t1a", author: "ada", isBot: false, body: "q", createdAt: T(2) },
        { id: "t1b", author: "grace", isBot: false, body: "r", createdAt: T(35) },
      ],
    }],
  } as unknown as PrDetail;
  const entries = conversation(detail);

  test("flags what came after the mark: not mine, not a bot", () => {
    const n = newness(entries, detail, ms(12));
    expect([...n.keys].sort()).toEqual(["comment-4", "review-1", "thread-t1"]);
    expect(n.count).toBe(3);
  });
  test("the divider goes before the first NEW entry after the mark, not a bot line", () => {
    expect(newness(entries, detail, ms(12)).dividerBefore).toBe("comment-4");
  });
  test("a reply in an old thread is new, but does not move the divider up", () => {
    const n = newness(entries, detail, ms(32));
    expect(n.keys.has("thread-t1")).toBe(true);
    expect(n.dividerBefore).toBe("review-1");
  });
  test("nothing new, no divider", () => {
    const n = newness(entries, detail, ms(50));
    expect(n.count).toBe(0);
    expect(n.dividerBefore).toBeNull();
  });
  test("never opened, never spoke: nothing is new", () => {
    expect(newness(entries, detail, 0).count).toBe(0);
  });
});

describe("the store", () => {
  const host = { origin: "http://acme.test:4000", token: "t", scope: "answer" } as unknown as Host;
  const real = globalThis.fetch;
  let calls: { url: string; init?: RequestInit }[] = [];
  beforeEach(() => { calls = []; resetMarks(); });
  afterEach(() => { globalThis.fetch = real; });
  const serve = (body: unknown, status = 200): void => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  };

  test("loadPrMarks reads the pr rows only", async () => {
    serve({ marks: [row(KEY, ms(5))], now: 1 });
    await loadPrMarks(host);
    expect(calls[0]!.url).toContain("/marks?kind=pr");
    expect(seenNow()[KEY]).toBe(ms(5));
  });

  test("a frame from the desktop moves it, and a clear removes it", () => {
    applyMarks([row(KEY, ms(5))]);
    expect(seenNow()[KEY]).toBe(ms(5));
    applyMarks([row(KEY, 0)]);
    expect(KEY in seenNow()).toBe(false);
  });

  test("markPrRead is local at once and posted as a pr op", async () => {
    serve({ ok: true, changed: [] });
    await markPrRead(host, KEY, ms(9));
    expect(seenNow()[KEY]).toBe(ms(9));
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ ops: [{ kind: "pr", key: KEY, seenAt: ms(9) }] });
  });

  test("marking an older time never moves a mark back", async () => {
    serve({ ok: true, changed: [] });
    await markPrRead(host, KEY, ms(9));
    await markPrRead(host, KEY, ms(3));
    expect(seenNow()[KEY]).toBe(ms(9));
    expect(calls.length).toBe(1);
  });

  test("a refused write leaves the local mark and does not throw", async () => {
    serve({ ok: false, error: "no" }, 403);
    await markPrRead(host, KEY, ms(9));
    expect(seenNow()[KEY]).toBe(ms(9));
  });
});
