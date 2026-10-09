/*
 * A DISCONNECT IS NOT UNDONE BY A READ THAT WAS ALREADY ON ITS WAY.
 *
 * Disconnect wiped the disk cache once and then the pages of a workspace
 * sweep that was in flight landed after it: the search table was written,
 * the sweep cached for ten minutes, and `findCard` kept answering from its
 * minute of memory with no credential to read it by. The sweep takes tens of
 * seconds on a real workspace, so "the user clicked Disconnect while it ran"
 * is the ordinary case, not the unlucky one.
 *
 * ClickUp is a local server that holds its answer until the test lets go.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-cudisc-flight-"));
const C = await import("../src/credentials.ts");
const CU = await import("../src/clickup.ts");
const I = await import("../src/clickupindex.ts");
const V = await import("../src/clickupviews.ts");
const P = await import("../src/providers.ts");

let gate: Promise<void> = Promise.resolve();
let open: () => void = () => {};
let hits = 0;
const card = {
  id: "c1042", custom_id: "ORBIT-1042", name: "Pagination arrows", url: "https://example.invalid/t/c1042",
  status: { status: "open", type: "custom" }, date_updated: "1754300000000",
  list: { name: "Miscellaneous" }, assignees: [], tags: [],
};
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    hits++;
    await gate;
    // One card by id answers the card itself; the workspace sweep answers a page.
    const body = u.pathname.startsWith("/task/") ? card : { tasks: Number(u.searchParams.get("page") ?? "0") === 0 ? [card] : [] };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" } });
  },
});

beforeEach(() => {
  hits = 0;
  gate = Promise.resolve();
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_X", accountId: "7", workspaceId: "9001" });
  V.__setViewsPath(join(dir, "views.json"));
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
  I.forget();
  CU.forgetAll();
});
afterEach(() => { open(); CU.forgetAll(); I.forget(); });
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  C.__setCredentialsPath(null);
  V.__setViewsPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("a read in flight when the credential goes", () => {
  test("lands nowhere: the search table stays empty and the sweep is not cached", async () => {
    gate = new Promise<void>((r) => { open = r; });
    const search = CU.searchTasks("pagination");
    while (hits === 0) await Bun.sleep(5);
    await P.disconnectProvider("clickup");
    open();
    const r = await search;
    expect(r.ok).toBe(false);
    expect(I.indexed().cards).toBe(0);
    // Not cached: reconnecting asks ClickUp again rather than answering from the dead sweep.
    C.setCredential("clickup", { token: "pk_1_Y", accountId: "8", workspaceId: "9002" });
    const before = hits;
    await CU.searchTasks("pagination");
    expect(hits).toBeGreaterThan(before);
  });
});

describe("what memory kept", () => {
  test("findCard answers nothing after a disconnect, however fresh its cache was", async () => {
    const first = await CU.findCard("ORBIT-1042", "ORBIT");
    expect(first.ok).toBe(true);
    await P.disconnectProvider("clickup");
    const after = await CU.findCard("ORBIT-1042", "ORBIT");
    expect(after.ok).toBe(false);
  });

  test("the write switch is off again after a disconnect, boards kept", async () => {
    V.setWritesAllowed(true);
    expect(V.writesAllowed()).toBe(true);
    await P.disconnectProvider("clickup");
    expect(V.writesAllowed()).toBe(false);
  });
});
