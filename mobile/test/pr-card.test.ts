/*
 * What a pull request's card says: the banner, the CI bar, the card line, the
 * lookups' budget and the "All" count.
 *
 * Fixtures are the shape of a real list row with invented people (ada, bob, cy).
 */
import { describe, expect, test } from "bun:test";
import type { PrCheckRollup, PrSummary } from "../../shared/types.ts";
import type { ProviderTask } from "../../shared/providers.ts";
import {
  allCount, bannerLook, branchCell, CARD_FRESH_MS, cardFresh, cardState, changesShare, ciCount,
  ciSegments, eventLine, facesOf, MAX_SEGMENTS, reaskDoor, reviewCell, threadsLabel,
} from "../src/model/prCard.ts";
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
  test("an approval the code has outgrown is amber, in the desktop's words", () => {
    const stale = pr({ reviewDecision: "REVIEW_REQUIRED", humanReview: { kind: "approved", who: ["cy"], stale: true } });
    // The desktop's strip (web/src/lib/prCardView.ts:207) says this sentence for
    // a stale approval, amber or green; "out of date" was the phone's own.
    expect(look(stale)).toMatchObject({ label: "Approved · new commits since", tone: "warn" });
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

  test("a stale card is re-asked once, and a failure leaves the row's own copy drawn", async () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    const rowCard = { id: "abc123", customId: "ORBIT-1042", title: "Retry sync", status: "In review", priority: null, at: now - 24 * 60 * 60_000 } as const;
    let asks = 0;
    const l = createCardLookups({ where: async () => null, find: async () => { asks++; return { error: "nope" }; } });
    // Every paint of a stale row asks; the table must spend one request, not one
    // per render, or a board left open is a request every second.
    l.refresh("ORBIT-1042");
    l.refresh("ORBIT-1042");
    expect(asks).toBe(1);
    await tick();
    expect(cardState({ card: rowCard }, "ORBIT-1042", l.peek("ORBIT-1042"), now)).toEqual({ kind: "card", card: rowCard });
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

/*
 * The cells the board card draws. Each word is short because the tile is 111
 * wide, and each is decided from one fact so the card and the lane agree.
 */
describe("the board card's cells", () => {
  test("the run is a fraction while it goes, a count when it fails, and a fraction when it is done", () => {
    expect(ciCount(pr({ checks: checks({ total: 3, success: 2, pending: 1, allDone: false, verdict: null }) })))
      .toEqual({ word: "2/3", tone: "warn", pct: 67 });
    expect(ciCount(pr({ checks: checks({ total: 3, success: 2, failure: 1, verdict: "red" }) }))).toMatchObject({ word: "1 failing", tone: "bad" });
    expect(ciCount(pr({ checks: checks({ total: 4, success: 4 }) }))).toMatchObject({ word: "4/4", tone: "good", pct: 100 });
    // Still being read is not "no checks".
    expect(ciCount(pr({ checksLoaded: false }))).toMatchObject({ word: "…", tone: "neutral" });
  });

  test("review is a person's verdict, never a bot's", () => {
    expect(reviewCell(pr({ humanReview: { kind: "changes", who: ["bob"] } }), false)).toEqual({ word: "changes", tone: "bad" });
    expect(reviewCell(pr({ humanReview: { kind: "changes", who: ["bob"], cleared: true } }), false).tone).toBe("warn");
    expect(reviewCell(pr({ humanReview: { kind: "approved", who: ["cy"] } }), false)).toEqual({ word: "approved", tone: "good" });
    expect(reviewCell(pr({ humanReview: { kind: "approved", who: ["cy"], stale: true } }), false)).toMatchObject({ tone: "warn" });
    expect(reviewCell(pr({ humanReview: { kind: "awaiting", who: ["bob"] } }), true)).toEqual({ word: "1 waiting", tone: "warn" });
    expect(reviewCell(pr({ humanReview: null }), false)).toEqual({ word: "nobody asked", tone: "neutral" });
    expect(reviewCell(pr({ isDraft: true, humanReview: { kind: "changes", who: ["bob"] } }), false).word).toBe("draft");
  });

  test("the branch cell says only what a list row knows", () => {
    expect(branchCell(pr({ mergeable: "CONFLICTING" }))).toEqual({ word: "conflict", tone: "bad" });
    // An UNKNOWN merge state is not a claim of its own: the desktop draws
    // "checking" only while its compare is out (prCardView.ts:342,349).
    expect(branchCell(pr({ mergeable: "UNKNOWN" }), null, true)).toEqual({ word: "checking", tone: "neutral" });
    expect(branchCell(pr({ mergeable: "MERGEABLE" }))).toEqual({ word: "up to date", tone: "good" });
  });

  test("the event line says who moved it, and when", () => {
    const at = "2026-09-01T08:00:00Z";
    const now = Date.parse("2026-09-01T10:00:00Z");
    expect(eventLine(pr({ humanReview: { kind: "approved", who: ["cy"], at } }), now))
      .toEqual({ what: "Approved by cy", when: "2h" });
    expect(eventLine(pr({ humanReview: { kind: "changes", who: ["bob"], at, mine: true } }), now).what)
      .toBe("You asked for changes");
    expect(eventLine(pr({ humanReview: { kind: "awaiting", who: ["bob"] }, updatedAt: at }), now))
      .toEqual({ what: "Asked for a review", when: "2h" });
  });

  test("faces are people first, then whoever was asked, and never a team", () => {
    expect(facesOf(pr({
      humanReview: { kind: "approved", who: ["cy"], people: [{ login: "cy", state: "approved" }, { login: "platform", state: "await", team: true }] },
    }))).toEqual(["cy"]);
    expect(facesOf(pr({ reviewers: [{ login: "dee" }, { login: "core", isTeam: true }] }))).toEqual(["dee"]);
    expect(facesOf(pr({ reviewers: [] }))).toEqual([]);
  });

  test("the change bar is the green share of the diff", () => {
    expect(changesShare(pr({ additions: 168, deletions: 12 }))).toBeCloseTo(168 / 180, 5);
    expect(changesShare(pr({ additions: 0, deletions: 9 }))).toBe(0);
  });
});

/*
 * The branch word is the desktop's now: "no conflict" is not "0 behind", so the
 * count comes from the compare the card asks for, and an unknown count says so
 * rather than claiming the branch is current.
 */
describe("the branch word follows the compare", () => {
  test("checking while the count is out, and the count once it lands", () => {
    expect(branchCell(pr(), null, true)).toEqual({ word: "checking", tone: "neutral" });
    expect(branchCell(pr(), 0)).toEqual({ word: "up to date", tone: "good" });
    expect(branchCell(pr(), 1)).toEqual({ word: "1 behind", tone: "warn" });
    expect(branchCell(pr(), 19).tone).toBe("warn");
  });

  test("twenty behind is red, and a conflict wins whatever the count says", () => {
    expect(branchCell(pr(), 20)).toEqual({ word: "20 behind", tone: "bad" });
    expect(branchCell(pr({ mergeable: "CONFLICTING" }), 30, true)).toEqual({ word: "conflict", tone: "bad" });
  });

  /*
   * A compare that came back with nothing is not a branch that is current:
   * measured against a paired computer whose `gh` was not signed in, the card
   * printed "up to date" (green) for a branch 194 commits behind. "checking"
   * is the word the desktop uses while it has no count either.
   */
  test("a compare that failed is never drawn as up to date", () => {
    expect(branchCell(pr(), null, false, true)).toEqual({ word: "checking", tone: "neutral" });
    // And it still says nothing about a count it does not have.
    expect(branchCell(pr({ mergeable: "MERGEABLE" }), null, false, true).word).not.toBe("up to date");
  });

  /*
   * Finding: the same row read "checking" here and "up to date" on the desktop.
   * The desktop only speaks about a compare it has: UNKNOWN is its own answer
   * (prCardView.ts:349), and the conflict store says "checking" while it asks.
   */
  test("an UNKNOWN merge state with a settled compare reads as the desktop's", () => {
    expect(branchCell(pr({ mergeable: "UNKNOWN" }), null, false)).toEqual({ word: "up to date", tone: "good" });
    expect(branchCell(pr({ mergeable: "UNKNOWN" }), 0)).toEqual({ word: "up to date", tone: "good" });
    expect(branchCell(pr({ mergeable: "UNKNOWN" }), null, true)).toEqual({ word: "checking", tone: "neutral" });
  });
});

describe("an approval GitHub still counts", () => {
  test("a stale approval reads approved, because it still blocks nothing", () => {
    const stillCounts = pr({ reviewDecision: "APPROVED", humanReview: { kind: "approved", who: ["cy"], stale: true } });
    expect(reviewCell(stillCounts, false)).toEqual({ word: "approved", tone: "good" });
    // And one GitHub no longer counts keeps the amber word — the desktop's
    // word for it is "stale" (prCardView.ts:207), not "out of date".
    const moved = pr({ reviewDecision: "REVIEW_REQUIRED", humanReview: { kind: "approved", who: ["cy"], stale: true } });
    expect(reviewCell(moved, false)).toEqual({ word: "stale", tone: "warn" });
  });
});

/*
 * The row's tracker card comes off a board cached on disk and is accepted up to
 * a day old; the desktop re-asks the tracker for anything older than five
 * minutes, and this is the same line drawn here.
 */
describe("the linked card's freshness", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const card = (at?: number) => ({ id: "abc123", title: "Retry sync", status: "In review", priority: null, at });

  test("five minutes, and a copy with no reading time is not fresh", () => {
    expect(cardFresh(card(now - CARD_FRESH_MS + 1), now)).toBe(true);
    expect(cardFresh(card(now - CARD_FRESH_MS), now)).toBe(false);
    expect(cardFresh(card(undefined), now)).toBe(false);
    expect(cardFresh(undefined, now)).toBe(false);
  });

  test("a day-old copy is replaced by the tracker's answer; a young one is not", () => {
    const dayOld = pr({ card: card(now - 24 * 60 * 60_000) });
    const answered = { phase: "card", card: { ...card(now), status: "ready for qa" } } as const;
    expect(cardState(dayOld, "ORBIT-1042", answered, now)).toEqual({ kind: "card", card: answered.card });
    const young = pr({ card: card(now - 60_000) });
    expect(cardState(young, "ORBIT-1042", answered, now)).toMatchObject({ kind: "card", card: { status: "In review" } });
  });
});

/*
 * Which tracker a stale row is re-asked of. The desktop's rule
 * (web/src/lib/prCardStore.ts:278) is that a Jira card is never re-asked: its
 * status is read from the server's Jira views, and asking for the key can only
 * come back empty. The phone asked, so a board of twenty stale Jira cards spent
 * twenty `/jira/find` requests on open and twenty more on every pull.
 */
describe("re-asking a stale card", () => {
  const jira = { id: "j1", customId: "ORBIT-1042", title: "Retry sync", status: "In review", priority: null, tracker: "jira" as const };
  const clickup = { id: "abc123", customId: "ORBIT-1042", title: "Retry sync", status: "In review", priority: null };

  test("a stale Jira card is never re-asked, a stale ClickUp one is", () => {
    expect(reaskDoor(jira)).toBeNull();
    expect(reaskDoor(clickup)).toEqual({ tracker: "clickup", id: "ORBIT-1042" });
  });

  test("a fresh card is not re-asked, and a card with no id has nothing to ask", () => {
    expect(reaskDoor({ ...clickup, at: 1 }, 1)).toBeNull();
    expect(reaskDoor({ ...clickup, customId: undefined, id: "" })).toBeNull();
    expect(reaskDoor(undefined)).toBeNull();
  });
});

describe("a red check takes its verdict from the shared merge rules", () => {
  const red = (required: boolean | undefined) => pr({ checks: checks({ total: 4, success: 3, failure: 1, verdict: "red", failing: [{ name: "lint", state: "failure", required } as never] }) });
  test("a required red check blocks: bad, banner says failing", () => {
    expect(ciCount(red(true))).toMatchObject({ word: "1 failing", tone: "bad" });
    expect(look(red(true)).label).toBe("Checks failing");
  });
  test("a red check GitHub does not require is amber, not a block", () => {
    expect(ciCount(red(false))).toMatchObject({ word: "1 red · optional", tone: "warn" });
    expect(look(red(false)).label).not.toBe("Checks failing");
  });
  test("unknown requirement or unnamed red checks stay red", () => {
    expect(ciCount(red(undefined)).tone).toBe("bad");
    expect(ciCount(pr({ checks: checks({ total: 4, success: 3, failure: 1, verdict: "red" }) })).tone).toBe("bad");
  });
});
