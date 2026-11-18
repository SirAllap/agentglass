/*
 * The search box follows the site's pages to a cap of 1000 cards, keeps them all under one 30-second entry, and says how
 * many the site holds when the cap cut the list. A reconnect never serves the old account's answer.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-jql-cap-"));
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
const P = await import("../../shared/providers.ts");

let fake: FakeJira;
const searches = (): number => fake.requests.filter((r) => r.path.includes("/search/jql")).length;
beforeAll(() => { fake = startFakeJira({ pageSize: 1 }); });
beforeEach(async () => {
  fake.reset();
  // More ORBIT cards than 20 pages of one: the cap is reached.
  const issues = fake.state.issues;
  const first = Object.values(issues).find((i) => i.key.startsWith("ORBIT-"))!;
  for (let n = 0; n < 30; n++) issues[`ORBIT-${5000 + n}`] = { ...first, key: `ORBIT-${5000 + n}`, id: String(95000 + n) };
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
afterAll(() => {
  fake.stop();
  J.__setJiraBase(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

test("a capped search follows 20 pages and says how many the site holds", async () => {
  const r = await Q.runJql("project = ORBIT");
  expect(r.ok).toBe(true);
  expect(searches()).toBe(Q.SEARCH_PAGES);
  expect(r.data!.tasks.length).toBe(Q.SEARCH_PAGES);
  expect(r.data!.truncated).toBe(true);
  const all = Object.keys(fake.state.issues).filter((k) => k.startsWith("ORBIT-")).length;
  expect(r.data!.matching).toBe(all);
});

test("all the pages sit under one 30-second entry", async () => {
  await Q.runJql("project = ORBIT", { now: 1_000 });
  const once = fake.requests.length;
  await Q.runJql("project = ORBIT", { now: 1_000 + Q.JQL_TTL_MS - 1 });
  expect(fake.requests.length).toBe(once);
});

test("a reconnect never serves the old account's kept answer", async () => {
  await Q.runJql("project = ORBIT", { now: 1_000 });
  const once = searches();
  J.forgetJira();
  await Q.runJql("project = ORBIT", { now: 1_001 });
  expect(searches()).toBeGreaterThan(once);
});

test("an older failure never drops a newer kept answer under the same key", async () => {
  let fail!: (v: { ok: false; error: string }) => void;
  let calls = 0;
  Q.__setRun(() => (++calls === 1 ? new Promise((res) => { fail = res; }) : Promise.resolve({ ok: true, data: { tasks: [], truncated: false } })));
  const old = Q.runJql("project = ORBIT", { now: 1_000 });
  await Q.runJql("project = ORBIT", { now: 1_000 + Q.JQL_TTL_MS + 1 });
  fail({ ok: false, error: "boom" });
  await old;
  await Q.runJql("project = ORBIT", { now: 1_000 + Q.JQL_TTL_MS + 2 });
  expect(calls).toBe(2);
});

test("saving a search an edited view used to hold never overwrites that view", () => {
  const a = B.saveJqlView("project = ORBIT", "A");
  if (!a.ok) throw new Error(a.error);
  expect(B.editViewById(a.view.id, { jql: "project = ORBIT AND type = Bug" }).ok).toBe(true);
  const again = B.saveJqlView("project = ORBIT", "B");
  if (!again.ok) throw new Error(again.error);
  expect(again.view.id).not.toBe(a.view.id);
  const kept = V.savedViews("orbit.atlassian.net").find((v) => v.id === a.view.id)!;
  expect(kept.name).toBe("A");
  expect(B.jqlOfView(kept)).toBe("project = ORBIT AND type = Bug");
});

test("saving a search already saved, with no name, keeps its own name", () => {
  const a = B.saveJqlView("project = ORBIT AND type = Bug", "Orbit bugs");
  const again = B.saveJqlView("project = ORBIT AND type = Bug");
  if (!a.ok || !again.ok) throw new Error("not saved");
  expect(again.view.id).toBe(a.view.id);
  expect(again.view.name).toBe("Orbit bugs");
});

test("the built-in Assigned to me counts through its own search", async () => {
  const t = Q.countTarget(P.ASSIGNED_VIEW_ID, []);
  expect(t).toBeDefined();
  expect(Q.jqlForView(t!)).toBe(Q.ASSIGNED_JQL);
  expect((await Q.viewCount(t)).ok).toBe(true);
  const ask = fake.requests.find((r) => r.path === "/search/approximate-count");
  expect((ask?.body as { jql?: string } | undefined)?.jql).toBe(Q.ASSIGNED_JQL);
});

const searchView = (i: number) => ({ id: `jql:t${i}`, url: `https://orbit.atlassian.net/issues/?jql=${encodeURIComponent(`project = ORBIT AND text ~ "t${i}"`)}` });

test("a sidebar count asks the site for the total only, never the cards", async () => {
  const n = await Q.viewCount(searchView(0));
  expect(n.ok).toBe(true);
  expect(searches()).toBe(0);
  expect(fake.requests.filter((r) => r.path === "/search/approximate-count").length).toBe(1);
});

test("N sidebar rows give at most N count calls per cache window, at most 2 at once", async () => {
  let live = 0, peak = 0;
  const base = fake.requests;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
    const u = String(a[0] instanceof Request ? a[0].url : a[0]);
    if (!u.includes("approximate-count")) return orig(...a);
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 15));
    try { return await orig(...a); } finally { live--; }
  }) as typeof fetch;
  try {
    const ids = Array.from({ length: 8 }, (_, i) => searchView(i));
    await Promise.all(ids.map((v) => Q.viewCount(v, { now: 5_000 })));
    await Promise.all(ids.map((v) => Q.viewCount(v, { now: 5_000 + Q.JQL_TTL_MS - 1 })));
    const counts = base.filter((r) => r.path === "/search/approximate-count");
    expect(counts.length).toBe(8);
    expect(searches()).toBe(0);
    expect(peak).toBeLessThanOrEqual(Q.COUNT_SLOTS);
  } finally { globalThis.fetch = orig; }
});

test("counts stop at the per-minute budget with a sentence, not a request", async () => {
  for (let i = 0; i < Q.COUNT_PER_MIN; i++) await Q.viewCount(searchView(100 + i), { now: 9_000 });
  const before = fake.requests.length;
  const over = await Q.viewCount(searchView(999), { now: 9_000 });
  expect(over.ok).toBe(false);
  expect(fake.requests.length).toBe(before);
});

test("a search refuses an id that could carry a second clause", () => {
  expect(Q.jqlForView({ id: 'assignee:a" OR project = X', url: "" })).toBeNull();
  expect(Q.countTarget('assignee:a" OR project = X', [])).toBeUndefined();
});

test("typing asks one page; the walk of every page is for Enter", async () => {
  const r = await Q.runJql("project = ORBIT", { pages: Q.TYPING_PAGES });
  expect(r.ok).toBe(true);
  expect(searches()).toBe(1);
});

test("a search whose caller left stops walking pages and is not kept", async () => {
  const ac = new AbortController();
  const p = Q.runJql("project = ORBIT AND issuetype = Bug", { signal: ac.signal });
  ac.abort();
  expect((await p).error).toBe("Cancelled");
  await new Promise((r) => setTimeout(r, 50));
  expect(searches()).toBeLessThan(Q.SEARCH_PAGES);
  const again = await Q.runJql("project = ORBIT AND issuetype = Bug", { pages: 1 });
  expect(again.ok).toBe(true);
});

test("the walk keeps going while any caller still waits, and stops when the last leaves", async () => {
  let aborted = false;
  Q.__setRun((_j, _p, signal) => new Promise((res) => { signal.addEventListener("abort", () => { aborted = true; res({ ok: false, error: "x" }); }); }));
  const a = new AbortController(), b = new AbortController();
  void Q.runJql("project = ORBIT", { signal: a.signal });
  void Q.runJql("project = ORBIT", { signal: b.signal });
  a.abort();
  expect(aborted).toBe(false);
  b.abort();
  expect(aborted).toBe(true);
});

test("a saved filter may be renamed or shared here, never given a search of its own", () => {
  V.upsertView("orbit.atlassian.net", { id: "filter:10042", name: "Orbit bugs", url: "", addedAt: 1 });
  expect(B.editViewById("filter:10042", { name: "Orbit open bugs", team: true }).ok).toBe(true);
  const kept = V.savedViews("orbit.atlassian.net").find((v) => v.id === "filter:10042")!;
  expect([kept.name, kept.team]).toEqual(["Orbit open bugs", true]);
  expect(B.editViewById("filter:10042", { jql: "project = ORBIT" }).ok).toBe(false);
});

test("Show as tab is kept on the saved view, cleared when unchecked, and only yes or no", () => {
  V.upsertView("orbit.atlassian.net", { id: "filter:10043", name: "Orbit security", url: "", addedAt: 1 });
  expect(B.editViewById("filter:10043", { tab: true }).ok).toBe(true);
  expect(V.savedViews("orbit.atlassian.net").find((v) => v.id === "filter:10043")!.tab).toBe(true);
  expect(B.editViewById("filter:10043", { tab: "yes" }).ok).toBe(false);
  expect(B.editViewById("filter:10043", { tab: false }).ok).toBe(true);
  expect("tab" in V.savedViews("orbit.atlassian.net").find((v) => v.id === "filter:10043")!).toBe(false);
});
