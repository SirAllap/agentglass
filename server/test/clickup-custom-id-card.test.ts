/*
 * A card opened from a link that carries its human id.
 *
 * A workspace with custom ids switched on links `/t/<team>/ORBIT-1042`. The
 * detail read takes a plain id, and the comment and time-in-status routes
 * under it do not take the custom-id flag at all, so the human id is turned
 * into the plain one with one read before anything else is asked.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as CU from "../src/clickup.ts";
import * as C from "../src/credentials.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cu-customid-"));
let seen: string[] = [];
const ok = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" } });
const raw = {
  id: "86abc12xy", name: "Pagination arrows", url: "", date_updated: "1700000000000",
  status: { status: "open", type: "open" }, list: { id: "5", name: "Backlog" }, assignees: [], tags: [],
};
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    seen.push(u.pathname + u.search);
    if (/\/comment$/.test(u.pathname)) return ok({ comments: [] });
    if (/\/time_in_status$/.test(u.pathname)) return ok({});
    if (u.pathname.startsWith("/task/")) return ok(raw);
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

test("a custom id is resolved once, and every later read uses the plain id", async () => {
  const r = await CU.taskDetail("ORBIT-1042");
  expect(r.ok).toBe(true);
  expect(seen[0]).toBe("/task/ORBIT-1042?custom_task_ids=true&team_id=9");
  const rest = seen.slice(1).filter((p) => p.startsWith("/task/"));
  expect(rest.length).toBeGreaterThan(0);
  for (const p of rest) expect(p, p).toStartWith("/task/86abc12xy");
});

test("a plain id costs no extra read", async () => {
  await CU.taskDetail("86abc12xy");
  expect(seen.some((p) => p.includes("custom_task_ids"))).toBe(false);
});
