/*
 * What a pull request's card says: the banner, the CI bar, the card line, the
 * lookups' budget and the "All" count.
 *
 * Fixtures are the shape of a real list row with invented people (ada, bob, cy).
 */
import { describe, expect, test } from "bun:test";
import type { PrCheckRollup, PrSummary } from "../../shared/types.ts";
import type { ProviderTask } from "../../shared/providers.ts";
import { allCount, bannerLook, cardState, ciSegments, MAX_SEGMENTS, threadsLabel } from "../src/model/prCard.ts";
import { createCardLookups } from "../src/model/cardLookup.ts";

const checks = (over: Partial<PrCheckRollup> = {}): PrCheckRollup => ({
  total: 4, success: 4, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [], ...over,
});

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 101, title: "Add retry to sync", author: "ada", state: "OPEN", isDraft: false,
  headRefName: "orbit-1042-retry", baseRefName: "main", url: "", updatedAt: "2026-09-01T10:00:00Z",
  reviewDecision: "REVIEW_REQUIRED", additions: 59, deletions: 2, changedFiles: 3, labels: [], assignees: [],
  milestone: null, checksLoaded: true, mergeable: "MERGEABLE", checks: checks(),
  ...over,
} as PrSummary);

const look = (p: PrSummary, o: { forMe?: boolean; unread?: number } = {}) => bannerLook(p, { forMe: false, ...o });

describe("the banner is the humans' verdict", () => {
  /* `reviewDecision: "APPROVED"` because a bot approved it, while the only
   * human asked for changes: the list said "Approved". */
  test("a bot's approval never paints green", () => {
    const botOnly = pr({ reviewDecision: "APPROVED", humanReview: null });
    expect(look(botOnly).tone).not.toBe("good");
    expect(look(botOnly)).toMatchObject({ label: "Needs review", tone: "neutral" });
    const blocked = pr({ reviewDecision: "APPROVED", humanReview: { kind: "changes", who: ["bob"] }, openThreads: { open: 1, more: false } });
    expect(look(blocked)).toEqual({ label: "Changes requested by bob", tone: "bad", right: "1 open thread" });
  });
  test("a person's approval is green and says whether it can land", () => {
    const ok = pr({ reviewDecision: "APPROVED", humanReview: { kind: "approved", who: ["cy"] } });
    expect(look(ok)).toEqual({ label: "Approved by cy", tone: "good", right: "ready to land" });
    expect(look({ ...ok, mergeable: "CONFLICTING" }).right).toBeNull();
    expect(look({ ...ok, checks: checks({ pending: 2, success: 2, allDone: false, verdict: null }) }).right).toBeNull();
  });
  test("red CI outranks an approval, and a block outranks red CI", () => {
    const red = checks({ failure: 1, success: 3, verdict: "red" });
    const approved = pr({ checks: red, humanReview: { kind: "approved", who: ["cy"] } });
    expect(look(approved)).toEqual({ label: "Checks failing", tone: "bad", right: "1 of 4" });
    expect(look({ ...approved, humanReview: { kind: "changes", who: ["bob"] } }).label).toBe("Changes requested by bob");
  });
  test("an approval the code has outgrown is amber", () => {
    const stale = pr({ reviewDecision: "REVIEW_REQUIRED", humanReview: { kind: "approved", who: ["cy"], stale: true } });
    expect(look(stale)).toMatchObject({ label: "Approval out of date", tone: "warn" });
  });
  test("a draft is nobody's problem, whatever else is true", () => {
    expect(look(pr({ isDraft: true, checks: checks({ failure: 1, verdict: "red" }) }))).toMatchObject({ label: "Draft", tone: "neutral" });
  });
  test("waiting: on you when it is yours to do, on somebody else when it is not", () => {
    const waiting = pr({ humanReview: { kind: "awaiting", who: ["bob", "cy", "dee"] } });
    expect(look(waiting, { forMe: true })).toMatchObject({ label: "Waiting on you", tone: "warn" });
    expect(look(waiting)).toMatchObject({ label: "Waiting on bob, cy and 1 more", tone: "neutral" });
    expect(look(pr({ humanReview: { kind: "awaiting", who: ["bob"], mine: true } })).label).toBe("Waiting on you");
    expect(look(pr({ humanReview: { kind: "changes", who: ["bob"], askedAgain: true, cleared: true } })).tone).toBe("warn");
  });
  test("asked again, and how many new things since you looked", () => {
    const again = pr({ humanReview: { kind: "commented", who: ["bob"], askedAgain: true } });
    expect(look(again, { unread: 2 })).toEqual({ label: "Asked to look again", tone: "warn", right: "2 new" });
  });
  test("still being read is not a claim", () => {
    expect(look(pr({ reviewDecision: "APPROVED", checksLoaded: false, humanReview: undefined })).label).toBe("Reading review…");
  });
  test("threads are said once", () => {
    expect(threadsLabel(pr({ openThreads: { open: 3, more: false } }))).toBe("3 open threads");
    expect(threadsLabel(pr({ openThreads: { open: 100, more: true } }))).toBe("100+ open threads");
    expect(threadsLabel(pr({ openThreads: { open: 0, more: false } }))).toBeNull();
  });
});

