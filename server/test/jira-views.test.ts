/*
 * Saved Jira views, in process: the address book, a pasted address, a board
 * read as its columns, a filter, a search, a project as a folder. Every
 * behaviour runs against both personalities of the stand-in, because the
 * agile endpoints are the same on both and the platform ones are not.
 *
 * What is counted is requests at the stand-in: the budget is part of the
 * behaviour (a board read cold is the configuration, the filter and the search
 * pages; read again inside a minute it is nothing).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

// The credential is built apart so no single line spells out a whole login URL; the string is unchanged.
const PW = "secret";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-views-"));
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
const keysOf = (tasks: { customId?: string }[]) => tasks.map((t) => t.customId);

for (const flavor of ["cloud", "datacenter"] as const) {
  describe(`saved views, ${flavor}`, () => {
    const site = SITES[flavor];
    const searchPath = flavor === "cloud" ? "/search/jql" : "/search";
    let fake: FakeJira;

    const connect = async (f: FakeJira, as = site) => {
      C.__clearAll();
      J.__setJiraBase(f.base);
      const r = await J.connectJira(flavor === "cloud" ? { site: as, email: FAKE_EMAIL, token: FAKE_TOKEN } : { site: as, token: FAKE_PAT });
      expect(r.ok).toBe(true);
      f.requests.length = 0;
    };
    const count = (path: string | RegExp) => fake.requests.filter((r) => (typeof path === "string" ? r.path === path : path.test(r.path))).length;
    const searches = () => fake.requests.filter((r) => r.path === searchPath);
    const jqls = () => searches().map((r) => String((r.body as { jql?: string }).jql));
    const addBoard = async (id: string) => { const r = await B.addViewByChoice("board", id); expect(r.data).toMatchObject({ ok: true }); fake.requests.length = 0; };

    beforeAll(() => { fake = startFakeJira({ flavor }); });
    beforeEach(async () => {
      fake.reset();
      // These read a board as a column list; the sprint's own read is test/jira-board-sprint.test.ts.
      fake.state.sprints[3] = [];
      C.__setCredentialsPath(credFile);
      V.__setJiraViewsPath(viewsFile);
      V.__clear();
      J.__setJiraGuard(null);
      await connect(fake);
    });
    afterEach(() => { J.__setJiraBase(null); });
    afterAll(async () => { await fake.stop(); });

    describe("pasted addresses", () => {
      const ok = (u: string) => B.parseViewUrl(u, site);
      test("every shape names what it is", () => {
        expect(ok(`https://${site}/jira/software/c/projects/ORBIT/boards/1`)).toMatchObject({ ok: true, kind: "board", id: "1" });
        expect(ok(`https://${site}/jira/software/projects/ORBIT/boards/3/backlog?selectedIssue=ORBIT-1`)).toMatchObject({ ok: true, kind: "board", id: "3" });
        expect(ok(`https://${site}/secure/RapidBoard.jspa?rapidView=2&view=planning`)).toMatchObject({ ok: true, kind: "board", id: "2" });
        expect(ok(`https://${site}/issues/?filter=10020`)).toMatchObject({ ok: true, kind: "filter", id: "10020" });
        expect(ok(`https://${site}/projects/ORBIT/issues?filter=10020`)).toMatchObject({ ok: true, kind: "filter", id: "10020" });
        expect(ok(`https://${site}/secure/IssueNavigator.jspa?requestId=10011`)).toMatchObject({ ok: true, kind: "filter", id: "10011" });
        const q = ok(`https://${site}/issues/?jql=${encodeURIComponent("project = ORBIT ORDER BY key")}`);
        expect(q).toMatchObject({ ok: true, kind: "jql", jql: "project = ORBIT ORDER BY key" });
        expect(q.ok && q.id).toMatch(/^jql:[0-9a-z]+$/);
        expect(q.ok && q.url).toContain("jql=");
      });

      test("a name and password in the pasted address, and a fragment, are not kept", () => {
        const r = ok(`https://ada:${PW}@${site}/issues/?filter=10020#top`);
        expect(r).toMatchObject({ ok: true, kind: "filter", url: `https://${site}/issues/?filter=10020` });
        expect(JSON.stringify(r)).not.toContain("secret");
      });

      test("the same search is the same id, another search is another", () => {
        const a = ok(`https://${site}/issues/?jql=project%20%3D%20ORBIT`);
        const b = ok(`https://${site}/issues?jql=project%20%3D%20ORBIT`);
        const c = ok(`https://${site}/issues/?jql=project%20%3D%20ACME`);
        expect(a.ok && b.ok && c.ok && a.id === b.id && a.id !== c.id).toBe(true);
      });

      test("another host, http, a lookalike and a path outside the context are refused", () => {
        for (const u of [
          "https://evil.example/jira/software/projects/ORBIT/boards/1",
          `https://${site}.evil.example/issues/?filter=10020`,
          `https://evil.example/issues/?filter=10020&x=${site}`,
        ]) expect(ok(u)).toMatchObject({ ok: false });
        expect(ok(`http://${site}/issues/?filter=10020`)).toMatchObject({ ok: false, error: expect.stringContaining("https") });
      });

      test("a site with a context path is judged with it", () => {
        const s = `${site}/jira`;
        expect(B.parseViewUrl(`https://${site}/jira/secure/RapidBoard.jspa?rapidView=7`, s)).toMatchObject({ ok: true, kind: "board", id: "7" });
        expect(B.parseViewUrl(`https://${site}/jira/issues/?filter=10020`, s)).toMatchObject({ ok: true, kind: "filter" });
        expect(B.parseViewUrl(`https://${site}/jirax/issues/?filter=10020`, s)).toMatchObject({ ok: false });
        expect(B.parseViewUrl(`https://${site}/issues/?filter=10020`, s)).toMatchObject({ ok: false });
        const q = B.parseViewUrl(`https://${site}/jira/issues/?jql=project%20%3D%20ORBIT`, s);
        expect(q.ok && q.url).toStartWith(`https://${s}/issues/?jql=`);
      });

      test("not a board, a filter or a search: one sentence, and an unbounded search says so", () => {
        for (const u of ["", "nonsense", `https://${site}/browse/ORBIT-1042`, `https://${site}/issues/?filter=abc`, `https://${site}/secure/RapidBoard.jspa?rapidView=1%3B2`]) {
          expect(ok(u)).toMatchObject({ ok: false, error: expect.stringContaining("?filter=10000") });
        }
        expect(ok(`https://${site}/issues/?jql=${encodeURIComponent("ORDER BY key")}`)).toMatchObject({ ok: false, error: expect.stringContaining("no restriction") });
      });

      test("an address from another host sends nothing", async () => {
        const r = await B.addViewByUrl("https://evil.example/issues/?filter=10020");
        expect(r.data).toMatchObject({ ok: false });
        expect(fake.requests.length).toBe(0);
        expect(V.savedViews(site).length).toBe(1);
      });
    });

    describe("a board is its columns", () => {
      test("columns come from the configuration in board order, empty ones kept, each card under its status id", async () => {
        await addBoard("1");
        const r = await B.viewRead("board:1");
        expect(r.ok).toBe(true);
        expect(r.columns.map((c) => [c.name, c.statusIds])).toEqual([
          ["Backlog", []], ["To Do", ["1"]], ["Doing", ["2", "3"]], ["QA", ["4"]], ["Done", ["5"]],
        ]);
        const under = (col: string) => keysOf(r.tasks.filter((t) => r.columns.find((c) => c.name === col)!.statusIds.includes(t.statusId!))).sort();
        expect(under("Backlog")).toEqual([]);
        expect(under("To Do")).toEqual(["ORBIT-1001", "ORBIT-1046", "ORBIT-1050"]);
        expect(under("Doing")).toEqual(["ORBIT-1042", "ORBIT-1043"]);
        expect(under("QA")).toEqual(["ORBIT-1044"]);
        expect(under("Done")).toEqual(["ORBIT-1045"]);
        // The sub-query hid the epic; the other project is not on this board.
        expect(keysOf(r.tasks)).not.toContain("ORBIT-1000");
        expect(r.tasks.every((t) => t.listId === "ORBIT")).toBe(true);
        expect(r.tasks.every((t) => typeof t.statusId === "string")).toBe(true);
      });

      test("the query sent is the filter, the mapped statuses and the sub-query, in the filter's order; the deprecated card list is never asked", async () => {
        await addBoard("1");
        await B.viewRead("board:1");
        expect(jqls()[0]).toBe("(project = ORBIT) AND status in (1, 2, 3, 4, 5) AND (issuetype != Epic) ORDER BY Rank ASC");
        expect(fake.requests.some((q) => /\/board\/\d+\/issue/.test(q.path))).toBe(false);
        expect(fake.requests.some((q) => q.method === "GET" && q.path.startsWith("/rest/agile/") && !/board(\/\d+\/(configuration|sprint))?$/.test(q.path))).toBe(false);
      });

      test("a board without a sub-query is only the filter and its statuses", async () => {
        await addBoard("2");
        const r = await B.viewRead("board:2");
        expect(jqls()[0]).toBe("(project = ACME) AND status in (1, 2, 3, 4, 5) ORDER BY Rank ASC");
        expect(keysOf(r.tasks).sort()).toEqual(["ACME-7", "ACME-8"]);
      });

      test("cold is configuration + filter + search pages (+ priorities once); warm inside a minute is nothing; forced is the search alone", async () => {
        // Naming the board when it is added reads its configuration, and that is remembered.
        await B.addViewByChoice("board", "1");
        await B.viewRead("board:1");
        expect(count("/rest/agile/1.0/board/1/configuration")).toBe(1);
        expect(count("/filter/10010")).toBe(1);
        expect(searches().length).toBe(2);
        expect(count(/^\/priority/)).toBeGreaterThan(0);
        const priorities = count(/^\/priority/);
        fake.requests.length = 0;

        const again = await B.viewRead("board:1");
        expect(again.ok).toBe(true);
        expect(fake.requests.length).toBe(0);

        await B.viewRead("board:1", { force: true });
        expect(searches().length).toBe(2);
        expect(fake.requests.length).toBe(2);
        expect(priorities).toBeGreaterThan(0);
      });

      test("two windows asking at once are one read", async () => {
        await B.addViewByChoice("board", "1");
        const [a, b] = await Promise.all([B.viewRead("board:1"), B.viewRead("board:1")]);
        expect(a.ok && b.ok).toBe(true);
        expect(searches().length).toBe(2);
        expect(count("/rest/agile/1.0/board/1/configuration")).toBe(1);
      });

      test("a board whose columns map no status shows its columns and searches nothing", async () => {
        await B.addFolderByKey("ACME");
        fake.requests.length = 0;
        const r = await B.viewRead("board:4");
        expect(r).toMatchObject({ ok: true, tasks: [] });
        expect(r.columns).toEqual([{ name: "Ideas", statusIds: [] }]);
        expect(searches().length).toBe(0);
        expect(count(/^\/priority/)).toBe(0);
      });

      test("the cap on pages is said, not hidden", async () => {
        const small = startFakeJira({ flavor, pageSize: 1 });
        try {
          await connect(small);
          await addBoard("1");
          small.requests.length = 0;
          const r = await B.viewRead("board:1");
          expect(r.ok).toBe(true);
          expect(r.truncated).toBe(true);
          expect(r.tasks.length).toBe(3);
        } finally { J.__setJiraBase(null); await small.stop(); }
      });
    });

    describe("what is kept", () => {
      test("cached=1 answers from disk with zero requests, also after a restart", async () => {
        await addBoard("1");
        const live = await B.viewRead("board:1");
        fake.requests.length = 0;
        const c = await B.viewRead("board:1", { cached: true });
        expect(fake.requests.length).toBe(0);
        expect(c).toMatchObject({ ok: true, cached: true, at: live.at });
        expect(keysOf(c.tasks)).toEqual(keysOf(live.tasks));
        expect(c.columns).toEqual(live.columns);
        V.__setJiraViewsPath(viewsFile); // forgets memory, reads the file again
        const again = await B.viewRead("board:1", { cached: true });
        expect(keysOf(again.tasks)).toEqual(keysOf(live.tasks));
        expect(fake.requests.length).toBe(0);
      });

      test("nothing read yet: cached=1 is empty and asks nobody", async () => {
        await addBoard("1");
        expect(await B.viewRead("board:1", { cached: true })).toMatchObject({ ok: true, tasks: [], at: 0, cached: true });
        expect(fake.requests.length).toBe(0);
      });

      test("a failed read brings back the last rows, said to be old, never an empty board", async () => {
        await addBoard("1");
        const good = await B.viewRead("board:1");
        fake.fail({ path: searchPath, status: 500 });
        const bad = await B.viewRead("board:1", { force: true });
        expect(bad.ok).toBe(false);
        expect(bad.error).toBeTruthy();
        expect(bad.cached).toBe(true);
        expect(keysOf(bad.tasks)).toEqual(keysOf(good.tasks));
        expect(bad.columns).toEqual(good.columns);
        expect(bad.at).toBe(good.at);
      });

      test("a failed first read is a failure with nothing, and is not kept", async () => {
        await addBoard("1");
        fake.fail({ path: searchPath, status: 500, times: 1 });
        const bad = await B.viewRead("board:1");
        expect(bad).toMatchObject({ ok: false, tasks: [], at: 0 });
        expect(bad.cached).toBeUndefined();
        expect((await B.viewRead("board:1")).ok).toBe(true);
      });

      test("the built-in view is the person's own list, with no columns", async () => {
        const r = await B.viewRead();
        expect(r.ok).toBe(true);
        expect(r.view).toMatchObject({ builtin: true });
        expect(r.columns).toEqual([]);
        expect(jqls()[0]).toContain("assignee = currentUser()");
      });

      test("the view you looked at last is the one asked for next", async () => {
        await addBoard("2");
        await B.viewRead("board:2");
        expect(B.jiraViews().current).toBe("board:2");
        expect((await B.viewRead(undefined, { cached: true })).view?.id).toBe("board:2");
      });

      test("another site's views do not show, and its cache is not ours", async () => {
        V.addView("other.atlassian.net", { id: "board:9", name: "Elsewhere", url: "", addedAt: 1 });
        V.addFolder("other.atlassian.net", { id: "ZED", name: "Zed", spaceId: "ZED", spaceName: "Zed", addedAt: 1, lists: [{ id: "9", name: "Z board" }], listsAt: 1 });
        expect(V.savedViews(site).map((v) => v.id)).toEqual(["me:assigned"]);
        expect(V.savedFolders(site)).toEqual([]);
        expect(V.savedViews("other.atlassian.net").map((v) => v.id)).toEqual(["me:assigned", "board:9"]);
        expect((await B.viewRead("board:9")).ok).toBe(false);
      });

      test("disconnecting drops the last rows and keeps the address book", async () => {
        await addBoard("1");
        await B.addFolderByKey("ACME");
        await B.viewRead("board:1");
        expect(V.cachedFor(site, "board:1")).toBeDefined();
        J.disconnectJira();
        expect(V.cachedFor(site, "board:1")).toBeUndefined();
        expect(V.savedViews(site).map((v) => v.id)).toContain("board:1");
        expect(V.savedFolders(site).map((f) => f.id)).toEqual(["ACME"]);
      });

      test("connecting again drops the rows the previous account read", async () => {
        await addBoard("1");
        await B.viewRead("board:1");
        expect(V.cachedFor(site, "board:1")).toBeDefined();
        const r = await J.connectJira(flavor === "cloud" ? { site, email: FAKE_EMAIL, token: FAKE_TOKEN } : { site, token: FAKE_PAT });
        expect(r.ok).toBe(true);
        expect(await B.viewRead("board:1", { cached: true })).toMatchObject({ ok: true, tasks: [], at: 0, cached: true });
        expect(V.savedViews(site).map((v) => v.id)).toContain("board:1");
      });

      test("a read that throws is a sentence, and leaves nothing held", async () => {
        await addBoard("1");
        B.__setReadFault(() => { throw new Error("boom"); });
        try {
          const bad = await B.viewRead("board:1");
          expect(bad).toMatchObject({ ok: false, error: "Could not read that view" });
        } finally { B.__setReadFault(null); }
        const good = await B.viewRead("board:1");
        expect(good.ok).toBe(true);
        expect(fake.requests.length).toBeGreaterThan(0);
      });

      test("a read in the air while the person disconnects is not written back", async () => {
        await addBoard("1");
        fake.fail({ path: searchPath, delayMs: 150, times: 1 });
        const p = B.viewRead("board:1");
        await Bun.sleep(40);
        J.disconnectJira();
        await p;
        expect(V.cachedFor(site, "board:1")).toBeUndefined();
      });

      test("ClickUp's own file is never made or touched", async () => {
        await addBoard("1");
        await B.viewRead("board:1");
        await B.addFolderByKey("ORBIT");
        expect(existsSync(viewsFile)).toBe(true);
        expect(existsSync(join(dir, "config", "agentglass", "clickup-views.json"))).toBe(false);
      });
    });

    describe("filters and searches", () => {
      test("a saved filter is read as it is, grouped by the panel (no columns)", async () => {
        const a = await B.addViewByChoice("filter", "10020");
        expect(a.data).toMatchObject({ ok: true, view: { id: "filter:10020", name: "Orbit bugs" } });
        fake.requests.length = 0;
        const r = await B.viewRead("filter:10020");
        expect(r.ok).toBe(true);
        expect(r.columns).toEqual([]);
        expect(keysOf(r.tasks)).toEqual(["ORBIT-1001", "ORBIT-1046"]);
        expect(jqls()).toEqual(["project = ORBIT AND assignee is EMPTY ORDER BY key"]);
        expect(count("/filter/10020")).toBe(0); // named when added, remembered
        expect(count(/\/rest\/agile/)).toBe(0);
      });

      test("a filter with no restriction is refused before a search is sent, and says so", async () => {
        expect((await B.addViewByChoice("filter", "10030")).data).toMatchObject({ ok: true });
        fake.requests.length = 0;
        const r = await B.viewRead("filter:10030");
        expect(r).toMatchObject({ ok: false, tasks: [] });
        expect(r.error).toContain("no restriction");
        expect(searches().length).toBe(0);
      });

      test("a filter that is not visible is a sentence, and nothing is saved", async () => {
        const r = await B.addViewByUrl(`https://${site}/issues/?filter=10040`);
        expect(r.data).toMatchObject({ ok: false, error: "That saved filter is not shared with you, or it is gone" });
        expect(V.savedViews(site).map((v) => v.id)).toEqual(["me:assigned"]);
        expect((await B.addViewByChoice("filter", "55555")).data).toMatchObject({ ok: false });
      });

      test("a board that is gone is a sentence too", async () => {
        const r = await B.addViewByUrl(`https://${site}/jira/software/c/projects/ORBIT/boards/99`);
        expect(r.data).toMatchObject({ ok: false, error: "That board is gone, or it is not shared with you" });
        expect(V.savedViews(site).length).toBe(1);
      });

      test("a pasted search is read with no configuration and no filter lookups", async () => {
        const url = `https://${site}/issues/?jql=${encodeURIComponent("project = ORBIT AND status = QA ORDER BY key")}`;
        const a = await B.addViewByUrl(url);
        expect(a.data).toMatchObject({ ok: true, view: { name: "Search: project = ORBIT AND status = QA ORDER BY" } });
        expect(fake.requests.length).toBe(0); // named from its own text
        const id = (a.data as { view: { id: string } }).view.id;
        const r = await B.viewRead(id);
        expect(keysOf(r.tasks)).toEqual(["ORBIT-1044"]);
        expect(count("/filter/10020") + count(/agile/)).toBe(0);
      });

      test("a search with no restriction is refused with no request", async () => {
        const r = await B.addViewByUrl(`https://${site}/issues/?jql=${encodeURIComponent("ORDER BY key")}`);
        expect(r.data).toMatchObject({ ok: false });
        expect(fake.requests.length).toBe(0);
      });

      test("adding the same address again replaces it", async () => {
        await B.addViewByChoice("filter", "10020");
        await B.addViewByUrl(`https://${site}/issues/?filter=10020`);
        expect(V.savedViews(site).filter((v) => v.id === "filter:10020").length).toBe(1);
      });
    });

    describe("the add-a-view list", () => {
      test("boards and favourite filters: two requests, then remembered", async () => {
        const r = await J.withStored((c) => B.viewChoices(c, ""));
        expect(r.ok).toBe(true);
        expect(r.data!.boards.map((b) => [b.id, b.name, b.type, b.projectKey])).toEqual([
          ["1", "ORBIT board", "kanban", "ORBIT"], ["2", "ACME sprint board", "scrum", "ACME"], ["3", "ORBIT sprint board", "scrum", "ORBIT"], ["4", "ACME ideas", "kanban", "ACME"],
        ]);
        expect(r.data!.filters.map((f) => f.id)).toEqual(["10020", "10030"]);
        expect(fake.requests.length).toBe(2);
        await J.withStored((c) => B.viewChoices(c, ""));
        expect(fake.requests.length).toBe(2);
      });

      test("a search narrows both lists", async () => {
        const r = await J.withStored((c) => B.viewChoices(c, "sprint"));
        expect(r.data!.boards.map((b) => b.id)).toEqual(["2", "3"]);
        expect(r.data!.filters).toEqual([]);
        const f = await J.withStored((c) => B.viewChoices(c, "bugs"));
        expect(f.data!.filters.map((x) => x.id)).toEqual(["10020"]);
      });

      test("one list failing returns the other with a sentence, and the failure is not remembered", async () => {
        fake.fail({ path: "/rest/agile/1.0/board", status: 500, times: 1 });
        const r = await J.withStored((c) => B.viewChoices(c, ""));
        expect(r.ok).toBe(true);
        expect(r.data!.boards).toEqual([]);
        expect(r.data!.filters.length).toBe(2);
        expect(r.data!.error).toContain("Boards");
        const healed = await J.withStored((c) => B.viewChoices(c, ""));
        expect(healed.data!.boards.length).toBe(4);
        expect(healed.data!.error).toBeUndefined();
      });

      test("both failing is a failure", async () => {
        fake.fail({ path: "/rest/agile/1.0/board", status: 500 });
        fake.fail({ path: "/filter/favourite", status: 500 });
        expect((await J.withStored((c) => B.viewChoices(c, ""))).ok).toBe(false);
      });

      test("projects to pick from, with names, from the one project list", async () => {
        const r = await J.withStored((c) => B.projectChoices(c));
        expect(r.data!.projects).toEqual([{ key: "ORBIT", name: "Orbit" }, { key: "ACME", name: "Acme Platform" }]);
        const before = fake.requests.length;
        await J.withStored((c) => B.projectChoices(c));
        expect(fake.requests.length).toBe(before);
      });
    });

    describe("projects as folders", () => {
      test("adding a project lists its boards and they appear as views", async () => {
        const r = await B.addFolderByKey("orbit");
        expect(r.ok).toBe(true);
        expect(r.data!.folder).toMatchObject({ id: "ORBIT", name: "Orbit", lists: [{ id: "1", name: "ORBIT board" }, { id: "3", name: "ORBIT sprint board" }] });
        expect(fake.requests.some((q) => q.path === "/rest/agile/1.0/board" && q.query.projectKeyOrId === "ORBIT")).toBe(true);
        const views = V.savedViews(site);
        expect(views.map((v) => v.id)).toEqual(["me:assigned", "board:1", "board:3"]);
        expect(views[1]).toMatchObject({ folderId: "ORBIT", folderName: "Orbit", url: `https://${site}/secure/RapidBoard.jspa?rapidView=1` });
        expect(B.jiraViews().folders.map((f) => f.id)).toEqual(["ORBIT"]);
      });

      test("a board pasted and also in the folder shows once, as the folder's", async () => {
        await addBoard("1");
        await B.addFolderByKey("ORBIT");
        expect(V.savedViews(site).filter((v) => v.id === "board:1").length).toBe(1);
        expect(V.savedViews(site).find((v) => v.id === "board:1")!.folderId).toBe("ORBIT");
      });

      test("a folder's board reads like any board", async () => {
        await B.addFolderByKey("ACME");
        fake.requests.length = 0;
        const r = await B.viewRead("board:2");
        expect(r.ok).toBe(true);
        expect(r.columns.map((c) => c.name)).toEqual(["To Do", "In Progress", "Done"]);
      });

      test("pages of boards are followed, up to two", async () => {
        const small = startFakeJira({ flavor, boardPageSize: 1 });
        try {
          await connect(small);
          const r = await B.addFolderByKey("ORBIT");
          expect(r.data!.folder.lists!.map((l: { id: string }) => l.id)).toEqual(["1", "3"]);
          expect(small.requests.filter((q) => q.path === "/rest/agile/1.0/board").length).toBe(2);
        } finally { J.__setJiraBase(null); await small.stop(); }
      });

      test("a project that is not there is a sentence and nothing is kept", async () => {
        expect(await B.addFolderByKey("NOPE")).toMatchObject({ ok: false, error: "No such project, or you cannot see it" });
        expect(await B.addFolderByKey("not a key")).toMatchObject({ ok: false });
        expect(V.savedFolders(site)).toEqual([]);
      });

      test("removing a folder takes its boards and their rows, not the ones pasted by hand", async () => {
        await B.addFolderByKey("ORBIT");
        await B.viewRead("board:3");
        await addBoard("1");
        B.removeFolderById("ORBIT");
        expect(V.savedViews(site).map((v) => v.id)).toEqual(["me:assigned", "board:1"]);
        expect(V.cachedFor(site, "board:3")).toBeUndefined();
      });

      test("order by inside a quoted phrase stays in the restriction", () => {
        expect(B.splitOrder('summary ~ "sort order by date" ORDER BY updated DESC')).toEqual({ restriction: 'summary ~ "sort order by date"', order: "ORDER BY updated DESC" });
        expect(B.splitOrder("summary ~ 'a \\' order by b'")).toEqual({ restriction: "summary ~ 'a \\' order by b'", order: "" });
      });

      test("a project's board has no row to remove: the answer is a sentence and its rows stay", async () => {
        await B.addFolderByKey("ORBIT");
        await B.viewRead("board:3");
        expect(B.removeViewById("board:3")).toEqual({ ok: false, error: "That board comes with its project; remove the project instead" });
        expect(V.cachedFor(site, "board:3")).toBeDefined();
        expect(V.savedViews(site).map((v) => v.id)).toContain("board:3");
        await addBoard("1");
        expect(B.removeViewById("board:1")).toEqual({ ok: true });
      });

      test("a refresh keeps the folder where it was", async () => {
        await B.addFolderByKey("ORBIT");
        await B.addFolderByKey("ACME");
        B.__resetFolderTried();
        const orbit = V.savedFolders(site).find((f) => f.id === "ORBIT")!;
        V.replaceFolder(site, { ...orbit, listsAt: Date.now() - 11 * 60_000 });
        const before = V.savedFolders(site).map((f) => f.id);
        expect(before).toEqual(["ORBIT", "ACME"]);
        await B.refreshJiraFoldersIfStale();
        expect(V.savedFolders(site).map((f) => f.id)).toEqual(before);
        expect(V.savedFolders(site).every((f) => (f.listsAt ?? 0) > Date.now() - 60_000)).toBe(true);
      });

      test("a disconnect while the refresh loop runs ends it", async () => {
        await B.addFolderByKey("ORBIT");
        await B.addFolderByKey("ACME");
        B.__resetFolderTried();
        for (const f of V.savedFolders(site)) V.replaceFolder(site, { ...f, listsAt: Date.now() - 11 * 60_000 });
        const old = V.savedFolders(site).map((f) => f.listsAt);
        fake.fail({ path: "/rest/agile/1.0/board", delayMs: 150, times: 1 });
        fake.requests.length = 0;
        const p = B.refreshJiraFoldersIfStale();
        await Bun.sleep(40);
        J.disconnectJira();
        await p;
        expect(V.savedFolders(site).map((f) => f.listsAt)).toEqual(old);
        expect(fake.requests.filter((q) => q.path === "/rest/agile/1.0/board").length).toBe(1);
      });

      test("a stale folder is read again in the background, a fresh one is not", async () => {
        await B.addFolderByKey("ORBIT");
        fake.requests.length = 0;
        B.__resetFolderTried();
        await B.refreshJiraFoldersIfStale();
        expect(fake.requests.length).toBe(0);
        const f = V.savedFolders(site)[0];
        V.addFolder(site, { ...f, lists: [{ id: "1", name: "ORBIT board" }], listsAt: Date.now() - 11 * 60_000 });
        expect(V.savedViews(site).map((v) => v.id)).toEqual(["me:assigned", "board:1"]);
        await B.refreshJiraFoldersIfStale();
        expect(fake.requests.filter((q) => q.path === "/rest/agile/1.0/board").length).toBe(1);
        expect(V.savedViews(site).map((v) => v.id)).toEqual(["me:assigned", "board:1", "board:3"]);
        expect(V.savedFolders(site)[0].addedAt).toBe(f.addedAt);
      });

      test("reading the rail asks Jira for nothing when nothing is stale", async () => {
        await B.addFolderByKey("ORBIT");
        await addBoard("2");
        fake.requests.length = 0;
        B.jiraViews();
        await B.refreshJiraFoldersIfStale();
        expect(fake.requests.length).toBe(0);
      });
    });
  });
}
