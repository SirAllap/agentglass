/*
 * The same reads as jira-read.test.ts, against the Data Center personality of
 * the stand-in: REST v2, a personal access token as a bearer, people named by
 * `key` and `name` with no account id, one array of projects, one array of
 * priorities, and search paged by `startAt` with a total that must not be
 * needed. The generation comes from the connection, so a Cloud site behind a
 * domain of its own is checked here too: its host says "custom", its
 * serverInfo says Cloud, and the reads follow serverInfo.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_PAT_AUTH, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";
import { startJiraProxy } from "./fixtures/jiraTextProxy.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-read-dc-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB", "AGENTGLASS_JIRA_WRITE"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");
delete process.env.AGENTGLASS_JIRA_WRITE;

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");

const credFile = join(dir, "creds.json");
const SITE = "jira.acme.example";

let fake: FakeJira;
beforeAll(() => { fake = startFakeJira({ flavor: "datacenter", pageSize: 2 }); });
beforeEach(async () => {
  fake.reset();
  C.__setCredentialsPath(credFile);
  C.__clearAll();
  J.__setJiraBase(fake.base);
  J.__setJiraGuard(null);
  expect((await J.connectJira({ site: SITE, token: FAKE_PAT })).ok).toBe(true);
  fake.requests.length = 0;
});
afterEach(() => { J.__setJiraBase(null); });
afterAll(async () => {
  await fake.stop();
  C.__clearAll();
  C.__setCredentialsPath(null);
  J.__setJiraBase(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const count = (path: string | RegExp) => fake.requests.filter((r) => (typeof path === "string" ? r.path === path : path.test(r.path))).length;
const read = (id: string) => J.withStored((c) => J.readIssue(c, id));
const find = (q: string) => J.withStored((c) => J.findIssue(c, q));
const sql = (jql: string, pages?: number) => J.withStored((c) => J.searchJql(c, jql, { pages }));

describe("the connection decides", () => {
  test("it is stored as v2 with a bearer, and every read signs in that way", async () => {
    expect(C.redacted("jira")).toMatchObject({ api: 2, auth: "bearer", deployment: "server" });
    await read("ORBIT-1042");
    expect(fake.requests.every((r) => r.auth === FAKE_PAT_AUTH)).toBe(true);
  });
});

describe("one card", () => {
  test("a Data Center card: people by key, the address under the site, v2 endpoints only", async () => {
    const r = await read("ORBIT-1042");
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      id: "20042",
      customId: "ORBIT-1042",
      url: `https://${SITE}/browse/ORBIT-1042`,
      status: "In Progress",
      statusKind: "open",
      statusColor: "#ffab00",
      priority: "high",
      list: "Orbit",
      listId: "ORBIT",
      assignees: ["Ada Example"],
      mine: true,
    });
    expect(r.data!.people).toEqual([{ key: "JIRAUSER10000", name: "Ada Example", initials: "AE", avatar: "https://avatar.acme.example/JIRAUSER10000/48.png", me: true }]);
    // The priority list is the one array, asked once; the Cloud-only endpoints are not touched.
    expect(count("/priority")).toBe(1);
    expect(count("/priority/search")).toBe(0);
    expect(fake.requests.every((q) => !q.path.startsWith("/rest/api/3"))).toBe(true);
  });

  test("someone else's card is not mine and carries their key", async () => {
    const t = (await read("ORBIT-1043")).data!;
    expect(t.mine).toBe(false);
    expect(t.people![0]).toMatchObject({ key: "JIRAUSER10001", name: "Grace Sample" });
    expect(t.people![0]).not.toHaveProperty("me");
  });

  test("an unassigned card, and a done one", async () => {
    expect((await read("ORBIT-1001")).data).toMatchObject({ assignees: [], people: [], statusKind: "open" });
    expect((await read("ORBIT-1045")).data).toMatchObject({ statusKind: "done", statusColor: "#36b37e", priority: "low" });
  });

  test("request counts: one issue read; the priority list once", async () => {
    await read("ORBIT-1042");
    await read("ORBIT-1000");
    expect(count(/^\/issue\//)).toBe(2);
    expect(count("/priority")).toBe(1);
  });

  test("not found is its own sentence", async () => {
    expect(await read("ORBIT-9999")).toMatchObject({ ok: false, status: 404, error: "ORBIT-9999 was not found or you cannot see it" });
  });

  test("no rate-limit header is no note, and nothing is held", async () => {
    await read("ORBIT-1042");
    expect(J.rateNote()).toEqual({ remaining: null, holdUntil: 0 });
  });
});

describe("finding a card", () => {
  test("a bare number reads the one project array, then the card", async () => {
    const r = await find("1042");
    expect(r.data!.asked).toBe("ORBIT-1042");
    expect(count("/project")).toBe(1);
    expect(count("/project/search")).toBe(0);
    expect(count("/issue/ORBIT-1042")).toBe(1);
    expect(count(/^\/search/)).toBe(0);
  });

  test("a full id is one read and no project list", async () => {
    expect((await find("orbit-1042")).data!.asked).toBe("ORBIT-1042");
    expect(count("/project")).toBe(0);
  });

  test("a card in a context path keeps the path in its address", async () => {
    C.__clearAll();
    expect((await J.connectJira({ site: `${SITE}:8443/jira`, token: FAKE_PAT })).ok).toBe(true);
    expect((await read("ORBIT-1042")).data!.url).toBe(`https://${SITE}:8443/jira/browse/ORBIT-1042`);
  });
});

describe("a person's list", () => {
  test("mine pages by startAt, stops on a short page and never needs the total", async () => {
    const r = await J.withStored((c) => J.mine(c));
    expect(r.data!.tasks.map((t) => t.customId).sort()).toEqual(["ORBIT-1000", "ORBIT-1042", "ORBIT-1050"]);
    expect(r.data!.truncated).toBe(false);
    const posts = fake.requests.filter((q) => q.path === "/search");
    expect(posts.length).toBe(2);
    expect(posts.map((q) => (q.body as { startAt: number }).startAt)).toEqual([0, 2]);
    expect(posts.every((q) => q.method === "POST" && !("nextPageToken" in (q.body as object)))).toBe(true);
    expect((posts[0]!.body as { jql: string }).jql).toBe(J.MINE_JQL);
    expect(count("/search/jql")).toBe(0);
  });

  test("pages are followed to the cap and the cap says so", async () => {
    const capped = await sql("project = ORBIT");
    expect(capped.data!.tasks.length).toBe(6);
    expect(capped.data!.truncated).toBe(true);
    expect(count("/search")).toBe(3);
    fake.requests.length = 0;
    const all = await sql("project = ORBIT", 10);
    expect(all.data!.tasks.length).toBe(8);
    expect(all.data!.truncated).toBe(false);
  });

  test("an empty answer is ok and empty; a failure is an error", async () => {
    fake.fail({ path: "/search", empty: true, times: 1 });
    expect(await sql("project = ORBIT")).toEqual({ ok: true, data: { tasks: [], truncated: false } });
    fake.fail({ path: "/search", status: 500, times: 1 });
    const bad = await sql("project = ORBIT");
    expect(bad).toMatchObject({ ok: false, error: "Could not reach Jira" });
    expect(bad.data).toBeUndefined();
  });

  test("this site would take a query with no restriction; we still do not send one", async () => {
    expect(await sql("ORDER BY key")).toMatchObject({ ok: false, error: "Refusing to search Jira without a restriction" });
    expect(fake.requests.length).toBe(0);
  });

  test("text search uses the project array and the same phrase rules", async () => {
    const proxy = startJiraProxy(fake.base);
    try {
      J.__setJiraBase(proxy.base);
      const r = await J.withStored((c) => J.searchText(c, 'sync "board"'));
      expect(r.ok).toBe(true);
      expect(new Set(proxy.jql)).toEqual(new Set(['project in ("ORBIT", "ACME") AND text ~ "sync board" ORDER BY updated DESC']));
      expect(count("/project")).toBe(1);
    } finally { await proxy.stop(); }
  });
});

describe("a Cloud site behind a domain of its own", () => {
  let cloud: FakeJira;
  beforeEach(async () => {
    cloud = startFakeJira({ flavor: "cloud", pageSize: 2 });
    C.__clearAll();
    J.__setJiraBase(cloud.base);
    expect((await J.connectJira({ site: SITE, email: FAKE_EMAIL, token: FAKE_TOKEN })).ok).toBe(true);
    cloud.requests.length = 0;
  });
  afterEach(async () => { await cloud.stop(); });

  test("its host says custom but serverInfo says Cloud, so v3 and token paging are used", async () => {
    expect(C.redacted("jira")).toMatchObject({ api: 3, auth: "basic", deployment: "cloud" });
    const r = await J.withStored((c) => J.mine(c));
    expect(r.data!.tasks.length).toBe(3);
    expect(cloud.requests.filter((q) => q.path === "/search/jql").length).toBe(2);
    expect(cloud.requests.some((q) => q.path === "/search")).toBe(false);
    expect(r.data!.tasks[0]!.url.startsWith(`https://${SITE}/browse/`)).toBe(true);
    expect(r.data!.tasks[0]!.people![0]).toMatchObject({ key: "acc-0001" });
  });
});
