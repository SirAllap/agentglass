/*
 * The search box's JQL and the sidebar's counts: one search per query per 30 seconds, never per keystroke; a failure is
 * not kept; a filter counts through its own search; the token never shows in what the route answers.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-jql-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");
const Q = await import("../src/jiraJql.ts");
const V = await import("../src/jiraviews.ts");
const B = await import("../src/jiraboards.ts");

let fake: FakeJira;
beforeAll(() => { fake = startFakeJira({ pageSize: 50 }); });
beforeEach(async () => {
  fake.reset();
  C.__setCredentialsPath(join(dir, "creds.json"));
  C.__clearAll();
  J.__setJiraBase(fake.base);
  J.__setJiraGuard(null);
  Q.__setRun(null);
  V.__setJiraViewsPath(join(dir, "config", "agentglass", "jira-views.json"));
  V.__clear();
  expect((await J.connectJira({ email: FAKE_EMAIL, site: "orbit.atlassian.net", token: FAKE_TOKEN })).ok).toBe(true);
  fake.requests.length = 0;
});
afterEach(() => { J.__setJiraBase(null); });
afterAll(async () => {
  V.__setJiraViewsPath(null);
  await fake.stop();
  C.__clearAll();
  C.__setCredentialsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const searches = () => fake.requests.filter((r) => r.path === "/search/jql").length;

test("a JQL query reads the site's cards that answer it", async () => {
  const r = await Q.runJql("project = ORBIT AND issuetype = Bug");
  expect(r.ok).toBe(true);
  expect(r.data!.tasks.length).toBeGreaterThan(0);
  expect(r.data!.tasks.every((t) => t.issueType === "Bug")).toBe(true);
});

test("the same query inside 30 seconds asks the site once", async () => {
  await Q.runJql("project = ORBIT", { now: 1_000 });
  const once = searches();
  await Q.runJql("project = ORBIT", { now: 1_000 + Q.JQL_TTL_MS - 1 });
  expect(searches()).toBe(once);
  await Q.runJql("project = ORBIT", { now: 1_000 + Q.JQL_TTL_MS + 1 });
  expect(searches()).toBeGreaterThan(once);
});

test("a failed search is not kept, so the next try asks again", async () => {
  let calls = 0;
  Q.__setRun(async () => { calls++; return { ok: false, error: "Jira said no" }; });
  await Q.runJql("project = ORBIT", { now: 5 });
  await Q.runJql("project = ORBIT", { now: 6 });
  expect(calls).toBe(2);
});

test("an empty, unbounded or oversized query never reaches the site", async () => {
  expect((await Q.runJql("   ")).ok).toBe(false);
  expect((await Q.runJql("ORDER BY rank")).ok).toBe(false);
  expect((await Q.runJql("project = ORBIT AND " + "x".repeat(Q.JQL_MAX))).ok).toBe(false);
  expect(searches()).toBe(0);
});

test("a filter counts through its own search; a search view through its kept query", async () => {
  expect(Q.jqlForView({ id: "filter:10042", url: "" })).toBe("filter = 10042");
  expect(Q.jqlForView({ id: "jql:abc", url: "https://orbit.atlassian.net/issues/?jql=project%20%3D%20ORBIT" })).toBe("project = ORBIT");
  const n = await Q.viewCount({ id: "jql:abc", url: "https://orbit.atlassian.net/issues/?jql=project%20%3D%20ORBIT" });
  expect(n.ok).toBe(true);
  expect(n.count).toBeGreaterThan(0);
});

test("an unknown view or an unread board has no count, never a guess", async () => {
  expect((await Q.viewCount(undefined)).ok).toBe(false);
  expect((await Q.viewCount({ id: "board:999", url: "" })).ok).toBe(false);
  expect(searches()).toBe(0);
});

test("the answer never carries the token", async () => {
  const r = await Q.runJql("project = ORBIT");
  expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN);
});

test("a board column with a card-count limit and one status gives that status its WIP limit; a shared column does not", async () => {
  const board = fake.state.boards.find((b) => b.id === 3)!;
  (board.columns[1] as { max?: number }).max = 3;
  (board.columns[2] as { max?: number }).max = 4;
  expect((await B.addViewByChoice("board", "3")).data).toMatchObject({ ok: true });
  const r = await B.viewRead("board:3");
  expect(r.ok).toBe(true);
  const st = (r as unknown as { statuses: { status: string; wip?: number }[] }).statuses;
  expect(st.find((s) => s.status === "In Progress")?.wip).toBe(3);
  expect(st.filter((s) => s.wip === 4)).toEqual([]);
});

test("resetting the seam also forgets the per-minute count budget an earlier file spent", async () => {
  for (let i = 0; i < Q.COUNT_PER_MIN; i++) await Q.viewCount({ id: "jql:s" + i, url: "https://orbit.atlassian.net/issues/?jql=" + encodeURIComponent("project = P" + i) }, { now: 1000 });
  const over = await Q.viewCount({ id: "jql:x", url: "https://orbit.atlassian.net/issues/?jql=" + encodeURIComponent("project = OVER") }, { now: 1000 });
  expect(over.error).toContain("Too many counts");
  Q.__setRun(null);
  const again = await Q.viewCount({ id: "jql:x", url: "https://orbit.atlassian.net/issues/?jql=" + encodeURIComponent("project = OVER") }, { now: 1000 });
  expect(again.ok).toBe(true);
});

test("the search box's JQL on a board answers inside that board, never with cards from the rest of the site", async () => {
  const w = await B.viewWhere("board:3");
  expect(w.ok).toBe(true);
  expect(w.data!).toContain("status in (");
  // Board 3 reads ORBIT's filter; ACME's cards are on the site and on another board.
  const site = await Q.runJql("project = ACME");
  expect(site.ok).toBe(true);
  expect(site.data!.tasks.length).toBeGreaterThan(0);
  const elsewhere = await Q.runJql(B.scopedJql(w.data!, "project = ACME"));
  expect(elsewhere.ok).toBe(true);
  expect(elsewhere.data!.tasks.length).toBe(0);
  const scoped = await Q.runJql(B.scopedJql(w.data!, "project = ORBIT ORDER BY key ASC"));
  expect(scoped.ok).toBe(true);
  expect(scoped.data!.tasks.length).toBeGreaterThan(0);
  expect(scoped.data!.tasks.every((t) => (t.customId ?? "").startsWith("ORBIT-"))).toBe(true);
});

test("a typed order stays the order inside a view's restriction", () => {
  expect(B.scopedJql("(project = ORBIT)", "issuetype = Bug ORDER BY created DESC")).toBe("(project = ORBIT) AND (issuetype = Bug) ORDER BY created DESC");
});
