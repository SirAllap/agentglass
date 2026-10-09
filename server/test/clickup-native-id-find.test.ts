/*
 * A card found by the id ClickUp's own GitHub integration writes.
 *
 * `CU-86abc123` is the default task id with a prefix on it. A workspace with
 * custom ids switched on never sees it, and one without them (every free
 * workspace) sees nothing else — so a pull request branch that said
 * `CU-86abc123_retry` used to be sent to ClickUp as a CUSTOM id, which does not
 * exist, and answered "No card called CU-86ABC123".
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as CU from "../src/clickup.ts";
import * as C from "../src/credentials.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cu-native-id-"));
let seen: string[] = [];
const ok = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" } });
const raw = {
  id: "86abc123", name: "Retry on 429", url: "", date_updated: "1700000000000",
  status: { status: "open", type: "open" }, list: { id: "5", name: "Backlog" }, assignees: [], tags: [],
};
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    seen.push(u.pathname + u.search);
    if (u.pathname === "/task/86abc123" || u.pathname === "/task/ORBIT-1042") return ok(raw);
    return new Response("{}", { status: 401 });
  },
});

beforeEach(() => {
  seen = [];
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_TEST", accountId: "7", workspaceId: "9" });
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
  CU.__reset();
  CU.__clearFindCache();
});
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  C.__setCredentialsPath(null);
  rmSync(dir, { recursive: true, force: true });
});

test("a CU- id is asked for as the plain id, with no custom-id flag", async () => {
  const r = await CU.findCard("CU-86abc123", "");
  expect(r.ok).toBe(true);
  expect(seen).toEqual(["/task/86abc123"]);
});

test("a custom id is still asked for as one", async () => {
  await CU.findCard("ORBIT-1042", "ORBIT-");
  expect(seen).toEqual(["/task/ORBIT-1042?custom_task_ids=true&team_id=9"]);
});

test("the CU- spelling and the plain id share one read", async () => {
  await CU.findCard("CU-86abc123", "");
  await CU.findCard("86abc123", "");
  expect(seen.length).toBe(1);
});

test("the detail read takes a CU- id too", async () => {
  await CU.taskDetail("CU-86abc123");
  expect(seen.some((p) => p.includes("custom_task_ids"))).toBe(false);
  expect(seen[0]).toStartWith("/task/86abc123");
});

test("a workspace that will never have a prefix is not told to open a board", async () => {
  const unknown = await CU.findCard("20542", "");
  expect(unknown).toEqual({ ok: false, error: "Open a board first, so I know what your ids look like" });
  const none = await CU.findCard("20542", "", { noCustomIds: true });
  expect(none).toEqual({ ok: false, error: "Paste the card's address, or its id (CU-…)" });
  expect(seen).toEqual([]);
});
