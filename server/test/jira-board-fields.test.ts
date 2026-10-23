/*
 * What a board view carries beyond a card list: the site's own sprint and
 * points fields, what blocks what, the order the board keeps, and the statuses
 * of the view in the order to draw them. Run against both personalities of the
 * stand-in, with the requests counted at it: the budget is part of the
 * behaviour (a board read cold costs one request more than before, the
 * field list; read warm or forced it costs none).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_AUTH, FAKE_EMAIL, FAKE_PAT, FAKE_PAT_AUTH, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-board-fields-"));
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
  J.__setSearchComments(false);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const SITES: Record<FakeFlavor, string> = { cloud: "acme.atlassian.net", datacenter: "jira.acme.example" };
const F = await import("../src/jirafields.ts");

describe("the sprint a card is in", () => {
  const o = (id: number, name: string, state: string) => ({ id, name, state });
  test("the active sprint wins over a newer future one; with none active, the newest", () => {
    expect(F.sprintOf([o(3, "Sprint 3", "closed"), o(4, "Sprint 4", "active"), o(5, "Sprint 5", "future")])).toBe("Sprint 4");
    expect(F.sprintOf([o(2, "Sprint 2", "closed"), o(3, "Sprint 3", "closed")])).toBe("Sprint 3");
    expect(F.sprintOf([o(6, "Sprint 6", "future"), o(5, "Sprint 5", "future")])).toBe("Sprint 6");
    expect(F.sprintOf(null)).toBeUndefined();
    expect(F.sprintOf([])).toBeUndefined();
  });
  test("older Data Center sends the bean's text, and a name may hold a comma", () => {
    const bean = (id: number, state: string, name: string) => `com.atlassian.greenhopper.service.sprint.Sprint@1b2c[id=${id},rapidViewId=3,state=${state},name=${name},startDate=2026-01-05T09:00:00.000Z,endDate=<null>,completeDate=<null>,sequence=${id}]`;
    expect(F.sprintOf([bean(3, "CLOSED", "Sprint 3"), bean(4, "ACTIVE", "Sprint 4, the long one"), bean(5, "FUTURE", "Sprint 5")])).toBe("Sprint 4, the long one");
    expect(F.sprintOf(["not a bean"])).toBeUndefined();
  });
});

const keysOf = (tasks: { customId?: string }[]) => tasks.map((t) => t.customId);

for (const flavor of ["cloud", "datacenter"] as const) {
  describe(`board fields, ${flavor}`, () => {
    const site = SITES[flavor];
    const dc = flavor === "datacenter";
    const searchPath = dc ? "/search" : "/search/jql";
    let fake: FakeJira;
    let shuffled: FakeJira;

    const connect = async (f: FakeJira) => {
      C.__clearAll();
      J.__setJiraBase(f.base);
      const r = await J.connectJira(dc ? { site, token: FAKE_PAT } : { site, email: FAKE_EMAIL, token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      f.requests.length = 0;
    };
    const count = (path: string | RegExp, f: FakeJira = fake) => f.requests.filter((r) => (typeof path === "string" ? r.path === path : path.test(r.path))).length;
    const searches = (f: FakeJira = fake) => f.requests.filter((r) => r.path === searchPath);
    const addBoard = async (id: string) => { const r = await B.addViewByChoice("board", id); expect(r.data).toMatchObject({ ok: true }); fake.requests.length = 0; };
    const idOf = (key: string) => fake.state.issues[key]!.id;
    const task = (r: { tasks: { customId?: string }[] }, key: string) => r.tasks.find((t) => t.customId === key) as Record<string, unknown> & { order?: string };

    beforeAll(() => {
      fake = startFakeJira({ flavor });
      shuffled = startFakeJira({ flavor, shuffleProjectStatuses: true });
    });
    beforeEach(async () => {
      fake.reset();
      // These read a board as a column list; the sprint's own read is test/jira-board-sprint.test.ts.
      fake.state.sprints[3] = [];
      shuffled.reset();
      C.__setCredentialsPath(credFile);
      V.__setJiraViewsPath(viewsFile);
      V.__clear();
      J.__setJiraGuard(null);
      J.__setSearchComments(false);
      await connect(fake);
    });
    afterEach(() => { J.__setJiraBase(null); });
    afterAll(async () => { await fake.stop(); await shuffled.stop(); });

    describe("the cards", () => {
      test("sprint, points, dependencies, subtasks and order are read off the site's own fields", async () => {
        await addBoard("3");
        const r = await B.viewRead("board:3");
        expect(r.ok).toBe(true);
        // The active sprint wins over a closed one on the same card.
        expect(task(r, "ORBIT-1042")).toMatchObject({ sprint: "Sprint 4", points: 5 });
        expect(task(r, "ORBIT-1043")).toMatchObject({ sprint: "Sprint 4", points: 3, subtasks: 1 });
        // A future sprint is still the card's sprint; zero points is a value.
        expect(task(r, "ORBIT-1044")).toMatchObject({ sprint: "Sprint 5", points: 0 });
        // A card with none of them carries none of the keys, not an empty value.
        for (const k of ["sprint", "points", "subtasks", "waitsOn", "blocks"]) expect(k in task(r, "ORBIT-1001")).toBe(false);
        expect(task(r, "ORBIT-1043")).toMatchObject({ waitsOn: [idOf("ORBIT-1042")], blocks: [idOf("ORBIT-1044")] });
        // Its other blocker is done, so only the open one is waited on.
        expect(task(r, "ORBIT-1044").waitsOn).toEqual([idOf("ORBIT-1043")]);
        expect(task(r, "ORBIT-1042").waitsOn).toBeUndefined();
        expect(task(r, "ORBIT-1042").blocks).toEqual([idOf("ORBIT-1043")]);
        // A link that is not a Blocks link says nothing about waiting.
        expect(task(r, "ORBIT-1046").waitsOn).toBeUndefined();
      });

      test("a board that counts in its second field reads the points from there", async () => {
        await addBoard("2");
        const r = await B.viewRead("board:2");
        expect(task(r, "ACME-7")).toMatchObject({ points: 2, sprint: "ACME 1" });
        expect("points" in task(r, "ACME-8")).toBe(false);
        const sent = (searches()[0]!.body as { fields: string[] }).fields;
        expect(sent).toContain(dc ? "customfield_10109" : "customfield_10027");
        expect(sent).not.toContain(dc ? "customfield_10106" : "customfield_10016");
      });

      test("a view that is not a board takes the site's first points field by type, and asks for no other", async () => {
        const a = await B.addViewByUrl(`https://${site}/issues/?jql=${encodeURIComponent("project = ORBIT ORDER BY key")}`);
        const r = await B.viewRead((a.data as { view: { id: string } }).view.id);
        expect(task(r, "ORBIT-1042")).toMatchObject({ points: 5 });
        const sent = (searches().at(-1)!.body as { fields: string[] }).fields;
        expect(sent).toEqual(expect.arrayContaining(["issuelinks", "subtasks", dc ? "customfield_10104" : "customfield_10020"]));
        expect(sent).not.toContain("comment");
        expect(sent).not.toContain("*all");
      });

      test("order is the arrival index of a rank-ordered search, across pages, and follows a moved card", async () => {
        await addBoard("1");
        const r = await B.viewRead("board:1");
        expect(keysOf(r.tasks)).toEqual(["ORBIT-1001", "ORBIT-1042", "ORBIT-1043", "ORBIT-1044", "ORBIT-1045", "ORBIT-1046", "ORBIT-1050"]);
        expect(r.tasks.map((t) => t.order)).toEqual(["000000", "000001", "000002", "000003", "000004", "000005", "000006"]);
        expect(searches().length).toBe(2); // more than one page, so the index carried over
        fake.state.issues["ORBIT-1050"]!.rank = "0|a00000:";
        const again = await B.viewRead("board:1", { force: true });
        expect(keysOf(again.tasks)[0]).toBe("ORBIT-1050");
        expect(task(again, "ORBIT-1050").order).toBe("000000");
      });

      test("a search that is not ordered by rank has no order", async () => {
        const a = await B.addViewByUrl(`https://${site}/issues/?jql=${encodeURIComponent("project = ORBIT ORDER BY key")}`);
        const r = await B.viewRead((a.data as { view: { id: string } }).view.id);
        expect(r.tasks.every((t) => t.order === undefined)).toBe(true);
      });

      test("a site with no sprint field and no points field asks for neither, fails no request and sets neither", async () => {
        fake.state.fields = fake.state.fields.filter((f) => !/gh-sprint|jsw-story-points|float/.test(String(f.schema?.custom)));
        await addBoard("1");
        const r = await B.viewRead("board:1");
        expect(r.ok).toBe(true);
        expect(r.tasks.length).toBeGreaterThan(0);
        expect(r.tasks.every((t) => t.sprint === undefined && t.points === undefined)).toBe(true);
        const sent = (searches()[0]!.body as { fields: string[] }).fields;
        // The flag is the one custom field left, and it is asked for by what it is on this site.
        const flag = fake.state.fields.find((f) => /^flagged$/i.test(String(f.name)))!.id;
        expect(sent.filter((f) => f.startsWith("customfield_"))).toEqual([flag]);
      });

      test("a field list that cannot be read costs the fields, never the board", async () => {
        fake.fail({ path: "/field", status: 403 });
        await addBoard("1");
        const r = await B.viewRead("board:1");
        expect(r.ok).toBe(true);
        expect(r.tasks.length).toBeGreaterThan(0);
        expect(r.tasks.every((t) => t.sprint === undefined && t.points === undefined)).toBe(true);
      });
    });

    describe("the statuses of a view", () => {
      const names = (r: { statuses?: { status: string }[] }) => (r.statuses ?? []).map((s) => s.status);

      test("a board lists its columns' statuses in column order, with the category's type and colour, though the project lists them shuffled", async () => {
        await connect(shuffled);
        fake = shuffled;
        await addBoard("3");
        const r = await B.viewRead("board:3");
        expect(names(r)).toEqual(["To Do", "In Progress", "In Review", "QA", "Done"]);
        expect(r.statuses!.map((s) => s.type)).toEqual(["open", "custom", "custom", "custom", "done"]);
        expect(r.statuses!.map((s) => s.orderindex)).toEqual([0, 1, 2, 3, 4]);
        expect(r.statuses![0]!.color).toBe("#42526e");
        expect(r.statuses!.at(-1)!.color).toBe("#36b37e");
      });

      test("a status no card wears is still listed, named by the project's own list, in column order", async () => {
        await connect(shuffled);
        fake = shuffled;
        await addBoard("2");
        const r = await B.viewRead("board:2");
        // Only the middle and last statuses have cards on this board.
        expect(keysOf(r.tasks).sort()).toEqual(["ACME-7", "ACME-8"]);
        expect(names(r)).toEqual(["To Do", "In Progress", "In Review", "QA", "Done"]);
        expect(count("/project/ACME/statuses")).toBe(1);
      });

      test("the order is the board's columns, not the workflow's", async () => {
        await connect(shuffled);
        fake = shuffled;
        await addBoard("2");
        // A board whose columns are in another order than the workflow's.
        fake.state.boards.find((b) => b.id === 2)!.columns = [
          { name: "Done", statusIds: ["5"] }, { name: "In Progress", statusIds: ["2", "3", "4"] }, { name: "To Do", statusIds: ["1"] },
        ];
        J.forgetJira();
        await connect(shuffled);
        const r = await B.viewRead("board:2");
        expect(names(r)).toEqual(["Done", "In Progress", "In Review", "QA", "To Do"]);
      });

      test("cold costs one request more than before when every status has a card (the field list), and two when one has none; warm and forced cost none", async () => {
        await addBoard("1");
        await B.viewRead("board:1");
        const prior = (f: FakeJira) => f.requests.filter((r) => r.path.startsWith("/priority")).length;
        // Before this: the filter, two search pages and the priorities (the board's configuration was read when it was added). Now the field list as well.
        expect(count("/field")).toBe(1);
        expect(count(/\/statuses$/)).toBe(0);
        expect(fake.requests.length).toBe(1 /* filter */ + 2 /* search */ + prior(fake) + 1 /* /field */ + 1 /* the active sprint, kept ten minutes and shared with the header */);

        fake.requests.length = 0;
        await B.viewRead("board:1");
        expect(fake.requests.length).toBe(0);

        fake.requests.length = 0;
        await B.viewRead("board:1", { force: true });
        expect(fake.requests.length).toBe(searches().length);
        expect(count("/field")).toBe(0);

        await addBoard("2");
        await B.viewRead("board:2");
        expect(count("/field")).toBe(0); // remembered across boards
        expect(count("/project/ACME/statuses")).toBe(1);
      });

      test("the field list is forgotten on a reconnect", async () => {
        await addBoard("1");
        await B.viewRead("board:1");
        J.forgetJira();
        await connect(fake);
        await B.viewRead("board:1", { force: true });
        expect(count("/field")).toBe(1);
      });

      test("a filter lists the statuses its cards wear by category, then name, and asks nobody about boards", async () => {
        const a = await B.addViewByUrl(`https://${site}/issues/?jql=${encodeURIComponent("project = ORBIT ORDER BY key")}`);
        fake.requests.length = 0;
        const r = await B.viewRead((a.data as { view: { id: string } }).view.id);
        expect(names(r)).toEqual(["To Do", "In Progress", "In Review", "QA", "Done"]);
        expect(count(/agile/)).toBe(0);
        expect(count(/\/statuses$/)).toBe(0);
      });

      test("where the project is a saved folder, its first board's column order comes first", async () => {
        await B.addFolderByKey("ORBIT");
        fake.state.boards.find((b) => b.id === 1)!.columns = [
          { name: "QA", statusIds: ["4"] }, { name: "To Do", statusIds: ["1"] }, { name: "Doing", statusIds: ["2", "3"] }, { name: "Done", statusIds: ["5"] },
        ];
        J.forgetJira();
        await connect(fake);
        const a = await B.addViewByUrl(`https://${site}/issues/?jql=${encodeURIComponent("project = ORBIT ORDER BY key")}`);
        const r = await B.viewRead((a.data as { view: { id: string } }).view.id);
        expect(names(r)).toEqual(["QA", "To Do", "In Progress", "In Review", "Done"]);
      });

      test("a view across several saved projects pays for one board configuration per read, and a board that fails is asked once", async () => {
        await B.addFolderByKey("ORBIT");
        await B.addFolderByKey("ACME");
        J.forgetJira();
        await connect(fake);
        const a = await B.addViewByUrl(`https://${site}/issues/?jql=${encodeURIComponent("assignee is not empty ORDER BY key")}`);
        const id = (a.data as { view: { id: string } }).view.id;
        const configs = () => count(/\/agile\/1\.0\/board\/\d+\/configuration$/);
        const projectsSeen = new Set((await B.viewRead(id)).tasks.map((t) => t.listId));
        expect(projectsSeen.size).toBeGreaterThan(1);
        // Cold: the search, the field list, and ONE configuration, not one per project.
        expect(configs()).toBe(1);
        expect(count("/field")).toBe(1);
        await B.viewRead(id, { force: true });
        expect(configs()).toBe(2); // the next project, found on the next read
        await B.viewRead(id, { force: true });
        expect(configs()).toBe(2); // every project known: nothing more
      });

      test("a board whose configuration is refused is not asked again on every read", async () => {
        await B.addFolderByKey("ORBIT");
        J.forgetJira();
        await connect(fake);
        fake.fail({ path: "/rest/agile/1.0/board/*", status: 404 });
        const a = await B.addViewByUrl(`https://${site}/issues/?jql=${encodeURIComponent("project = ORBIT ORDER BY key")}`);
        const id = (a.data as { view: { id: string } }).view.id;
        for (let i = 0; i < 3; i++) expect((await B.viewRead(id, { force: true })).ok).toBe(true);
        expect(count(/\/agile\/1\.0\/board\/\d+\/configuration$/)).toBe(1);
      });

      test("a field list that failed is not asked again on every read", async () => {
        fake.fail({ path: "/field", status: 403 });
        await addBoard("1");
        for (let i = 0; i < 3; i++) await B.viewRead("board:1", { force: true });
        expect(count("/field")).toBe(1);
      });

      test("assigned to me carries statuses too, from its own board-aware read, and /jira/mine's answer is not shared with it", async () => {
        const r = await B.viewRead();
        expect(r.ok).toBe(true);
        expect(names(r)).toContain("In Progress");
        const plain = await J.withStored((c) => J.mine(c));
        expect(plain.ok && plain.data && "seen" in plain.data).toBe(false);
        expect(plain.ok && plain.data!.tasks.every((t) => t.sprint === undefined)).toBe(true);
      });

      test("the statuses are kept with the read, and a failed read brings back the last ones", async () => {
        await addBoard("3");
        const first = await B.viewRead("board:3");
        expect(V.cachedFor(site, "board:3")!.statuses).toEqual(first.statuses);
        const cached = await B.viewRead("board:3", { cached: true });
        expect(cached.statuses).toEqual(first.statuses);
        fake.fail({ path: searchPath, status: 500 });
        const failed = await B.viewRead("board:3", { force: true });
        expect(failed).toMatchObject({ ok: false, cached: true });
        expect(failed.statuses).toEqual(first.statuses);
      });
    });

    describe("comments in the search", () => {
      const bulk = (n: number, per: number) => {
        for (let i = 0; i < n; i++) {
          const src = fake.state.issues["ACME-7"]!;
          const key = `ACME-${100 + i}`;
          fake.state.issues[key] = {
            ...structuredClone(src), id: String(40000 + i), key, summary: `Bulk card ${i}`, statusId: "1", sprints: [], points: null,
            rank: `0|z${String(i).padStart(5, "0")}:`,
            comments: Array.from({ length: per }, (_, c) => ({
              id: String(50000 + i * per + c), author: "acc-0002", created: src.created, updated: src.updated,
              body: dc ? `Comment ${c} on card ${i}: the retry loop still waits too long.` : { version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Comment ${c} on card ${i}: the retry loop still waits too long.` }] }] },
            })),
          };
        }
      };

      test("is off: a board's search does not ask for it, and when it is on the count is read and a zero stays a zero", async () => {
        bulk(3, 30);
        const jql = "project = ACME AND status in (1) ORDER BY key";
        const a = await B.addViewByUrl(`https://${site}/issues/?jql=${encodeURIComponent(jql)}`);
        const id = (a.data as { view: { id: string } }).view.id;
        const off = await B.viewRead(id);
        expect((searches().at(-1)!.body as { fields: string[] }).fields).not.toContain("comment");
        expect(off.tasks.every((t) => t.comments === undefined)).toBe(true);
        J.__setSearchComments(true);
        const on = await B.viewRead(id, { force: true });
        expect((searches().at(-1)!.body as { fields: string[] }).fields).toContain("comment");
        expect(on.tasks.map((t) => t.comments)).toEqual([30, 30, 30]);
      });

      test("the reason it is off: 100 cards of 30 comments each more than double the answer", async () => {
        bulk(100, 30);
        const big = startFakeJira({ flavor, pageSize: 100 });
        try {
          big.state.issues = fake.state.issues;
          const headers = { "content-type": "application/json", authorization: dc ? FAKE_PAT_AUTH : FAKE_AUTH };
          const bytes = async (fields: string[]) => {
            const url = dc ? `${big.api}/search` : `${big.api}/search/jql`;
            const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jql: "project = ACME AND status in (1)", fields, maxResults: 100 }) });
            const text = await res.text();
            expect(JSON.parse(text).issues).toHaveLength(100);
            return text.length;
          };
          await J.withStored(async (c) => J.searchJql(c, "project = ACME AND status in (1) ORDER BY Rank ASC", { board: {} }));
          const sent = (fake.requests.filter((r) => r.path === searchPath).at(0)!.body as { fields: string[] }).fields;
          const without = await bytes(sent);
          const withComments = await bytes([...sent, "comment"]);
          expect(withComments / without).toBeGreaterThan(2);
        } finally { await big.stop(); }
      });
    });
  });
}
