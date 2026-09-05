/*
 * A read that came up short must not pass for a complete one.
 *
 * Two places had the same shape, and it is the shape that hides: the answer
 * looks exactly like a legitimate small answer. Nobody notices, because
 * "nothing found" reads as "nothing exists" rather than "I only looked at part
 * of it". The same class as the sweep that spent months reading the OLDEST
 * three hundred cards of a workspace because `reverse: "true"` means the
 * opposite of what it reads like.
 *
 * ONE — THE NOTIFICATION POLL. `changedForMe` and `changedOnLists` asked for
 * one page. ClickUp answers 100 rows a page and says nothing about how many
 * there are. Measured against the real workspace, over the 17 lists behind the
 * saved boards:
 *
 *     changed in 1h       5
 *     changed in 24h     32
 *     changed in 7 days  100 on page 0  +  78 on page 1
 *
 * The window is "since I last looked", so a day is comfortable and a weekend
 * away is not. Before this, the poll read the first 100 of those 178, ADVANCED
 * ITS HIGH-WATER MARK PAST ALL OF THEM, and the other 78 were never reported —
 * silently, and permanently, because nothing looks at that window again.
 *
 * The cruel part is that the code already had the rule for the case next door:
 * "A failed read must not move the high-water mark: the changes it did not see
 * are still changes." A read that came back SHORT is the same fact wearing a
 * success, and it moved the mark.
 *
 * TWO — THE WORKSPACE SWEEP. Its comment says a page that fails when others
 * worked is "a partial search that says so". Nothing said so: the result was
 * indistinguishable from a complete one and was cached as complete for ten
 * minutes, so one slow page decided what the whole workspace contained until
 * the cache expired.
 *
 * These bite by EFFECT — what is stored, and what the caller is told.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-trunc-"));
const C = await import("../src/credentials.ts");
const CU = await import("../src/clickup.ts");
const W = await import("../src/clickupwatch.ts");
const V = await import("../src/clickupviews.ts");

let asked: string[] = [];
/** One entry per page index; anything past the end answers empty. */
let pages: Record<string, unknown>[][] = [];
/** Page indexes that should fail rather than answer. */
let failPages = new Set<number>();

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    asked.push(u.pathname + u.search);
    const page = Number(u.searchParams.get("page") ?? "0");
    if (failPages.has(page)) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ tasks: pages[page] ?? [] }), {
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" },
    });
  },
});

const raw = (i: number) => ({
  id: `t${i}`, custom_id: `ORBIT-${1000 + i}`, name: `Card ${i}`,
  url: "https://example.invalid/t/x", status: { status: "open", type: "custom" },
  date_updated: "1754300000000", list: { name: "Miscellaneous" }, assignees: [], tags: [],
});
/** A full page. ClickUp's page size is 100 and it never says so in the body,
 *  which is why the code compares against it rather than reading a total. */
const fullPage = (from: number) => Array.from({ length: 100 }, (_u, i) => raw(from + i));

const WATCH = join(dir, "watch.json");
const readWatch = () => JSON.parse(readFileSync(WATCH, "utf8")) as { at: number; seen: Record<string, unknown> };

beforeEach(() => {
  asked = []; pages = []; failPages = new Set();
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_X", accountId: "7", workspaceId: "9001" });
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
  CU.__clearSearchCache();
  V.__setViewsPath(join(dir, "views.json"));
  W.__setWatchPath(WATCH);
});
afterEach(() => { CU.__reset(); CU.__clearSearchCache(); W.__setWatchPath(null); });
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  C.__setCredentialsPath(null);
  V.__setViewsPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("reading what changed", () => {
  test("walks past the first page instead of stopping at 100", async () => {
    pages = [fullPage(0), [raw(500)]];
    const r = await CU.changedForMe(1);
    expect(r.ok).toBe(true);
    expect(r.data?.tasks.length, "101, not 100").toBe(101);
    expect(r.data?.truncated).toBe(false);
  });

  test("a short page ends it — no request nobody needed", async () => {
    pages = [[raw(1), raw(2)]];
    await CU.changedForMe(1);
    expect(asked.length, "one page asked for").toBe(1);
  });

  test("and it says so when it runs out of pages before it runs out of cards", async () => {
    // Every page full to the cap: there is very likely more behind it, and
    // this is the case the caller must not read as "I have seen everything".
    pages = [fullPage(0), fullPage(100), fullPage(200), fullPage(300), fullPage(400)];
    const r = await CU.changedForMe(1);
    expect(r.data?.truncated, "ran out of room").toBe(true);
  });

  test("a page that fails after others worked is short, not empty", async () => {
    // The difference between a search and a diff. A search that misses a card
    // is a search you run again; a diff that misses one moves the mark past it.
    pages = [fullPage(0), fullPage(100)];
    failPages = new Set([1]);
    const r = await CU.changedForMe(1);
    expect(r.ok).toBe(true);
    expect(r.data?.tasks.length).toBe(100);
    expect(r.data?.truncated).toBe(true);
  });

  test("and a first page that fails is still a failure", async () => {
    failPages = new Set([0]);
    const r = await CU.changedForMe(1);
    expect(r.ok).toBe(false);
  });
});

