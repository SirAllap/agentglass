/*
 * How many requests reach ClickUp, counted at a stand-in workspace.
 *
 * The workspace rate-limits a token to about a hundred a minute and the person
 * shares that token with their real work, so the number of calls a screen makes
 * is behaviour, not an implementation detail. Each test names the measured
 * shape it guards: five cold lists cost 157 requests in four seconds before
 * comment counts went through a queue.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as CU from "../src/clickup.ts";
import * as C from "../src/credentials.ts";
import * as CV from "../src/clickupviews.ts";
import * as P from "../src/providers.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cu-budget-"));
let seen: string[] = [];
const ok = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" } });
const card = (list: string, i: number) => ({
  id: `c${list}_${i}`, name: `Card ${i}`, url: "", date_updated: String(1_700_000_000_000 + i),
  status: { status: "open", type: "open" }, list: { id: list, name: `List ${list}` }, assignees: [], tags: [],
});

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    seen.push(`${req.method} ${p}`);
    await Bun.sleep(15);
    let m: RegExpExecArray | null;
    if (p === "/user") return ok({ user: { id: 7, username: "me", email: "me@example.test" } });
    if (p === "/team") return ok({ teams: [{ id: "9", members: [{ user: { id: 1, username: "ann", initials: "A" } }] }] });
    if (/\/member$/.test(p)) return ok({ members: [{ id: 1, username: "ann" }] });
    if (/\/view$/.test(p)) return ok({ required_views: { list: { id: "v1" } } });
    if (/\/field$/.test(p)) return ok({ fields: [] });
    if ((m = /^\/list\/(\d+)\/task$/.exec(p))) return ok({ tasks: Array.from({ length: 12 }, (_, i) => card(m![1]!, i)), last_page: true });
    if (/^\/list\/\d+$/.test(p)) return ok({ name: "L", statuses: [{ status: "open", type: "open", orderindex: 0 }] });
    if (/^\/view\//.test(p)) return ok({ tasks: [], last_page: true });
    if (/\/comment$/.test(p)) return ok({ comments: [{ id: "1" }, { id: "2" }] });
    if (/\/time_in_status$/.test(p)) return ok({});
    if (/^\/task\//.test(p)) return ok(card("1", 1));
    return ok({});
  },
});
const BASE = `http://127.0.0.1:${server.port}`;
const count = (re: RegExp) => seen.filter((s) => re.test(s)).length;

beforeEach(() => {
  seen = [];
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_TEST", accountId: "7", workspaceId: "9" });
  CV.__setViewsPath(join(dir, "views.json"));
  CV.__clear();
  CV.setWritesAllowed(true);
  CU.__setClickUpBase(BASE);
  CU.__resetCounts();
  CU.__setCountEvery(60_000);
  P.__resetViewCache();
});
afterEach(() => { CU.__resetCounts(); CU.__reset(); });
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  CV.__setViewsPath(null);
  C.__setCredentialsPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("identical reads that overlap are one request", () => {
  test("two same-tick reads of a card cost three calls, not six", async () => {
    await Promise.all([CU.taskDetail("c1_1"), CU.taskDetail("c1_1")]);
    expect(seen.length).toBe(3);
  });

  test("it is not a cache: the next read after the answer asks again", async () => {
    await CU.taskDetail("c1_1");
    await CU.taskDetail("c1_1");
    expect(count(/^GET \/task\/c1_1$/)).toBe(2);
  });
});

describe("who can be picked is asked once a session", () => {
  test("the second list switch costs nothing for the same list and only the list for another", async () => {
    await CU.listMembers("101");
    const first = seen.length;
    await CU.listMembers("101");
    expect(seen.length).toBe(first);
    await CU.listMembers("102");
    expect(seen.slice(first)).toEqual(["GET /list/102/member"]);
    expect(count(/^GET \/team$/)).toBe(1);
  });

  test("a comment post does not ask for the roster again after the picker did", async () => {
    await CU.listMembers("101");
    seen = [];
    await CU.commentOn("c1_1", "hello");
    expect(count(/^GET \/team$/)).toBe(0);
  });
});

describe("comment counts are a slow queue, not a burst", () => {
  test("reading a 12-card board asks for at most one count", async () => {
    CV.addView({ id: "list:101", name: "L", url: "", addedAt: 1, listId: "101" });
    await P.readView("list:101");
    await Bun.sleep(80);
    // 12 cards, unbounded before: 12 comment calls in the same second.
    expect(count(/\/comment$/)).toBeLessThanOrEqual(1);
  });

  test("the queue drains at its own pace and the badge lands on the board", async () => {
    CU.__setCountEvery(20);
    CV.addView({ id: "list:101", name: "L", url: "", addedAt: 1, listId: "101" });
    await P.readView("list:101");
    await Bun.sleep(600);
    expect(count(/\/comment$/)).toBe(12);
    const board = await P.readView("list:101");
    expect(board.tasks.every((t) => t.comments === 2)).toBe(true);
  });

  test("a card that was opened is already counted", async () => {
    await CU.taskDetail("c1_1");
    seen = [];
    await CU.refreshCommentCounts([{ id: "c1_1", updated: 1_700_000_000_001 } as never], "pk_1_TEST");
    await Bun.sleep(40);
    expect(count(/\/comment$/)).toBe(0);
  });
});

describe("a write folds its answer into the boards that hold the card", () => {
  test("the server's copy shows the new status without a board read", async () => {
    CV.addView({ id: "list:101", name: "L", url: "", addedAt: 1, listId: "101" });
    await P.readView("list:101");
    const before = CV.boardHolding("c101_3")!;
    CV.patchCachedTask({ ...before.task, status: "done" });
    const after = CV.boardHolding("c101_3")!;
    expect(after.task.status).toBe("done");
    expect(after.at).toBe(before.at);
    expect(CV.boardHolding("c101_4")!.task.status).toBe("open");
  });
});
