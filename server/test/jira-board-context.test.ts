/*
 * What sits around a board's cards: the kind and the flag on each row, the
 * parent a row sits under, the board's quick filters and sprint and epics, and
 * what a toggled filter costs. The budget is part of the behaviour, so the
 * requests are counted at the stand-in: the extra fields ride in the one
 * search (no request per card), the three context reads are asked once per
 * board per ten minutes, and a toggle is the one search it narrows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-board-context-"));
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
const V = await import("../src/jiraviews.ts");
const B = await import("../src/jiraboards.ts");
const X = await import("../src/jiraBoardContext.ts");
const F = await import("../src/jirafields.ts");

const credFile = join(dir, "creds.json");
const viewsFile = join(dir, "config", "agentglass", "jira-views.json");

afterAll(() => {
  C.__clearAll();
  C.__setCredentialsPath(null);
  V.__setJiraViewsPath(null);
  J.__setJiraBase(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const SITES: Record<FakeFlavor, string> = { cloud: "acme.atlassian.net", datacenter: "jira.acme.example" };

describe("what a row carries from the site's fields (pure)", () => {
  test("a raised flag is true, an empty one is not there; the parent says what it is", () => {
    const f = { customfield_10021: [{ value: "Impediment" }], parent: { key: "ORBIT-1000", fields: { summary: "Report improvements", issuetype: { name: "Epic" } } } };
    expect(F.cardExtras(f, { flag: "customfield_10021" })).toMatchObject({ flagged: true, parent: { key: "ORBIT-1000", title: "Report improvements", type: "Epic" } });
    expect("flagged" in F.cardExtras({ customfield_10021: [] }, { flag: "customfield_10021" })).toBe(false);
    expect("flagged" in F.cardExtras({ customfield_10021: null }, { flag: "customfield_10021" })).toBe(false);
    // A site with no Flagged field cannot make a card flagged by a field of the same shape.
    expect("flagged" in F.cardExtras({ customfield_10021: [{ value: "Impediment" }] }, {})).toBe(false);
    expect(F.cardExtras({ parent: { key: "ORBIT-1000" } }, {}).parent).toEqual({ key: "ORBIT-1000", title: "" });
  });
});

for (const flavor of ["cloud", "datacenter"] as const) {
  describe(`board context, ${flavor}`, () => {
    const site = SITES[flavor];
    const dc = flavor === "datacenter";
    const searchPath = dc ? "/search" : "/search/jql";
    let fake: FakeJira;

    const connect = async () => {
      C.__clearAll();
      J.__setJiraBase(fake.base);
      const r = await J.connectJira(dc ? { site, token: FAKE_PAT } : { site, email: FAKE_EMAIL, token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
    };
    const count = (path: string | RegExp) => fake.requests.filter((r) => (typeof path === "string" ? r.path === path : path.test(r.path))).length;
    const searches = () => fake.requests.filter((r) => r.path === searchPath);
    const addBoard = async (id: string) => { const r = await B.addViewByChoice("board", id); expect(r.data).toMatchObject({ ok: true }); fake.requests.length = 0; };
    const keysOf = (r: { tasks: { customId?: string }[] }) => r.tasks.map((t) => t.customId);
    const task = (r: { tasks: { customId?: string }[] }, key: string) => r.tasks.find((t) => t.customId === key) as Record<string, unknown>;

    beforeAll(() => { fake = startFakeJira({ flavor, pageSize: 50 }); });
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(credFile);
      V.__setJiraViewsPath(viewsFile);
      V.__clear();
      J.__setJiraGuard(null);
      await connect();
      fake.requests.length = 0;
    });
    afterEach(() => { J.__setJiraBase(null); });
    afterAll(async () => { await fake.stop(); });

    describe("the row", () => {
      // These read a board as a column list; the sprint's own read is test/jira-board-sprint.test.ts.
      beforeEach(() => { fake.state.sprints[3] = []; });
      test("kind, parent and flag come in the one search, and nothing is asked per card", async () => {
        fake.state.issues["ORBIT-1042"]!.flagged = "Impediment";
        await addBoard("3");
        const r = await B.viewRead("board:3");
        expect(r.ok).toBe(true);
        expect(task(r, "ORBIT-1042")).toMatchObject({ issueType: "Bug", flagged: true, parent: { key: "ORBIT-1000", type: "Epic" } });
        expect("flagged" in task(r, "ORBIT-1043")).toBe(false);
        const sent = (searches()[0]!.body as { fields: string[] }).fields;
        expect(sent).toEqual(expect.arrayContaining(["issuetype", "parent"]));
        expect(count(/^\/issue\//)).toBe(0);
        // The one agile read a board makes is its sprint, which the header's context shares.
        expect(count(/\/agile\/|quickfilter|sprint|epic/)).toBe(1);
      });

      test("60 cards are two search pages and the same handful of memoised reads, not a request per card", async () => {
        const base = fake.state.issues["ORBIT-1001"]!;
        for (let n = 0; n < 60; n++) {
          const key = `ORBIT-${3000 + n}`;
          fake.state.issues[key] = { ...structuredClone(base), id: String(60000 + n), key, summary: `Card ${n}`, rank: `0|q${String(n).padStart(5, "0")}:` };
        }
        await addBoard("3");
        const r = await B.viewRead("board:3");
        expect(r.tasks.length).toBeGreaterThanOrEqual(60);
        expect(searches().length).toBe(Math.ceil(r.tasks.length / 50));
        expect(count(/^\/issue\//)).toBe(0);
        // The configuration, the filter, the field list and the priorities once each, then only the pages.
        const rest = fake.requests.filter((q) => q.path !== searchPath);
        expect(rest.length).toBeLessThanOrEqual(5);
      });
    });

    describe("the context reads", () => {
      test("quick filters, the active sprint and the epics: three reads, once per board per ten minutes", async () => {
        const c = await withCreds((creds) => X.boardContext(creds, "board:3"));
        expect(c.ok).toBe(true);
        expect(c.filters.map((q) => q.name)).toEqual(["Only bugs", "High priority"]);
        expect(c.sprint).toMatchObject({ name: "Sprint 4", state: "active", goal: "Ship the board" });
        expect(c.sprint!.start).toBeLessThan(c.sprint!.end);
        expect(c.epics.map((e) => e.key)).toEqual(["ORBIT-1000"]);
        expect(fake.requests.length).toBe(3);
        await withCreds((creds) => X.boardContext(creds, "board:3"));
        await withCreds((creds) => X.boardContext(creds, "3"));
        expect(fake.requests.length).toBe(3);
      });

      test("a query never leaves the server", async () => {
        const c = await withCreds((creds) => X.boardContext(creds, "board:3"));
        expect(JSON.stringify(c)).not.toContain("issuetype = Bug");
        expect(JSON.stringify(c)).not.toContain("jql");
      });

      test("a kanban board has no sprint and no epic list, and that is not an error", async () => {
        const c = await withCreds((creds) => X.boardContext(creds, "board:1"));
        expect(c).toMatchObject({ ok: true, filters: [], epics: [] });
        expect(c.sprint).toBeUndefined();
        // The 400 is remembered as the answer: asking again costs nothing.
        const n = fake.requests.length;
        await withCreds((creds) => X.boardContext(creds, "board:1"));
        expect(fake.requests.length).toBe(n);
      });

      test("a sprint that has not started is the backlog's, not the header's", async () => {
        fake.state.sprints[3] = [{ id: 42, name: "Sprint 5", state: "future" }];
        const c = await withCreds((creds) => X.boardContext(creds, "board:3"));
        expect(c.sprint).toBeUndefined();
      });

      test("an id that is not digits asks nobody", async () => {
        const c = await withCreds((creds) => X.boardContext(creds, "board:../../x"));
        expect(c).toMatchObject({ ok: true, filters: [], epics: [] });
        expect(fake.requests.length).toBe(0);
      });

      test("a site that fails one read leaves that part empty and says so, the others stand", async () => {
        fake.fail({ path: "/rest/agile/1.0/board/3/quickfilter", status: 500 });
        const c = await withCreds((creds) => X.boardContext(creds, "board:3"));
        expect(c.ok).toBe(false);
        expect(c.error).toBeTruthy();
        expect(c.filters).toEqual([]);
        expect(c.sprint).toMatchObject({ name: "Sprint 4" });
      });
    });

    describe("a toggled quick filter", () => {
      // These read a board as a column list; the sprint's own read is test/jira-board-sprint.test.ts.
      beforeEach(() => { fake.state.sprints[3] = []; });
      test("ANDs the board's own query into the one search, and the first toggle adds the one filter read", async () => {
        await addBoard("3");
        const whole = await B.viewRead("board:3");
        fake.requests.length = 0;
        const bugs = await B.viewRead("board:3", { quick: ["1"] });
        expect(bugs.ok).toBe(true);
        expect(keysOf(bugs).every((k) => task(bugs, k!).issueType === "Bug")).toBe(true);
        expect(bugs.tasks.length).toBeLessThan(whole.tasks.length);
        const sent = searches().map((s) => (s.body as { jql: string }).jql);
        expect(sent.length).toBe(1);
        expect(sent[0]).toContain("(issuetype = Bug)");
        expect(count(/quickfilter/)).toBe(1);
        // The second filter, and both together: the filter list is held, so each is only its search.
        fake.requests.length = 0;
        await B.viewRead("board:3", { quick: ["2"] });
        await B.viewRead("board:3", { quick: ["1", "2"] });
        expect(count(/quickfilter/)).toBe(0);
        expect(searches().length).toBe(2);
        const both = (searches().at(-1)!.body as { jql: string }).jql;
        expect(both).toContain("(issuetype = Bug)");
        expect(both).toContain("(priority = High)");
        // The same set again, in a different order, is the minute that is already held.
        fake.requests.length = 0;
        const again = await B.viewRead("board:3", { quick: ["2", "1"] });
        expect(again.ok).toBe(true);
        expect(fake.requests.length).toBe(0);
      });

      test("a narrowed read is never what the board remembers", async () => {
        await addBoard("3");
        const whole = await B.viewRead("board:3");
        await B.viewRead("board:3", { quick: ["1"] });
        const kept = await B.viewRead("board:3", { cached: true });
        expect(keysOf(kept)).toEqual(keysOf(whole));
        // Nor does a narrowed ask answer from disk: `cached` with a filter reads.
        const narrowed = await B.viewRead("board:3", { cached: true, quick: ["1"] });
        expect(narrowed.cached).toBeUndefined();
      });

      test("an id the board does not have is refused, and never widens the read", async () => {
        await addBoard("3");
        await B.viewRead("board:3");
        fake.requests.length = 0;
        const r = await B.viewRead("board:3", { quick: ["99"] });
        expect(r.ok).toBe(false);
        expect(r.error).toContain("quick filter");
        // Not the whole board's rows under a filter that was not applied.
        expect(r.tasks).toEqual([]);
        expect(searches().length).toBe(0);
      });

      test("a view that is not a board ignores the ask", async () => {
        const a = await B.addViewByUrl(`https://${site}/issues/?jql=${encodeURIComponent("project = ORBIT ORDER BY key")}`);
        const id = (a.data as { view: { id: string } }).view.id;
        fake.requests.length = 0;
        await B.viewRead(id, { quick: ["1"] });
        expect(count(/quickfilter/)).toBe(0);
        expect((searches()[0]!.body as { jql: string }).jql).not.toContain("issuetype = Bug");
      });
    });

    const withCreds = <T>(run: (c: import("../src/jira.ts").JiraCreds) => Promise<T>): Promise<T> =>
      J.withStored(async (c) => ({ ok: true, data: await run(c) })).then((r) => r.data as T);
  });
}
