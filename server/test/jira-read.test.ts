/*
 * Reading one card and a person's list from Jira, against the stand-in site.
 *
 * What a mistake here costs: a card that says it is done when it is not (the
 * status category is the only portable thing about a status), a search that
 * lost a page and reads as a short list, a query with nothing to bound it, a
 * priority taken from a name a team chose, and a card read that quietly turns
 * into a request per project. Each request count below is the user's action.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";
import { startJiraProxy, type JiraProxy } from "./fixtures/jiraTextProxy.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-read-"));
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
const GOOD = { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN };

let fake: FakeJira;
beforeAll(() => { fake = startFakeJira({ pageSize: 2 }); });
beforeEach(async () => {
  fake.reset();
  C.__setCredentialsPath(credFile);
  C.__clearAll();
  J.__setJiraBase(fake.base);
  J.__setJiraGuard(null);
  expect((await J.connectJira(GOOD)).ok).toBe(true);
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
const issueReads = () => count(/^\/issue\//);
const read = (id: string) => J.withStored((c) => J.readIssue(c, id));
const find = (q: string) => J.withStored((c) => J.findIssue(c, q));
const sql = (jql: string, pages?: number) => J.withStored((c) => J.searchJql(c, jql, { pages }));

describe("one card", () => {
  test("an in-progress card: category, colour, priority by position, person, address", async () => {
    const r = await read("ORBIT-1042");
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({
      id: "20042",
      customId: "ORBIT-1042",
      title: "Fix timeout when syncing the board",
      url: "https://acme.atlassian.net/browse/ORBIT-1042",
      status: "In Progress",
      statusKind: "open",
      statusColor: "#ffab00",
      statusId: "2",
      priority: "high",
      due: null,
      updated: Date.parse("2026-01-13T09:00:00.000Z"),
      tags: ["sync", "bug"],
      list: "Orbit",
      listId: "ORBIT",
      assignees: ["Ada Example"],
      people: [{ key: "acc-0001", name: "Ada Example", initials: "AE", avatar: "https://avatar.acme.example/acc-0001/48.png", me: true }],
      mine: true,
      created: Date.parse("2026-01-07T09:00:00.000Z"),
    });
  });

  test("the card carries the status id, which a board column is made of", async () => {
    expect((await read("ORBIT-1042")).data?.statusId).toBe("2");
    expect((await read("ORBIT-1045")).data?.statusId).toBe("5");
    expect(J.toTask({ key: "ORBIT-1", fields: { status: { name: "No id" } } }, { site: "acme.atlassian.net", priorities: null })).not.toHaveProperty("statusId");
  });

  test("each status category maps: new and indeterminate are open, done is done", async () => {
    expect((await read("ORBIT-1001")).data).toMatchObject({ status: "To Do", statusKind: "open", statusColor: "#42526e" });
    expect((await read("ORBIT-1044")).data).toMatchObject({ status: "QA", statusKind: "open", statusColor: "#ffab00" });
    expect((await read("ORBIT-1045")).data).toMatchObject({ status: "Done", statusKind: "done", statusColor: "#36b37e" });
  });

  test("unassigned is an empty list, someone else's card is not mine", async () => {
    expect((await read("ORBIT-1001")).data).toMatchObject({ assignees: [], people: [], mine: false });
    const other = (await read("ORBIT-1043")).data!;
    expect(other.assignees).toEqual(["Grace Sample"]);
    expect(other.mine).toBe(false);
    expect(other.people![0]).toMatchObject({ key: "acc-0002" });
    expect(other.people![0]).not.toHaveProperty("me");
  });

  test("priority follows the site's own order, not a name", async () => {
    expect((await read("ORBIT-1046")).data!.priority).toBe("urgent"); // first in the list
    expect((await read("ORBIT-1000")).data!.priority).toBe("normal"); // middle
    expect((await read("ORBIT-1044")).data!.priority).toBe("low");
    expect((await read("ORBIT-1045")).data!.priority).toBe("low"); // last
    // The same names in another order give another answer: the order decides.
    const names = ["Highest", "High", "Medium", "Low", "Lowest"];
    const rev = { ids: ["5", "4", "3", "2", "1"], names: [...names].reverse() };
    expect(J.priorityRank({ id: "1", name: "Highest" }, rev)).toBe("low");
    expect(J.priorityRank({ id: "5", name: "Lowest" }, rev)).toBe("urgent");
  });

  test("priorityRank: one priority is normal, an unknown one is none", () => {
    expect(J.priorityRank({ id: "9" }, { ids: ["9"], names: ["Only"] })).toBe("normal");
    expect(J.priorityRank({ id: "8" }, { ids: ["9"], names: ["Only"] })).toBeNull();
    expect(J.priorityRank(null, { ids: ["9"], names: ["Only"] })).toBeNull();
    expect(J.priorityRank({ id: "9" }, null)).toBeNull();
    // Four ranks: urgent, high, normal, low.
    const four = { ids: ["a", "b", "c", "d"], names: ["a", "b", "c", "d"] };
    expect(["a", "b", "c", "d"].map((id) => J.priorityRank({ id }, four))).toEqual(["urgent", "high", "normal", "low"]);
  });

  test("a card that does not exist says so with its key, and is not an outage", async () => {
    const r = await read("ORBIT-9999");
    expect(r).toMatchObject({ ok: false, status: 404, error: "ORBIT-9999 was not found or you cannot see it" });
    expect(r.data).toBeUndefined();
  });

  test("the numeric id is asked for as it is (the stand-in knows cards by key only, so it says not found)", async () => {
    const r = await read("20042");
    expect(r.status).toBe(404);
    expect(fake.requests.map((q) => q.path)).toContain("/issue/20042");
  });

  test("an id that is not a card id is refused with no request at all", async () => {
    for (const bad of ["", "ORBIT", "ORBIT-1042/transitions", "../../myself", "ORBIT-1042?expand=x", "ORBIT 1042", "-1"]) {
      expect((await read(bad)).ok).toBe(false);
    }
    expect(fake.requests.length).toBe(0);
  });

  test("request counts: opening a card is one issue read; the priority list is read once", async () => {
    await read("ORBIT-1042");
    expect(issueReads()).toBe(1);
    expect(count("/priority/search")).toBe(1);
    await read("ORBIT-1000");
    expect(issueReads()).toBe(2);
    expect(count("/priority/search")).toBe(1); // remembered
    expect(fake.requests.length).toBe(3);
  });

  test("the deprecated priority list and the old search are never called", async () => {
    await read("ORBIT-1042");
    await J.withStored((c) => J.mine(c));
    await find("1042");
    expect(count("/priority")).toBe(0);
    expect(count("/search")).toBe(0);
  });

  test("only the fields a card row needs are asked for", async () => {
    await read("ORBIT-1042");
    const q = fake.requests.find((r) => r.path === "/issue/ORBIT-1042")!.query.fields!.split(",");
    expect(q).toEqual(expect.arrayContaining(["summary", "status", "assignee", "priority", "duedate", "labels", "project", "updated"]));
    expect(q).not.toContain("*all");
    expect(q).not.toContain("comment");
  });

  test("a priority list that cannot be read costs the chip, not the card", async () => {
    fake.fail({ path: "/priority/search", status: 403 });
    const r = await read("ORBIT-1042");
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ customId: "ORBIT-1042", priority: null });
  });

  test("a refused token is the sentence, unauthorised, with nothing else", async () => {
    fake.fail({ path: "/issue/ORBIT-1042", status: 401 });
    const r = await read("ORBIT-1042");
    expect(r).toMatchObject({ ok: false, unauthorised: true, error: J.JIRA_REFUSED });
  });
});

describe("toTask on its own", () => {
  const cx = { site: "acme.atlassian.net", priorities: null };

  test("not an issue, or no key, is no card", () => {
    for (const v of [null, undefined, "x", 7, [], {}, { id: "1" }]) expect(J.toTask(v, cx)).toBeNull();
  });

  test("a status category it does not know is other, and an unknown colour is no colour", () => {
    const t = J.toTask({ id: "1", key: "ORBIT-1", fields: { summary: "s", status: { name: "Odd", statusCategory: { key: "undefined", colorName: "magenta" } } } }, cx)!;
    expect(t).toMatchObject({ statusKind: "other", status: "Odd" });
    expect(t.statusColor).toBeUndefined();
  });

  test("a due date is kept as the day it is; a bad timestamp is 0, never NaN", () => {
    const t = J.toTask({ id: "1", key: "ORBIT-1", fields: { duedate: "2026-03-04", updated: "yesterday" } }, cx)!;
    expect(t.due).toBe("2026-03-04");
    expect(t.updated).toBe(0);
    expect(t.created).toBeUndefined();
  });

  test("a numeric id is kept as text; no project is no list", () => {
    const t = J.toTask({ id: 77, key: "ORBIT-1", fields: {} }, cx)!;
    expect(t).toMatchObject({ id: "77", list: null, tags: [], assignees: [], people: [] });
    expect(t.listId).toBeUndefined();
  });

  test("an avatar that is not https is dropped", () => {
    const t = J.toTask({ id: "1", key: "ORBIT-1", fields: { assignee: { accountId: "a", displayName: "Lin Tester", avatarUrls: { "48x48": "http://x.example/a.png" } } } }, cx)!;
    expect(t.people![0]).not.toHaveProperty("avatar");
  });

  test("Data Center names a person by key, then name; the display name is used as is", () => {
    const withKey = J.toTask({ id: "1", key: "ORBIT-1", fields: { assignee: { key: "JIRAUSER10100", name: "ada", displayName: "Ada Example" } } }, { ...cx, me: "JIRAUSER10100" })!;
    expect(withKey.people).toEqual([{ key: "JIRAUSER10100", name: "Ada Example", initials: "AE", me: true }]);
    expect(withKey.mine).toBe(true);
    const nameOnly = J.toTask({ id: "1", key: "ORBIT-1", fields: { assignee: { name: "lin" } } }, cx)!;
    expect(nameOnly.people).toEqual([{ key: "lin", name: "lin", initials: "L" }]);
    expect(nameOnly.assignees).toEqual(["lin"]);
  });
});

describe("finding a card", () => {
  test("a full id resolves with one issue read and no search, in any case", async () => {
    const r = await find("acme-7");
    expect(r.ok).toBe(true);
    expect(r.data!.asked).toBe("ACME-7");
    expect(r.data!.task.customId).toBe("ACME-7");
    expect(issueReads()).toBe(1);
    expect(count("/project/search")).toBe(0);
    expect(count("/search/jql")).toBe(0);
  });

  test("a bare number is tried against the site's own projects, one read each, the first card found wins", async () => {
    const twin = structuredClone(fake.state.issues["ACME-7"]!);
    Object.assign(twin, { id: "20100", key: "ACME-100" });
    fake.state.issues["ACME-100"] = twin;
    const r = await find("100");
    expect(r.data!.asked).toBe("ACME-100");
    // Projects are read once, then ORBIT-100 (404) and ACME-100.
    expect(count("/project/search")).toBe(1);
    expect(fake.requests.filter((q) => q.path.startsWith("/issue/")).map((q) => q.path)).toEqual(["/issue/ORBIT-100", "/issue/ACME-100"]);
    expect(count("/search/jql")).toBe(0);
  });

  test("a bare number that is nowhere says where it looked", async () => {
    const r = await find("4242");
    expect(r).toMatchObject({ ok: false, error: "No card 4242 in ORBIT, ACME" });
  });

  test("a refusal while looking is the answer, not 'not found'", async () => {
    fake.fail({ path: "/issue/*", status: 401 });
    const r = await find("1042");
    expect(r).toMatchObject({ ok: false, unauthorised: true });
    expect(issueReads()).toBe(1); // it did not go on to the next project
  });

  test("something that is not a card id is refused with no request", async () => {
    for (const q of ["", "  ", "fix the sync", "12", "ORBIT-", "ORBIT-1042 and more"]) expect((await find(q)).ok).toBe(false);
    expect(fake.requests.length).toBe(0);
  });

  test("past a few projects a bare number is refused, not spread over all of them", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: String(i), key: `P${i}` }));
    const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ values: many, isLast: true }) });
    try {
      J.__setJiraBase(`http://127.0.0.1:${stub.port}`);
      const r = await find("1042");
      expect(r).toMatchObject({ ok: false, error: "Type the project key too, like P0-1042" });
    } finally { await stub.stop(true); }
  });
});

describe("a person's list", () => {
  test("mine is the open cards on you, one request per page, bounded by the assignee", async () => {
    const r = await J.withStored((c) => J.mine(c));
    // Three open cards on Ada, two to a page.
    expect(r.ok).toBe(true);
    expect(r.data!.tasks.map((t) => t.customId).sort()).toEqual(["ORBIT-1000", "ORBIT-1042", "ORBIT-1050"]);
    expect(r.data!.tasks.every((t) => t.mine && t.statusKind !== "done")).toBe(true);
    expect(r.data!.truncated).toBe(false);
    expect(count("/search/jql")).toBe(2);
    expect(count("/priority/search")).toBe(1);
    const bodies = fake.requests.filter((q) => q.path === "/search/jql").map((q) => q.body as { jql: string; nextPageToken?: string; fields: string[] });
    expect(bodies[0]!.jql).toBe(J.MINE_JQL);
    expect(bodies[0]!.nextPageToken).toBeUndefined();
    expect(typeof bodies[1]!.nextPageToken).toBe("string");
    expect(bodies[0]!.fields).not.toContain("*all");
  });

  test("an empty list is ok and empty; a failing search is an error and has no list", async () => {
    fake.fail({ path: "/search/jql", empty: true, times: 1 });
    expect(await J.withStored((c) => J.mine(c, { fresh: true }))).toEqual({ ok: true, data: { tasks: [], truncated: false } });
    fake.fail({ path: "/search/jql", status: 500, times: 1 });
    const bad = await J.withStored((c) => J.mine(c, { fresh: true }));
    expect(bad).toMatchObject({ ok: false, error: "Could not reach Jira" });
    expect(bad.data).toBeUndefined();
    fake.fail({ path: "/search/jql", garbage: true, times: 1 });
    expect((await J.withStored((c) => J.mine(c, { fresh: true }))).ok).toBe(false);
  });

  test("a page that fails after the first one fails the search; it is never a short list", async () => {
    const proxy = startJiraProxy(fake.base, "project = ORBIT", { failSearchAfter: 1 });
    try {
      J.__setJiraBase(proxy.base);
      const r = await sql("project = ORBIT");
      expect(r).toMatchObject({ ok: false, error: "Could not reach Jira" });
      expect(r.data).toBeUndefined();
      expect(proxy.jql.length).toBe(2); // the second page was asked for, and refused
    } finally { await proxy.stop(); }
  });

  test("pages are followed to the cap; the cap says it cut the list short", async () => {
    const all = await sql("project = ORBIT", 10);
    expect(all.data!.tasks.length).toBe(8);
    expect(all.data!.truncated).toBe(false);
    fake.requests.length = 0;
    const capped = await sql("project = ORBIT"); // default three pages of two
    expect(capped.data!.tasks.length).toBe(6);
    expect(capped.data!.truncated).toBe(true);
    expect(count("/search/jql")).toBe(3);
  });

  test("a page that says it is the last is the last, whatever else it carries", async () => {
    let asked = 0;
    const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
      if (new URL(req.url).pathname.endsWith("/priority/search")) return Response.json({ values: [], isLast: true });
      asked++;
      return Response.json({ issues: [], isLast: true, nextPageToken: "more" });
    } });
    try {
      J.__setJiraBase(`http://127.0.0.1:${stub.port}`);
      expect(await sql("project = ORBIT")).toEqual({ ok: true, data: { tasks: [], truncated: false } });
      expect(asked).toBe(1);
    } finally { await stub.stop(true); }
  });

  test("a query with nothing to bound it is refused before it is sent", async () => {
    for (const jql of ["", "   ", "ORDER BY key", "order   by updated DESC", " Order By created"]) {
      const r = await sql(jql);
      expect(r).toMatchObject({ ok: false, error: "Refusing to search Jira without a restriction" });
    }
    expect(fake.requests.length).toBe(0);
    expect(J.boundedJql("assignee = currentUser() order by key")).toBe(true);
    expect(J.boundedJql("key = ORBIT-1")).toBe(true);
    // `order by` inside quoted text is text, not a clause.
    expect(J.boundedJql('summary ~ "sort order by date"')).toBe(true);
    expect(J.boundedJql("summary ~ 'x \\' order by y' ORDER BY key")).toBe(true);
    expect(J.boundedJql('"order by x" order by key')).toBe(true);
    expect(J.boundedJql("order by key")).toBe(false);
    expect(J.orderByAt('summary ~ "a order by b" ORDER BY key')).toBe('summary ~ "a order by b"'.length);
  });

  test("the cloud site stops being asked at isLast, and no answer's total is read", async () => {
    const r = await sql("project = ACME");
    expect(r.data!.tasks.length).toBe(2);
    expect(count("/search/jql")).toBe(1);
    // The stand-in never sends a total; the client must not have needed one.
    const src = await Bun.file(new URL("../src/jira.ts", import.meta.url)).text();
    const section = src.slice(src.indexOf("// reading cards"), src.indexOf("// connect, status, disconnect"));
    const code = section.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/\btotal\b/);
    expect(code).not.toMatch(/\/rest\/api\/3\/priority(?!\/search)/);
    expect(code).not.toMatch(/\/rest\/api\/3\/search(?!\/jql)/);
  });
});

describe("text search", () => {
  let proxy: JiraProxy;
  beforeEach(() => { proxy = startJiraProxy(fake.base); J.__setJiraBase(proxy.base); });
  afterEach(async () => { await proxy.stop(); });
  const search = (q: string) => J.withStored((c) => J.searchText(c, q));

  test("the words go inside a quoted phrase inside the site's own projects", async () => {
    const r = await search("sync board");
    expect(r.ok).toBe(true);
    // One query per page, the same on each.
    expect(new Set(proxy.jql)).toEqual(new Set(['project in ("ORBIT", "ACME") AND text ~ "sync board" ORDER BY updated DESC']));
    expect(proxy.jql.length).toBe(3);
    expect(r.data!.tasks.length).toBeGreaterThan(0);
    expect(r.data!.truncated).toBe(true); // the stand-in answers eight cards in pages of two; three pages cut it
  });

  test("a quote, a backslash and the index's operators cannot leave the phrase", async () => {
    await search('x" OR project = SECRET OR text ~ "y\\ (board)* -a +b ~c ^d {e} [f] g:h i/j k&l m|n o!p q?');
    const q = proxy.jql[0]!;
    expect(q).toMatch(/^project in \("ORBIT", "ACME"\) AND text ~ "[^"\\]*" ORDER BY updated DESC$/);
    expect(q).not.toMatch(/[(){}[\]^~*?:/&|!+](?=[^"]*" ORDER)/);
  });

  test("nothing to search for is a sentence and no request", async () => {
    for (const q of ["", "   ", '"', "()*?", "\u0000\u0001"]) {
      expect(await search(q)).toMatchObject({ ok: false, error: "Type something to search for" });
    }
    expect(fake.requests.length).toBe(0);
    expect(proxy.jql).toEqual([]);
  });

  test("a very long phrase is cut", async () => {
    await search("a".repeat(500));
    expect(proxy.jql[0]!.match(/text ~ "(a+)"/)![1]!.length).toBe(200);
  });
});

describe("without a connection", () => {
  test("every read says Jira is not connected and sends nothing", async () => {
    C.__clearAll();
    for (const r of [await read("ORBIT-1042"), await find("ORBIT-1042"), await J.withStored((c) => J.mine(c)), await J.withStored((c) => J.searchText(c, "x"))]) {
      expect(r).toEqual({ ok: false, error: "Jira is not connected" });
    }
    expect(fake.requests.length).toBe(0);
  });
});
