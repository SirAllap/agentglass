import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Stale-while-revalidate, which is the whole shape of this cache.
 *
 * The rule it replaced was all-or-nothing: under a minute old, serve it; a
 * second past that, block the panel on a network read. Coming back to a board
 * after a few minutes therefore meant watching a spinner for rows already
 * sitting on disk — and, on the workspace-wide board, watching it for twelve
 * seconds.
 *
 * Every test here runs against a stub that COUNTS, because the thing worth
 * asserting is not only what comes back but how many requests it cost. That is
 * the number that gets an integration blocked.
 */
const dir = mkdtempSync(join(tmpdir(), "agx-swr-"));
const C = await import("../src/credentials.ts");
const V = await import("../src/clickupviews.ts");
const CU = await import("../src/clickup.ts");
const P = await import("../src/providers.ts");

let hits: string[] = [];
let reply: (req: Request) => Response;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    hits.push(new URL(req.url).pathname);
    return reply(req);
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "99", ...(init.headers ?? {}) },
    ...init,
  });

const TASK = {
  id: "abc", name: "A card", url: "https://example.invalid/t/abc",
  status: { status: "in development", type: "custom", orderindex: 5 },
  date_updated: "1754300000000", list: { id: "901700000001", name: "A list" },
  assignees: [{ id: 7, username: "Ada" }],
};

const VIEW_ID = "6-901700000001-1";
const answerEverything = () => (req: Request) => {
  const p = new URL(req.url).pathname;
  if (/\/view\/[^/]+\/task$/.test(p)) return json({ tasks: [TASK], last_page: true });
  if (/\/list\/[^/]+\/field$/.test(p)) return json({ fields: [] });
  if (/\/list\/[^/]+$/.test(p)) return json({ name: "A list", statuses: [{ status: "in development", type: "custom", orderindex: 5 }], space: { name: "A space" }, folder: { name: "A folder", hidden: false } });
  return json({});
};

/** Push the cached entry's clock back, which is the only thing "stale" means. */
function ageCacheBy(ms: number): void {
  const held = V.cachedFor(VIEW_ID)!;
  V.putCache({ ...held, at: held.at - ms });
}

/** The background refresh is deliberately not awaited by readView; a test that
 *  asserts on its result has to let it finish. */
const settle = () => new Promise((r) => setTimeout(r, 60));

beforeEach(async () => {
  hits = [];
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_X", accountId: "7", workspaceId: "9000001", verifiedAt: Date.now() });
  V.__setViewsPath(join(dir, "views.json"));
  V.__clear();
  CU.__setClickUpBase(BASE);
  P.__resetViewCache();
  reply = answerEverything();
  V.addView({ id: VIEW_ID, name: "A view", listId: "901700000001", url: "https://x.clickup.com/1/v/l/" + VIEW_ID, addedAt: 1 });
  // One real read, so every test below starts with something cached.
  await P.readView(VIEW_ID);
  hits = [];
});

afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  C.__setCredentialsPath(null);
  V.__setViewsPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("a cache that is still fresh", () => {
  it("answers without asking anybody", async () => {
    const r = await P.readView(VIEW_ID);
    expect(r.tasks.length).toBe(1);
    expect(r.revalidating).toBeUndefined();
    expect(hits).toEqual([]);
  });
});

describe("a cache that has gone stale", () => {
  it("shows what it has AT ONCE and mends it behind", async () => {
    ageCacheBy(90_000);
    const was = V.cachedFor(VIEW_ID)!.at;

    const r = await P.readView(VIEW_ID);
    // The point of the whole rewrite: rows now, not after a round trip.
    expect(r.tasks.length).toBe(1);
    expect(r.revalidating).toBe(true);

    await settle();
    expect(hits.some((p) => p.includes("/view/"))).toBe(true);
    expect(V.cachedFor(VIEW_ID)!.at).toBeGreaterThan(was);
  });

  it("does not start a second read while one is running", async () => {
    // Two windows, or a poll and a click. Either way it is one question.
    ageCacheBy(90_000);
    await Promise.all([P.readView(VIEW_ID), P.readView(VIEW_ID), P.readView(VIEW_ID)]);
    await settle();
    expect(hits.filter((p) => /\/view\/[^/]+\/task$/.test(p)).length).toBe(1);
  });

  it("keeps the old rows when the refresh fails", async () => {
    ageCacheBy(90_000);
    reply = () => json({ err: "nope" }, { status: 500 });
    const r = await P.readView(VIEW_ID);
    expect(r.tasks.length).toBe(1);   // never emptied
    await settle();
    expect(V.cachedFor(VIEW_ID)!.tasks.length).toBe(1);
  });
});

