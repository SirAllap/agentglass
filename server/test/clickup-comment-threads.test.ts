/*
 * Card comments as ClickUp API v2 sends them: `reactions` and `reply_count` on
 * GET /task/{id}/comment, replies only from GET /comment/{id}/reply when asked.
 * Fakes only; no real workspace.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as CU from "../src/clickup.ts";
import * as C from "../src/credentials.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cu-threads-"));
let seen: string[] = [];
const ok = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" } });
const user = (id: number, username: string) => ({ id, username, initials: "AO", color: "#7d53de" });
const comments = [
  { id: "c1", comment_text: "Ship it", date: "1700000001000", user: user(7, "Ada Orbit"), reply_count: "2",
    reactions: [{ reaction: "👍", date: "1700000002000", user: user(7, "Ada Orbit") }, { reaction: "👍", date: "1700000003000", user: user(8, "Bo Acme") }] },
  { id: "c2", comment_text: "Later", date: "1700000004000", user: user(8, "Bo Acme"), reply_count: "0", reactions: [] },
];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    seen.push(`${req.method} ${u.pathname}`);
    if (u.pathname === "/comment/c1/reply") return ok({ comments: [{ id: "r1", comment_text: "done", date: "1700000009000", user: user(8, "Bo Acme") }] });
    if (u.pathname === "/comment/bad/reply") return new Response("{}", { status: 500 });
    if (/\/comment$/.test(u.pathname)) return ok({ comments });
    if (/\/time_in_status$/.test(u.pathname)) return ok({});
    if (u.pathname.startsWith("/task/")) return ok({ id: "86abc12xy", name: "Pagination arrows", url: "", date_updated: "1700000000000", status: { status: "open", type: "open" }, list: { id: "5", name: "Backlog" }, assignees: [], tags: [] });
    return ok({});
  },
});

beforeEach(() => {
  seen = [];
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_TEST", accountId: "7", workspaceId: "9" });
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
  CU.__reset();
});
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  C.__setCredentialsPath(null);
  rmSync(dir, { recursive: true, force: true });
});

test("the card read carries reactions and the reply count, and asks for no thread", async () => {
  const r = await CU.taskDetail("86abc12xy");
  const [c1, c2] = r.data!.comments;
  expect(c1!.replies).toBe(2);
  expect(c1!.reactions).toEqual([{ emoji: "👍", count: 2, mine: true, who: ["Ada Orbit", "Bo Acme"] }]);
  expect(c2!.reactions).toBeUndefined();
  expect(c2!.replies).toBeUndefined();
  expect(seen.some((p) => p.endsWith("/reply"))).toBe(false);
});

test("a thread is read when asked, oldest first, with your own marked", async () => {
  const r = await CU.repliesOf("c1");
  expect(seen).toEqual(["GET /comment/c1/reply"]);
  expect(r.data!.replies.map((x) => [x.id, x.text, x.mine])).toEqual([["r1", "done", undefined]]);
});

test("a thread that will not load is an error for that thread", async () => {
  expect((await CU.repliesOf("bad")).ok).toBe(false);
});