describe("the CI bar", () => {
  test("one segment per check, passed then failed then running", () => {
    expect(ciSegments(pr({ checks: checks({ total: 5, success: 3, failure: 1, pending: 1, verdict: null, allDone: false }) })))
      .toEqual(["ok", "ok", "ok", "fail", "run"]);
  });
  test("skipped is not a problem", () => {
    expect(ciSegments(pr({ checks: checks({ total: 3, success: 1, skipped: 2 }) }))).toEqual(["ok", "ok", "ok"]);
  });
  test("sixty checks scale down and one failure survives", () => {
    const segs = ciSegments(pr({ checks: checks({ total: 60, success: 59, failure: 1, verdict: "red" }) }))!;
    expect(segs.length).toBe(MAX_SEGMENTS);
    expect(segs.filter((s) => s === "fail").length).toBe(1);
  });
  test("not read and no checks are an empty track, not a green one", () => {
    expect(ciSegments(pr({ checksLoaded: false }))).toBeNull();
    expect(ciSegments(pr({ checks: checks({ total: 0, success: 0, verdict: null }) }))).toBeNull();
  });
});

const task = (over: Partial<ProviderTask> = {}): ProviderTask => ({
  id: "abc123", customId: "ORBIT-1042", title: "Retry sync", url: "", status: "In review", statusKind: "open",
  priority: null, due: null, updated: 0, tags: [],
  people: [1, 2, 3, 4].map((i) => ({ id: i, name: `p${i}`, initials: `P${i}` })),
  ...over,
} as ProviderTask);

describe("the card line", () => {
  test("the row's own card is free and wins", () => {
    const card = { id: "x", status: "Done", title: "t", priority: null } as NonNullable<PrSummary["card"]>;
    expect(cardState({ card }, "ORBIT-1042", { phase: "missed" })).toEqual({ kind: "card", card });
  });
  test("no card named, or no tracker: nothing to ask", () => {
    expect(cardState({}, null, null)).toEqual({ kind: "none" });
  });
  test("while the free lookup is out it is a skeleton, then a look-up offer, never a request", () => {
    expect(cardState({}, "ORBIT-1042", null).kind).toBe("asking");
    expect(cardState({}, "ORBIT-1042", { phase: "where" }).kind).toBe("asking");
    expect(cardState({}, "ORBIT-1042", { phase: "missed" })).toEqual({ kind: "look", query: "ORBIT-1042" });
    expect(cardState({}, "ORBIT-1042", { phase: "failed" }).kind).toBe("missed");
  });
});

/** Answers held until the test lets them go, so "in flight" can be counted. */
function gate() {
  const open: (() => void)[] = [];
  let inFlight = 0;
  let peak = 0;
  const wait = <T>(v: T): Promise<T> => {
    inFlight++; peak = Math.max(peak, inFlight);
    return new Promise((res) => { open.push(() => { inFlight--; res(v); }); });
  };
  return { wait, open, peak: () => peak };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("the lookups' budget", () => {
  test("a screen of misses offers find and makes none; each tap makes one, two at a time", async () => {
    const w = gate(); const f = gate();
    let wheres = 0; let finds = 0;
    const l = createCardLookups({
      where: async (id) => { wheres++; return id === "HIT-1" ? task() : (await w.wait(null)); },
      find: async () => { finds++; return f.wait({ task: task() }); },
    });
    const ids = Array.from({ length: 8 }, (_, i) => `ORBIT-${i}`);
    for (const id of ids) l.where(id);
    l.where("ORBIT-0"); // asked twice, one lookup
    expect(wheres).toBe(4);
    while (w.open.length) { w.open.shift()!(); await tick(); }
    for (let i = 0; i < 4; i++) { await tick(); while (w.open.length) { w.open.shift()!(); await tick(); } }
    expect(wheres).toBe(8);
    expect(finds).toBe(0);
    expect(ids.every((id) => l.peek(id)?.phase === "missed")).toBe(true);
    for (const id of ids) l.find(id);
    await tick();
    expect(finds).toBe(2); // ClickUp's budget is a number, not whatever the constant says
    while (f.open.length) { f.open.shift()!(); await tick(); }
    await tick();
    expect(finds).toBe(8);
    expect(f.peak()).toBe(2);
    expect(l.peek("ORBIT-3")?.phase).toBe("card");
  });
  test("find on an id the boards never missed is ignored", () => {
    let finds = 0;
    const l = createCardLookups({ where: () => new Promise(() => {}), find: async () => { finds++; return {}; } });
    l.find("ORBIT-9");
    l.where("ORBIT-9");
    l.find("ORBIT-9"); // still asking where
    expect(finds).toBe(0);
  });
  test("a card comes back with at most three faces, and a failed find can be tried again", async () => {
    let n = 0;
    const l = createCardLookups({ where: async () => null, find: async () => (++n === 1 ? { error: "nope" } : { task: task() }) });
    l.where("ORBIT-1042"); await tick();
    l.find("ORBIT-1042"); await tick();
    expect(l.peek("ORBIT-1042")?.phase).toBe("failed");
    l.find("ORBIT-1042"); await tick();
    const got = l.peek("ORBIT-1042");
    expect(got?.phase === "card" && got.card.people?.length).toBe(3);
  });
});

describe("the All count", () => {
  test("from the server's totals when every repository gave one", () => {
    expect(allCount([{ items: [1], total: 9, hasNext: true }, { items: [1, 2], total: 4 }])).toBe(13);
  });
  test("from the rows loaded when nothing is left to load, and silent when something is", () => {
    expect(allCount([{ items: [1, 2, 3] }, { items: [1] }])).toBe(4);
    expect(allCount([{ items: [1, 2, 3], hasNext: true }])).toBeNull();
    expect(allCount([])).toBeNull();
  });
});