describe("after a failure", () => {
  it("rests instead of asking again on every look, and says why", async () => {
    ageCacheBy(90_000);
    reply = () => json({ err: "nope" }, { status: 500 });
    await P.readView(VIEW_ID);
    await settle();
    const afterFirst = hits.length;
    expect(afterFirst).toBeGreaterThan(0);

    // A revoked token or a service having a bad morning must not become a
    // request per glance — that is the shape that gets an integration blocked.
    const again = await P.readView(VIEW_ID);
    await settle();
    expect(hits.length).toBe(afterFirst);
    expect(again.revalidating).toBeUndefined();
    expect(again.error).toBeTruthy();
    expect(again.tasks.length).toBe(1);
  });

  it("tries again when a person presses Refresh", async () => {
    ageCacheBy(90_000);
    reply = () => json({ err: "nope" }, { status: 500 });
    await P.readView(VIEW_ID);
    await settle();
    const rested = hits.length;

    reply = answerEverything();
    const r = await P.readView(VIEW_ID, true);
    expect(hits.length).toBeGreaterThan(rested);
    expect(r.error).toBeUndefined();
    expect(r.tasks.length).toBe(1);
  });

  it("forgets the failure once a read succeeds", async () => {
    ageCacheBy(90_000);
    reply = () => json({ err: "nope" }, { status: 500 });
    await P.readView(VIEW_ID);
    await settle();

    reply = answerEverything();
    await P.readView(VIEW_ID, true);
    ageCacheBy(90_000);
    const r = await P.readView(VIEW_ID);
    expect(r.revalidating).toBe(true);   // resting was cleared
    await settle();
  });
});

describe("a board nobody has read yet", () => {
  it("waits, because there is nothing to show instead", async () => {
    V.__clear();
    V.addView({ id: VIEW_ID, name: "A view", listId: "901700000001", url: "u", addedAt: 1 });
    P.__resetViewCache();
    hits = [];
    const r = await P.readView(VIEW_ID);
    expect(r.tasks.length).toBe(1);
    expect(r.revalidating).toBeUndefined();
    expect(hits.some((p) => p.includes("/view/"))).toBe(true);
  });
});

describe("Refresh", () => {
  it("goes to the network even when the cache is young", async () => {
    const r = await P.readView(VIEW_ID, true);
    expect(hits.some((p) => /\/view\/[^/]+\/task$/.test(p))).toBe(true);
    expect(r.tasks.length).toBe(1);
  });
});

/*
 * Refresh has to actually try.
 *
 * Reported as a board that "never updates": the strip says nothing has been
 * read since yesterday, you press Refresh, you wait, and it says the same
 * thing again. The reason was the dedupe above — right for two windows asking
 * the same question, wrong when one of them is a person pressing a button to
 * get past a failure. A forced read that joins a background read in the air
 * inherits that read's answer, so it can never be the fresh attempt it was
 * pressed for.
 *
 * The built-in board is where it bites: its read takes twelve seconds and the
 * panel's settle loop asks every one and a half, so there is nearly always one
 * in the air to inherit.
 */
describe("pressing Refresh while a background read is in the air", () => {
  it("makes its own request instead of inheriting the one already running", async () => {
    ageCacheBy(90_000);
    /* The background read: slow, and it fails — the shape of the twelve-second
       workspace read timing out. */
    const gate: { release: (() => void) | null } = { release: null };
    reply = () => {
      const p = new Promise<void>((r) => { gate.release = r; });
      return new Response(new ReadableStream({
        async start(c) { await p; c.enqueue(new TextEncoder().encode("{\"err\":\"nope\"}")); c.close(); },
      }), { status: 500, headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" } });
    };
    const background = P.readView(VIEW_ID);              // not forced: the poll
    for (let i = 0; i < 50 && !gate.release; i++) await new Promise((r) => setTimeout(r, 10));

    // Now the workspace answers again, and somebody presses Refresh.
    reply = answerEverything();
    const before = hits.filter((p) => /\/view\/[^/]+\/task$/.test(p)).length;
    const forced = await P.readView(VIEW_ID, true);

    expect(hits.filter((p) => /\/view\/[^/]+\/task$/.test(p)).length,
      "Refresh must ask ClickUp itself").toBeGreaterThan(before);
    expect(forced.error, "and must not report the other read's failure").toBeUndefined();
    expect(forced.tasks.length).toBe(1);

    gate.release?.();
    await background;
    await settle();
  });

  it("but a second press still joins the first — that IS the fresh attempt", async () => {
    ageCacheBy(90_000);
    const [a, b] = await Promise.all([P.readView(VIEW_ID, true), P.readView(VIEW_ID, true)]);
    await settle();
    expect(hits.filter((p) => /\/view\/[^/]+\/task$/.test(p)).length).toBe(1);
    expect(a.tasks.length).toBe(1);
    expect(b.tasks.length).toBe(1);
  });
});
