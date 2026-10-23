/*
 * A merged or closed card shows only what is final: who ended it and how, the
 * checks as they stood, the size, the reviews. These pin the sentences, the
 * indigo for merged, and the request rule for the details behind them.
 */
import { describe, expect, test } from "bun:test";
import { checksLine, closedHeader, finishedKind, needsClosedFacts, openFor, reviewsTail, sizeLine, whyLine } from "../../shared/prClosed.ts";
import { nextDetailBatch, owesDetails } from "../src/lib/useRowDetails.ts";
import type { PrClosedFacts } from "../../shared/types.ts";

const facts = (over: Partial<PrClosedFacts> = {}): PrClosedFacts => ({
  at: "2026-01-03T13:00:00Z", openedAt: "2026-01-01T10:00:00Z", by: "ada", method: "squash",
  checks: { total: 75, success: 74, failure: 0, skipped: 1, failing: [] }, commits: 3,
  reviews: { approved: ["ada"], changes: [], rounds: 2, comments: 9 }, why: null, ...over,
});
const stamp = (iso: string) => iso.slice(0, 10);

describe("how long it was open", () => {
  test("two largest units, none of them zero", () => {
    expect(openFor("2026-01-01T10:00:00Z", "2026-01-03T13:00:00Z")).toBe("2d 3h");
    expect(openFor("2026-01-01T10:00:00Z", "2026-01-05T10:20:00Z")).toBe("4d");
    expect(openFor("2026-01-01T10:00:00Z", "2026-01-01T11:20:00Z")).toBe("1h 20m");
    expect(openFor("2026-01-01T10:00:00Z", "2026-01-01T10:35:00Z")).toBe("35m");
    expect(openFor("2026-01-01T10:00:00Z", "2026-01-01T10:00:20Z")).toBe("<1m");
  });
  test("unreadable or backwards dates say nothing", () => {
    expect(openFor("", "2026-01-01T10:00:00Z")).toBe("");
    expect(openFor("2026-01-02T10:00:00Z", "2026-01-01T10:00:00Z")).toBe("");
  });
});

describe("the header", () => {
  test("merged: who, how, how long", () => {
    expect(closedHeader({ state: "MERGED", closed: facts() }, stamp)).toBe("Merged 2026-01-03 · by ada · squash · open for 2d 3h");
  });
  test("closed: says no merge once, and never repeats 'without merging'", () => {
    const h = closedHeader({ state: "CLOSED", closed: facts({ method: null, by: "grace" }) }, stamp);
    expect(h).toBe("Closed 2026-01-03 · by grace · no merge · open for 2d 3h");
    expect(h).not.toContain("without");
  });
  test("before the details arrive it is the bare word, never a placeholder", () => {
    expect(closedHeader({ state: "MERGED" }, stamp)).toBe("Merged");
    expect(closedHeader({ state: "CLOSED" }, stamp)).toBe("Closed");
    expect(closedHeader({ state: "OPEN" }, stamp)).toBe("");
  });
  test("a part GitHub did not say is left out", () => {
    expect(closedHeader({ state: "MERGED", closed: facts({ by: null, method: null }) }, stamp)).toBe("Merged 2026-01-03 · open for 2d 3h");
  });
});

describe("the indigo state", () => {
  test("merged and closed are told apart; open is neither", () => {
    expect(finishedKind({ state: "MERGED" })).toBe("merged");
    expect(finishedKind({ state: "CLOSED" })).toBe("closed");
    expect(finishedKind({ state: "OPEN" })).toBeNull();
  });
  test("the card header paints merged with the indigo token and closed grey", async () => {
    const src = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
    const at = src.indexOf("function cardVerdict(");
    const body = src.slice(at, src.indexOf("\n}\n", at));
    expect(body).toContain('merged ? "var(--merged)" : "var(--text3)"');
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    expect(css).toContain("--merged: #8b8fe8;");
  });
});

describe("the final checks", () => {
  test("green: passed over total, skipped aside", () => {
    expect(checksLine({ state: "MERGED" }, facts())).toEqual({ text: "74/75 checks passed", tone: "ok", detail: "1 skipped" });
  });
  test("red and merged: the count and up to two names", () => {
    const f = facts({ checks: { total: 5, success: 2, failure: 3, skipped: 0, failing: ["build", "lint", "types"] } });
    expect(checksLine({ state: "MERGED" }, f).text).toBe("3 checks failed: build, lint");
  });
  test("red and closed: 'failed at close'", () => {
    const f = facts({ checks: { total: 4, success: 1, failure: 3, skipped: 0, failing: ["build", "lint"] } });
    expect(checksLine({ state: "CLOSED" }, f)).toEqual({ text: "3 checks failed at close", tone: "ko", detail: "build, lint" });
  });
  test("none ran", () => {
    expect(checksLine({ state: "MERGED" }, facts({ checks: { total: 0, success: 0, failure: 0, skipped: 0, failing: [] } })).text).toBe("no checks");
  });
});

describe("size, reviews and the why", () => {
  test("size line keeps singulars", () => {
    expect(sizeLine({ additions: 271, deletions: 64, changedFiles: 11 }, facts())).toBe("+271 −64 · 11 files · 3 commits");
    expect(sizeLine({ additions: 1, deletions: 0, changedFiles: 1 }, facts({ commits: 1 }))).toBe("+1 −0 · 1 file · 1 commit");
  });
  test("reviews tail", () => {
    expect(reviewsTail(facts())).toBe("2 rounds · 9 comments");
    expect(reviewsTail(facts({ reviews: { approved: [], changes: [], rounds: 0, comments: 1 } }))).toBe("1 comment");
  });
  test("the why is one line, markdown stripped, #refs kept, cut with an ellipsis", () => {
    expect(whyLine("**Superseded** by #9\n\n```\nlog\n```")).toBe("Superseded by #9");
    const long = whyLine("word ".repeat(80), 40)!;
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("…")).toBe(true);
    expect(whyLine("   ")).toBeNull();
  });
});

describe("the details are asked for once", () => {
  const row = (number: number, over: Record<string, unknown> = {}) => ({ number, checksLoaded: true, state: "MERGED" as const, ...over });
  test("a finished row that is complete but lacks the facts is asked for", () => {
    expect(nextDetailBatch([row(1), row(2, { closed: facts() })], new Set())).toEqual([1]);
    expect(needsClosedFacts({ state: "MERGED" })).toBe(true);
    expect(needsClosedFacts({ state: "MERGED", closed: facts() })).toBe(false);
  });
  test("an open complete row is never asked for", () => {
    expect(nextDetailBatch([row(1, { state: "OPEN" })], new Set())).toEqual([]);
    expect(owesDetails({ checksLoaded: true, state: "OPEN" })).toBe(false);
  });
  test("typing asks for nothing: what was tried, or already holds its facts, is not asked again", () => {
    const rows = [row(1), row(2), row(3, { closed: facts() })];
    expect(nextDetailBatch(rows, new Set([1, 2]))).toEqual([]);
    expect(nextDetailBatch(rows.filter((r) => r.number === 3), new Set())).toEqual([]);
  });
  test("a page is one batch; the next page only brings its own numbers", () => {
    const page1 = Array.from({ length: 20 }, (_, i) => row(i + 1));
    const tried = new Set(nextDetailBatch(page1, new Set()));
    expect(tried.size).toBe(20);
    const both = [...page1, ...Array.from({ length: 20 }, (_, i) => row(i + 21))];
    expect(nextDetailBatch(both, tried)).toEqual(Array.from({ length: 20 }, (_, i) => i + 21));
  });
});
