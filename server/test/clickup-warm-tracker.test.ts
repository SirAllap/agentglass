/*
 * The background sweep that warms ClickUp's card bodies costs real requests
 * (see clickup-search-refs.test.ts for the measurement). A project whose
 * tracker is explicitly Jira has no cards left to warm, so opening its board
 * must not pay for a sweep of the whole ClickUp workspace.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-warm-tracker-"));
const C = await import("../src/credentials.ts");
const CU = await import("../src/clickup.ts");
const TP = await import("../src/trackerProjects.ts");

let asked: string[] = [];

const CARD = {
  id: "c1042", custom_id: "ORBIT-1042", name: "Retry webhooks",
  status: { status: "in progress", type: "custom" }, date_updated: "1754300000000",
  list: { name: "Orbit" }, assignees: [], tags: [],
};

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    asked.push(u.pathname + u.search);
    const body = u.pathname.startsWith("/task/") ? CARD : { tasks: [] };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" },
    });
  },
});

beforeEach(() => {
  asked = [];
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_X", accountId: "7", workspaceId: "9001" });
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
  CU.__clearSearchCache();
  TP.__setTrackerProjectsPath(join(dir, "tracker-projects.json"));
});
afterEach(() => { CU.__reset(); CU.__clearSearchCache(); TP.__setTrackerProjectsPath(null); });
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  C.__setCredentialsPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const settle = () => Bun.sleep(50);

describe("warmBodySweep, scoped to a repository's own tracker", () => {
  test("a repository explicitly set to Jira pays for no sweep at all", async () => {
    TP.setTrackerChoice("acme/orbit", "jira");
    CU.warmBodySweep("acme/orbit");
    await settle();
    expect(asked).toEqual([]);
  });

  test("a repository pinned to ClickUp, or with no choice made, sweeps as before", async () => {
    TP.setTrackerChoice("acme/plat", "clickup");
    CU.warmBodySweep("acme/plat");
    await settle();
    expect(asked.length).toBeGreaterThan(0);

    asked = [];
    CU.__clearSearchCache();
    CU.warmBodySweep("acme/unchosen");
    await settle();
    expect(asked.length).toBeGreaterThan(0);
  });

  test("no repository named sweeps as before — an unscoped caller is not refused", async () => {
    CU.warmBodySweep();
    await settle();
    expect(asked.length).toBeGreaterThan(0);
  });

  test("the single-card read (--card) is not gated: it works even on a repository the sweep now skips", async () => {
    TP.setTrackerChoice("acme/orbit", "jira");
    CU.warmBodySweep("acme/orbit");
    await settle();
    expect(asked, "the sweep itself stayed off").toEqual([]);
    const r = await CU.taskDetail("ORBIT-1042");
    expect(r.ok).toBe(true);
    expect(r.data?.task.customId).toBe("ORBIT-1042");
  });
});
