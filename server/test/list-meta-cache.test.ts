/*
 * Refresh is for the tasks, not for the list's own shape.
 *
 * Measured against a mock list: one press of Refresh cost 4 requests, two of
 * them the list and its fields, which `force` re-read every time although
 * statuses and fields change about never. The tasks are still read on every
 * press; the list meta waits for its own, longer, clock.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-meta-"));
const C = await import("../src/credentials.ts");
const V = await import("../src/clickupviews.ts");
const CU = await import("../src/clickup.ts");
const P = await import("../src/providers.ts");

let hits: string[] = [];
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" } });
const TASK = {
  id: "abc", name: "A card", url: "https://example.invalid/t/abc",
  status: { status: "in development", type: "custom", orderindex: 5 },
  date_updated: "1754300000000", list: { id: "901700000001", name: "A list" },
  assignees: [{ id: 7, username: "Ada" }],
};
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    hits.push(p);
    if (/\/view\/[^/]+\/task$/.test(p)) return json({ tasks: [TASK], last_page: true });
    if (/\/list\/[^/]+\/field$/.test(p)) return json({ fields: [] });
    if (/\/list\/[^/]+$/.test(p)) return json({ name: "A list", statuses: [{ status: "in development", type: "custom", orderindex: 5 }], space: { name: "A space" }, folder: { name: "A folder", hidden: false } });
    return json({});
  },
});
const VIEW_ID = "6-901700000001-1";
const metaReads = () => hits.filter((h) => /^\/list\/[^/]+(\/field)?$/.test(h)).length;
const taskReads = () => hits.filter((h) => /\/view\/[^/]+\/task$/.test(h)).length;

beforeEach(async () => {
  hits = [];
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_X", accountId: "7", workspaceId: "9000001", verifiedAt: Date.now() });
  V.__setViewsPath(join(dir, "views.json"));
  V.__clear();
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
  P.__resetViewCache();
  V.addView({ id: VIEW_ID, name: "A view", listId: "901700000001", url: "https://x.clickup.com/1/v/l/" + VIEW_ID, addedAt: 1 });
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

describe("list meta on Refresh", () => {
  it("a forced read asks for the tasks and not for the list again", async () => {
    await P.readView(VIEW_ID, true);
    expect(taskReads()).toBe(1);
    expect(metaReads()).toBe(0);
  });

  it("a second press is the same", async () => {
    await P.readView(VIEW_ID, true);
    await P.readView(VIEW_ID, true);
    expect(taskReads()).toBe(2);
    expect(metaReads()).toBe(0);
  });

  it("the list is read again once its own clock has run out", async () => {
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + P.META_TTL_MS + 1000;
      await P.readView(VIEW_ID, true);
    } finally { Date.now = realNow; }
    expect(metaReads()).toBe(2);
  });
});
