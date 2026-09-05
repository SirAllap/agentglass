/*
 * Searching a card id finds the card AND who points at it — and pays for the
 * bodies only when it has to.
 *
 * Reported with a real pair: ORBIT-2077's body links ORBIT-1042 in a sentence
 * under "How this was found", and searching `1042` found only ORBIT-1042
 * itself. Three separate things stopped it, and this file is about the two on
 * the server: `matchesText` reads the title, the ids and the list and never
 * the body, and the sweep did not fetch the body at all — so even changing the
 * matcher would have had nothing to read.
 *
 * The cost is the reason for the branch, and it is measured rather than
 * assumed: the sweep is sixteen seconds for the first page on a real
 * workspace WITHOUT bodies, and `include_markdown_description=true` makes
 * every page considerably larger. A search for "pagination arrows" gains
 * nothing from bodies, so it must not pay for them — which is exactly what
 * these assert, by watching what is asked of ClickUp.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-search-refs-"));
const C = await import("../src/credentials.ts");
const CU = await import("../src/clickup.ts");

let asked: string[] = [];
let pages: Record<string, unknown>[][] = [];

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    asked.push(u.pathname + u.search);
    const page = Number(u.searchParams.get("page") ?? "0");
    return new Response(JSON.stringify({ tasks: pages[page] ?? [] }), {
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" },
    });
  },
});

const raw = (over: Record<string, unknown>) => ({
  id: "t1", name: "A card", url: "https://example.invalid/t/t1",
  status: { status: "open", type: "custom" }, date_updated: "1754300000000",
  list: { name: "Miscellaneous" }, assignees: [], tags: [],
  ...over,
});

beforeEach(() => {
  asked = [];
  pages = [];
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_X", accountId: "7", workspaceId: "9001" });
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
  CU.__clearSearchCache();
});
afterEach(() => { CU.__reset(); CU.__clearSearchCache(); });
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  C.__setCredentialsPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

/** The pair from the report, in ClickUp's own shape. */
const THE_CARD = raw({
  id: "c1042", custom_id: "ORBIT-1042",
  name: "OC | Dashboard Erroring When Selecting Go To Last Button",
});
const THE_REFERRER = raw({
  id: "c2077", custom_id: "ORBIT-2077",
  name: "Scheduler | Pagination Arrows Always Behave As If You Were On Page 1",
  markdown_description:
    "While fixing the pagination bug on the OC dashboard (ORBIT-1042) and sweeping\n"
    + "the product for other paginated screens. It is a different defect.",
});
const A_STRANGER = raw({
  id: "cX", custom_id: "ORBIT-4001", name: "Unrelated",
  markdown_description: "the sweep scanned 1042 rows and hash 3f1042ab",
});

describe("searching a card id", () => {
  test("brings the card and the cards that refer to it", async () => {
    pages = [[THE_CARD, THE_REFERRER, A_STRANGER]];
    const r = await CU.searchTasks("1042");
    expect(r.ok).toBe(true);
    const ids = (r.data?.tasks ?? []).map((t) => t.customId);
    expect(ids).toEqual(["ORBIT-1042", "ORBIT-2077"]);
    // The card first: both are answers to "1042", and only one of them IS it.
    expect(r.data?.refs).toBe(1);
  });

  test("the prefixed form finds the same thing", async () => {
    pages = [[THE_CARD, THE_REFERRER, A_STRANGER]];
    const r = await CU.searchTasks("ORBIT-1042");
    expect((r.data?.tasks ?? []).map((t) => t.customId)).toEqual(["ORBIT-1042", "ORBIT-2077"]);
  });

  test("and a body that merely contains the digits is not a reference", async () => {
    // A_STRANGER's body has `1042` twice, in a count and in a hash. This is
    // the assertion that keeps the feature from being noise.
    pages = [[A_STRANGER]];
    const r = await CU.searchTasks("1042");
    expect(r.data?.tasks ?? []).toEqual([]);
  });

  test("bodies never reach the caller", async () => {
    // They are fetched to be matched here and dropped: the panel gets cards,
    // and a card description is a lot of text to put on a wire for nothing.
    pages = [[THE_REFERRER]];
    const r = await CU.searchTasks("1042");
    const first = (r.data?.tasks ?? [])[0] as unknown as Record<string, unknown> | undefined;
    expect(first && "body" in first).toBe(false);
  });
});

describe("what it asks ClickUp for", () => {
  test("an id query asks for the descriptions", async () => {
    pages = [[THE_CARD]];
    await CU.searchTasks("1042");
    expect(asked.some((p) => p.includes("include_markdown_description=true"))).toBe(true);
  });

  test("a text query does NOT — that is the sixteen seconds", async () => {
    pages = [[THE_CARD]];
    await CU.searchTasks("pagination arrows");
    expect(asked.some((p) => p.includes("include_markdown_description"))).toBe(false);
  });

  test("and the two caches do not evict each other", async () => {
    /*
     * One slot would mean an id search leaves bodies behind that the next text
     * search throws away, or a text search leaves a body-less sweep that the
     * next id search cannot use — either way the expensive call is made twice
     * for work already done.
     */
    pages = [[THE_CARD, THE_REFERRER]];
    await CU.searchTasks("1042");            // fills the with-bodies cache
    await CU.searchTasks("pagination");      // fills the plain one
    const before = asked.length;
    await CU.searchTasks("1042");            // must be served from cache
    await CU.searchTasks("pagination");      // and so must this
    expect(asked.length, "nothing more was fetched").toBe(before);
  });
});

/*
 * THE END OF THE WORKSPACE IT SEARCHES.
 *
 * The sweep asked for `order_by=updated&reverse=true`, which reads like
 * "newest first" and is the opposite. Measured against the real workspace on
 * 2026-09-01: with `reverse`, page 0 opened on a card last touched in June
 * 2022, so three pages covered the three hundred OLDEST cards of a workspace
 * with thousands — records nobody had opened in four years. Without it, page 0
 * opened on a card updated that morning.
 *
 * Every workspace search here had been reading the wrong end. It surfaced when
 * a search for a card id came back empty while thirty-eight cards carried that
 * id: not one of them was inside the slice being swept.
 */
test("the sweep asks for the most recently updated cards, not the oldest", async () => {
  pages = [[]];
  await CU.searchTasks("something nobody has", true);

  expect(asked.length).toBeGreaterThan(0);
  expect(asked[0]).toContain("order_by=updated");
  expect(asked[0], "reverse=true is the OLDEST cards — this searched an archive").not.toContain("reverse");
});
