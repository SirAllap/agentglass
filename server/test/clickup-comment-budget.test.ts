/*
 * What one look at a board costs ClickUp, and what one card costs the PR board.
 *
 * Measured against a mock of a 250-card list: first sight of the board fired
 * 250 comment reads (ClickUp puts no count on a task), which is the whole
 * minute of the workspace's rate limit, and the PR board's card chips fired
 * one read per distinct card on every draw. These bite by EFFECT: the requests
 * that leave the process.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderTask } from "../../shared/providers.ts";
import * as CU from "../src/clickup.ts";
import * as C from "../src/credentials.ts";
import * as CV from "../src/clickupviews.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cu-budget-"));
let seen: { method: string; path: string }[] = [];
let failTasks = false;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    seen.push({ method: req.method, path: u.pathname });
    await new Promise((r) => setTimeout(r, 5));
    if (failTasks && /^\/task\/[^/]+$/.test(u.pathname) && req.method === "GET") return new Response("no", { status: 500 });
    const m = u.pathname.match(/^\/task\/([^/]+)\/comment$/);
    if (m) return ok({ comments: [{ id: "c1" }] });
    const t = u.pathname.match(/^\/task\/([^/]+)$/);
    if (t) return ok({ id: t[1], custom_id: "ORBIT-1042", name: "A card", status: { status: "open", type: "open" }, date_updated: "1754300000000", assignees: [], tags: [] });
    return ok({});
  },
});
const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" } });
const count = (re: RegExp) => seen.filter((s) => s.method === "GET" && re.test(s.path)).length;
const card = (i: number, done = false): ProviderTask => ({
  id: `t${i}`, title: `Card ${i}`, url: "", status: done ? "completed" : "open", statusKind: done ? "done" : "open",
  priority: null, due: null, updated: 1754300000000 + i, tags: [], list: null, assignees: [],
}) as ProviderTask;
const board = (n: number, doneFrom = n) => Array.from({ length: n }, (_u, i) => card(i, i >= doneFrom));

beforeEach(() => {
  seen = []; failTasks = false;
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_TEST", accountId: "7", workspaceId: "9001" });
  CV.__setViewsPath(join(dir, "views.json"));
  CV.setWritesAllowed(true);
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
  CU.__clearFindCache();
});
afterEach(() => { CU.__reset(); });
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  C.__setCredentialsPath(null);
  CV.__setViewsPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("comment counts", () => {
  test("first sight of 250 cards asks for a bounded number, not 250", async () => {
    await CU.refreshCommentCounts(board(250).map((t, i) => ({ ...t, id: `a${i}` })), "pk");
    expect(count(/\/comment$/)).toBe(CU.COUNT_BUDGET);
  });

  test("open cards are counted before closed ones", async () => {
    // 50 done cards first in board order, then 10 open ones.
    const tasks = Array.from({ length: 60 }, (_u, i) => ({ ...card(i, i < 50), id: `b${i}` }));
    await CU.refreshCommentCounts(tasks, "pk");
    const asked = new Set(seen.map((s) => s.path.split("/")[2]));
    for (let i = 50; i < 60; i++) expect(asked.has(`b${i}`), `open card b${i}`).toBe(true);
    expect(asked.size).toBe(CU.COUNT_BUDGET);
  });

  test("later passes finish the board, and no card is asked twice", async () => {
    const tasks = board(70).map((t, i) => ({ ...t, id: `c${i}` }));
    await CU.refreshCommentCounts(tasks, "pk");
    await CU.refreshCommentCounts(tasks, "pk");
    await CU.refreshCommentCounts(tasks, "pk");
    await CU.refreshCommentCounts(tasks, "pk");
    expect(count(/\/comment$/), "70 cards, 70 reads, ever").toBe(70);
    expect(CU.applyCommentCounts(tasks).every((t: { comments?: number }) => t.comments === 1)).toBe(true);
  });

  test("two overlapping passes share one request per card", async () => {
    const tasks = board(20).map((t, i) => ({ ...t, id: `d${i}` }));
    await Promise.all([CU.refreshCommentCounts(tasks, "pk"), CU.refreshCommentCounts(tasks, "pk")]);
    expect(count(/\/comment$/)).toBe(20);
  });
});

describe("card reads for the PR board", () => {
  test("25 asks for the same card in one draw are one request", async () => {
    await Promise.all(Array.from({ length: 25 }, () => CU.findCard("ORBIT-1042", "ORBIT-")));
    expect(count(/^\/task\//)).toBe(1);
  });

  test("a redraw within the minute reuses the answer", async () => {
    await CU.findCard("orbit-1042", "ORBIT-");
    await CU.findCard("ORBIT-1042", "ORBIT-");
    expect(count(/^\/task\//)).toBe(1);
  });

  test("an edit forgets it, so the detail never shows the state before its own write", async () => {
    await CU.findCard("ORBIT-1042", "ORBIT-");
    await CU.setStatus("t1", "in review");
    await CU.findCard("ORBIT-1042", "ORBIT-");
    expect(count(/^\/task\/ORBIT-1042$/)).toBe(2);
  });

  test("a failed read is not kept", async () => {
    failTasks = true;
    const bad = await CU.findCard("ORBIT-1042", "ORBIT-");
    expect(bad.ok).toBe(false);
    failTasks = false;
    await Bun.sleep(5);
    const good = await CU.findCard("ORBIT-1042", "ORBIT-");
    expect(good.ok).toBe(true);
  });
});