describe("the high-water mark", () => {
  /** A reader standing in for ClickUp, so the poll can be driven exactly. */
  const reader = (tasks: unknown[], truncated: boolean) =>
    async () => ({ ok: true, data: { tasks: tasks as never, truncated } });

  test("moves when the read was whole", async () => {
    W.__setCardReader(reader([], false));
    W.__setBoardReader(reader([], false));
    await W.pollCards(1_000_000);
    expect(readWatch().at).toBe(1_000_000);
    await W.pollCards(2_000_000);
    expect(readWatch().at).toBe(2_000_000);
    W.__setCardReader(null); W.__setBoardReader(null);
  });

  test("and STAYS PUT when it was short", async () => {
    // The whole bug in one assertion. Advancing here is what made 78 changes
    // unreachable: the next poll asks for a window that starts after them.
    W.__setCardReader(reader([], false));
    W.__setBoardReader(reader([], false));
    await W.pollCards(1_000_000);
    expect(readWatch().at).toBe(1_000_000);

    W.__setCardReader(reader([], true));
    await W.pollCards(9_000_000);
    expect(readWatch().at, "the window still covers what was not read").toBe(1_000_000);
    W.__setCardReader(null); W.__setBoardReader(null);
  });

  test("a short read on the BOARDS half holds it too", async () => {
    // Two reads feed one mark. Either coming up short means the window is not
    // finished, whichever it was.
    W.__setCardReader(reader([], false));
    W.__setBoardReader(reader([], false));
    await W.pollCards(1_000_000);
    W.__setBoardReader(reader([], true));
    await W.pollCards(9_000_000);
    expect(readWatch().at).toBe(1_000_000);
    W.__setCardReader(null); W.__setBoardReader(null);
  });
});

describe("a sweep that lost a page", () => {
  test("says it is partial rather than looking small", async () => {
    pages = [fullPage(0), fullPage(100), fullPage(200)];
    failPages = new Set([2]);
    const r = await CU.searchTasks("Card");
    expect(r.ok).toBe(true);
    expect(r.data?.partial, "the caller is told").toBe(true);
  });

  test("and a whole one says nothing at all", async () => {
    // Absent rather than false: a caveat that is always present stops being
    // read, and every other surface would have to learn to ignore it.
    pages = [[raw(1)]];
    const r = await CU.searchTasks("Card");
    expect(r.data && "partial" in r.data).toBe(false);
  });

  test("is not held for the full ten minutes", async () => {
    // Cached as complete, one slow page decided what the workspace contained
    // until the next coffee. Held long enough that three questions in a row
    // are one fetch, and no longer.
    pages = [fullPage(0), fullPage(100), fullPage(200)];
    failPages = new Set([2]);
    await CU.searchTasks("Card");
    const first = asked.length;
    await CU.searchTasks("Card");
    expect(asked.length, "the second question is still served from cache").toBe(first);
  });
});

/*
 * A cap that bites has to say so, and say it in something a reader can use.
 *
 * `SWEEP_PAGES = 3` is 300 cards. 300 cards is not an amount of workspace — it
 * is an amount of TIME, and how much depends entirely on how busy the place
 * is. Measured against the real workspace on 2026-09-01 by walking the pages
 * by hand:
 *
 *     page 0..7     100 rows each, still full at page 7  -> more than 800 cards
 *     the newest card                    updated today
 *     the 300th, where the sweep stops   updated THE SAME DAY
 *     the 800th                          updated yesterday
 *
 * So on that workspace "search the workspace" means "search what was touched
 * today", and it answered `Nothing in the last 300 cards matches "x"` — which
 * reads as "it does not exist". The cap was never the problem on its own; the
 * problem was a sentence that could not be told apart from an empty result.
 *
 * The sweep now records how far back it reached and whether it stopped because
 * it ran out of cards or out of pages, and the answer carries both. The panel
 * turns the timestamp into words, because nobody can convert 300 cards into
 * "did it look at last week".
 */
describe("how far the sweep reached", () => {
  const dated = (i: number, ms: number) => ({ ...raw(i), date_updated: String(ms) });

  test("says the oldest card it saw, so the window can be named", async () => {
    const t0 = 1_700_000_000_000;
    pages = [[dated(1, t0 + 5000), dated(2, t0)]];
    const r = await CU.searchTasks("Card");
    expect(r.data?.since).toBe(t0);
  });

  test("and says the cap bit when the last page came back full", async () => {
    // Full to the end means there is more behind it. This is the case his
    // workspace is in every single time.
    pages = [fullPage(0), fullPage(100), fullPage(200)];
    const r = await CU.searchTasks("Card");
    expect(r.data?.capped, "ran out of pages, not of cards").toBe(true);
  });

  test("a short last page is the workspace ending, not the cap", async () => {
    pages = [fullPage(0), [raw(1)]];
    const r = await CU.searchTasks("Card");
    expect(r.data?.capped).toBe(false);
  });

  test("the reach survives the cache, or the second question lies", async () => {
    // A cached sweep answers without fetching; if it forgot how far it reached,
    // every question after the first would claim to have searched everything.
    pages = [fullPage(0), fullPage(100), fullPage(200)];
    await CU.searchTasks("Card");
    const before = asked.length;
    const again = await CU.searchTasks("Card");
    expect(asked.length, "served from cache").toBe(before);
    expect(again.data?.capped).toBe(true);
    expect(again.data?.since).toBeGreaterThan(0);
  });
});

describe("the list of matches", () => {
  test("says when it stopped at sixty", async () => {
    // A list that stops at sixty without saying so is a list that claims there
    // were sixty.
    pages = [Array.from({ length: 70 }, (_u, i) => raw(i))];
    const r = await CU.searchTasks("Card");
    expect(r.data?.tasks.length).toBe(60);
    expect(r.data?.more).toBe(true);
  });

  test("and says nothing when it did not", async () => {
    // Absent rather than false: a flag that is always there stops being read.
    pages = [[raw(1), raw(2)]];
    const r = await CU.searchTasks("Card");
    expect(r.data && "more" in r.data).toBe(false);
  });
});
