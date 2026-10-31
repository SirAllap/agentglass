/*
 * Jira spaces, in process: the list the person keeps, the picker, a project's
 * tree of components and epics, and an epic's cards. All reads; the only thing
 * written is the local settings file.
 *
 * What is counted is requests at the stand-in: the budget is part of the
 * behaviour (a tree read cold is the components and the pages of epics and of
 * cards, whatever the number of components; read again it is nothing).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPACE_KEY_MAX } from "../../shared/jiraSpaces.ts";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeIssue, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-spaces-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB", "AGENTGLASS_JIRA_BASE", "AGENTGLASS_JIRA_WRITE"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");
delete process.env.AGENTGLASS_JIRA_BASE;
delete process.env.AGENTGLASS_JIRA_WRITE;

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");
const S = await import("../src/jiraSpaces.ts");

const credFile = join(dir, "creds.json");
const settingsFile = join(dir, "jira-settings.json");

afterAll(() => {
  C.__clearAll();
  C.__setCredentialsPath(null);
  J.__setJiraSettingsPath(null);
  J.__setJiraBase(null);
  J.__setJiraGuard(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

let nextId = 40000;
/** An issue with everything the stand-in needs and nothing a test has not said. */
const issue = (key: string, issueType: string, o: Partial<FakeIssue> = {}): FakeIssue => ({
  id: String(nextId++), key, projectKey: key.split("-")[0]!, summary: `${issueType} ${key}`, issueType, priorityId: "3", labels: [], parentKey: null,
  reporter: "acc-0001", created: "2026-01-05T09:00:00.000+0000", statusId: "1", assignee: null, resolution: null, description: null,
  updated: "2026-01-12T09:00:00.000+0000", comments: [], rank: `0|${key}:`, sprints: [], points: null, pointsIn: "primary", team: null, subtasks: [], ...o,
});
// Status ids of the stand-in's one workflow: 1 To Do, 2 In Progress, 4 QA, 5 Done (the only one in the done category).
const TODO = "1", DOING = "2", QA = "4", DONE = "5";

/**
 * Orbit: three components (one with nothing in it), five epics (one Done, two
 * without cards), and cards that sit in several, in one, in none, and under no
 * epic. ORBIT-16 is a sub-task: it is not a card of the tree.
 */
function orbit(f: FakeJira): void {
  for (const k of Object.keys(f.state.issues)) delete f.state.issues[k];
  f.state.projectComponents.ORBIT = [{ id: "20001", name: "Api" }, { id: "20002", name: "Web" }, { id: "20003", name: "Docs" }];
  const put = (i: FakeIssue) => { f.state.issues[i.key] = i; };
  put(issue("ORBIT-1", "Epic", { summary: "Reports", statusId: DOING }));
  put(issue("ORBIT-2", "Epic", { summary: "Search" }));
  put(issue("ORBIT-3", "Epic", { summary: "Legacy import", statusId: DONE }));
  put(issue("ORBIT-4", "Epic", { summary: "Lonely", components: ["Web"] }));
  put(issue("ORBIT-5", "Epic", { summary: "Ghost" }));
  put(issue("ORBIT-10", "Story", { parentKey: "ORBIT-1", components: ["Api", "Web"], statusId: DONE }));
  put(issue("ORBIT-11", "Story", { parentKey: "ORBIT-1", components: ["Api"] }));
  put(issue("ORBIT-12", "Task", { parentKey: "ORBIT-2", statusId: DOING }));
  put(issue("ORBIT-13", "Bug", { components: ["Web"] }));
  put(issue("ORBIT-14", "Task", { statusId: DONE }));
  put(issue("ORBIT-15", "Task", { parentKey: "ORBIT-3", components: ["Api"], statusId: DONE }));
  put(issue("ORBIT-16", "Sub-task", { parentKey: "ORBIT-11", components: ["Api"] }));
  put(issue("ORBIT-17", "Task", { parentKey: "ORBIT-1", components: ["Api"] }));
}

for (const flavor of ["cloud", "datacenter"] as const) {
  describe(`spaces, ${flavor}`, () => {
    const site = flavor === "cloud" ? "acme.atlassian.net" : "jira.acme.example";
    const searchPath = flavor === "cloud" ? "/search/jql" : "/search";
    let fake: FakeJira;

    const connect = async (f: FakeJira) => {
      C.__clearAll();
      J.__setJiraBase(f.base);
      const r = await J.connectJira(flavor === "cloud" ? { site, email: FAKE_EMAIL, token: FAKE_TOKEN } : { site, token: FAKE_PAT });
      expect(r.ok).toBe(true);
      f.requests.length = 0;
    };
    const count = (path: string | RegExp) => fake.requests.filter((r) => (typeof path === "string" ? r.path === path : path.test(r.path))).length;
    const components = (t: any) => Object.fromEntries(t.components.map((c: any) => [c.name, c]));
    const epicKeys = (c: any) => c.epics.map((e: any) => e.key);

    beforeAll(() => { fake = startFakeJira({ flavor }); });
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(credFile);
      J.__setJiraSettingsPath(settingsFile);
      rmSync(settingsFile, { force: true });
      J.__setJiraGuard(null);
      await connect(fake);
    });
    afterAll(async () => { await fake.stop(); });

    describe("the tree", () => {
      test("groups components, epics under each component they have cards in, and the two kinds of no", async () => {
        orbit(fake);
        const t = await S.jiraSpaceTreeStored("ORBIT", false, false);
        expect(t.ok).toBe(true);
        if (!t.ok) return;
        // Jira's order, then "No component" last.
        expect(t.components.map((c) => c.name)).toEqual(["Api", "Web", "Docs", "No component"]);
        const by = components(t);
        expect(by.Api).toMatchObject({ id: "20001", issues: 4, empty: false, noEpic: 0 });
        expect(epicKeys(by.Api)).toEqual(["ORBIT-1"]);
        // The same epic under both components its cards are in, with the same progress.
        expect(epicKeys(by.Web)).toEqual(["ORBIT-1", "ORBIT-4"]);
        expect(by.Api.epics[0]).toMatchObject({ key: "ORBIT-1", summary: "Reports", total: 3, done: 1, components: ["Api", "Web"], status: { name: "In Progress", category: "open" } });
        expect(by.Web.epics[0]).toMatchObject({ total: 3, done: 1 });
        expect(by.Web).toMatchObject({ issues: 2, noEpic: 1 });
        // An epic with no cards stays: under its own component, or under "No component".
        expect(by.Web.epics[1]).toMatchObject({ key: "ORBIT-4", total: 0, done: 0, components: [] });
        expect(by.Docs).toMatchObject({ id: "20003", issues: 0, empty: true, epics: [], noEpic: 0 });
        expect(by["No component"].id).toBeUndefined();
        expect(by["No component"]).toMatchObject({ issues: 2, noEpic: 1, empty: false });
        expect(epicKeys(by["No component"])).toEqual(["ORBIT-2", "ORBIT-5"]);
      });

      test("a card counts once in the space, whatever the number of components it is in", async () => {
        orbit(fake);
        const t = await S.jiraSpaceTreeStored("ORBIT", false, false);
        if (!t.ok) throw new Error(t.error);
        // 7 cards (the sub-task is not one): ORBIT-10 is in two components and counts once.
        expect(t.total).toBe(7);
        expect(t.done).toBe(3);
        expect(t.noEpic).toBe(2);
        expect(t.components.reduce((n, c) => n + c.issues, 0)).toBe(8);
      });

      test("an epic in the Done category is hidden unless asked for, and counted", async () => {
        orbit(fake);
        const hidden = await S.jiraSpaceTreeStored("ORBIT", false, false);
        const shown = await S.jiraSpaceTreeStored("ORBIT", false, true);
        if (!hidden.ok || !shown.ok) throw new Error("read failed");
        expect(hidden.hidDone).toBe(1);
        expect(hidden.components.flatMap(epicKeys)).not.toContain("ORBIT-3");
        expect(shown.hidDone).toBe(0);
        expect(epicKeys(components(shown).Api)).toEqual(["ORBIT-1", "ORBIT-3"]);
        expect(components(shown).Api.epics[1]).toMatchObject({ status: { category: "done" }, total: 1, done: 1 });
        // The cards under the hidden epic still count in the space.
        expect(hidden.total).toBe(shown.total);
      });

      test("an epic carries its assignee and reporter, and null for nobody", async () => {
        orbit(fake);
        // acc-0001 is the stand-in's default reporter; ORBIT-1 is given to acc-0002, ORBIT-2 to nobody.
        fake.state.issues["ORBIT-1"]!.assignee = "acc-0002";
        const t = await S.jiraSpaceTreeStored("ORBIT", false, false);
        expect(t.ok).toBe(true);
        if (!t.ok) return;
        const all = t.components.flatMap((c) => c.epics) as any[];
        const one = all.find((e) => e.key === "ORBIT-1");
        const two = all.find((e) => e.key === "ORBIT-2");
        expect(one.assignee).toMatchObject({ name: expect.any(String), key: flavor === "cloud" ? "acc-0002" : expect.any(String) });
        expect(one.reporter).not.toBeNull();
        expect(one.assignee.key).not.toBe(one.reporter.key);
        expect(two.assignee).toBeNull();
        expect(two.reporter).not.toBeNull();
      });

      test("request budget: cold is the components and the pages; again, and the Done toggle, are nothing", async () => {
        orbit(fake);
        await S.jiraSpaceTreeStored("ORBIT", false, false);
        // 1 components + 2 pages of 5 epics + 2 pages of 7 cards, at 4 an issue page. Nothing per component or per epic.
        expect(fake.requests.length).toBe(5);
        expect(count("/project/ORBIT/components")).toBe(1);
        expect(count(searchPath)).toBe(4);
        fake.requests.length = 0;
        await S.jiraSpaceTreeStored("ORBIT", false, false);
        await S.jiraSpaceTreeStored("ORBIT", false, true);
        expect(fake.requests.length).toBe(0);
        // `fresh` asks again.
        await S.jiraSpaceTreeStored("ORBIT", true, false);
        expect(fake.requests.length).toBe(5);
      });

      test("the epics and the cards are each one search, whose fields are only the ones the tree draws", async () => {
        orbit(fake);
        await S.jiraSpaceTreeStored("ORBIT", false, false);
        const asks = fake.requests.filter((r) => r.path === searchPath).map((r) => r.body as { jql: string; fields: string[] });
        expect(new Set(asks.map((a) => a.jql))).toEqual(new Set([
          "project = ORBIT AND issuetype = Epic ORDER BY key ASC",
          "project = ORBIT AND issuetype != Epic AND issuetype not in subTaskIssueTypes() ORDER BY key ASC",
        ]));
        expect(asks.find((a) => /Epic ORDER/.test(a.jql))!.fields).toEqual(["summary", "status", "components", "assignee", "reporter"]);
        expect(asks.find((a) => /!= Epic/.test(a.jql))!.fields).toEqual(["parent", "status", "components", "issuetype"]);
      });

      test("two readers of one space at once share one chain of requests", async () => {
        orbit(fake);
        const [a, b] = await Promise.all([S.jiraSpaceTreeStored("ORBIT", false, false), S.jiraSpaceTreeStored("ORBIT", false, true)]);
        expect(a.ok && b.ok).toBe(true);
        expect(fake.requests.length).toBe(5);
      });

      test("a project with nothing in it is an empty tree, not an error", async () => {
        for (const k of Object.keys(fake.state.issues)) delete fake.state.issues[k];
        const t = await S.jiraSpaceTreeStored("ORBIT", false, false);
        expect(t).toMatchObject({ ok: true, total: 0, done: 0, noEpic: 0, hidDone: 0, components: [] });
      });

      test("a key that is not a project key is refused before any request", async () => {
        for (const bad of ["", "orbit", "ORB-1", "ORBIT AND 1=1", "A".repeat(SPACE_KEY_MAX + 1), "../x"]) {
          expect(await S.jiraSpaceTreeStored(bad, false, false)).toEqual({ ok: false, error: "That is not a Jira project key" });
        }
        expect(fake.requests.length).toBe(0);
      });

      test("not connected says so", async () => {
        C.__clearAll();
        expect(await S.jiraSpaceTreeStored("ORBIT", false, false)).toEqual({ ok: false, error: J.NOT_CONNECTED });
        expect(await S.jiraEpicCardsStored("ORBIT-1")).toEqual({ ok: false, error: J.NOT_CONNECTED });
        expect(await S.jiraSpacePickerStored("")).toMatchObject({ ok: false, error: J.NOT_CONNECTED });
      });

      test("a project that is not there is that space's own error", async () => {
        const t = await S.jiraSpaceTreeStored("NOPE", false, false);
        expect(t.ok).toBe(false);
        expect(fake.requests.length).toBe(1);
      });
    });

    describe("a space that fails is its own failure", () => {
      test("one space fails; the list and the other space are fine", async () => {
        orbit(fake);
        fake.state.projectComponents.ACME = [];
        expect(await S.spacesEdit({ add: "ORBIT" })).toMatchObject({ ok: true });
        expect(await S.spacesEdit({ add: "ACME" })).toMatchObject({ ok: true });
        fake.fail({ path: "/project/ACME/components", status: 500 });
        const bad = await S.jiraSpaceTreeStored("ACME", false, false);
        const good = await S.jiraSpaceTreeStored("ORBIT", false, false);
        expect(bad).toEqual({ ok: false, error: "Could not reach Jira" });
        expect(good.ok).toBe(true);
        expect(S.spacesList().spaces.map((s) => s.key)).toEqual(["ORBIT", "ACME"]);
      });

      test("a failure after a good read says when the good one was, and a page that fails is never a short tree", async () => {
        orbit(fake);
        const first = await S.jiraSpaceTreeStored("ORBIT", false, false);
        if (!first.ok) throw new Error(first.error);
        // The first page of epics fails: the whole read is the failure.
        fake.fail({ path: searchPath, status: 500, times: 1 });
        const second = await S.jiraSpaceTreeStored("ORBIT", true, false);
        expect(second).toEqual({ ok: false, error: "Could not reach Jira", staleAt: first.readAt });
        // Nothing was written over the held read.
        const third = await S.jiraSpaceTreeStored("ORBIT", false, false);
        expect(third).toMatchObject({ ok: true, readAt: first.readAt });
      });

      test("a failure with nothing held has no staleAt", async () => {
        orbit(fake);
        fake.fail({ path: "/project/ORBIT/components", status: 500 });
        expect(await S.jiraSpaceTreeStored("ORBIT", false, false)).toEqual({ ok: false, error: "Could not reach Jira" });
      });

      test("429 is throttled, with Jira's sentence; the next space waits out the hold without a request", async () => {
        orbit(fake);
        fake.fail({ path: "/project/ORBIT/components", status: 429, retryAfter: 30 });
        const t = await S.jiraSpaceTreeStored("ORBIT", false, false);
        expect(t).toMatchObject({ ok: false, throttled: true });
        expect(!t.ok && t.error).toContain("30s");
        expect(fake.requests.length).toBe(1);
        const other = await S.jiraSpaceTreeStored("ACME", false, false);
        expect(other).toMatchObject({ ok: false, throttled: true });
        expect(fake.requests.length).toBe(1);
        // A read the person asked for again goes out.
        J.forgetJira();
        fake.reset();
        orbit(fake);
        expect((await S.jiraSpaceTreeStored("ORBIT", true, false)).ok).toBe(true);
      });
    });

    describe("an epic's cards", () => {
      /** Epic 1 holds four cards and a sub-task pair; ORBIT-11 is flagged, ORBIT-16 is in QA. */
      function epicWorld(): void {
        for (const k of Object.keys(fake.state.issues)) delete fake.state.issues[k];
        const put = (i: FakeIssue) => { fake.state.issues[i.key] = i; };
        put(issue("ORBIT-1", "Epic", { statusId: DOING }));
        put(issue("ORBIT-10", "Story", { parentKey: "ORBIT-1", statusId: TODO }));
        put(issue("ORBIT-11", "Bug", { parentKey: "ORBIT-1", statusId: DOING, flagged: "Impediment" }));
        put(issue("ORBIT-12", "Task", { parentKey: "ORBIT-1", statusId: DONE }));
        put(issue("ORBIT-13", "Task", { parentKey: "ORBIT-1", statusId: TODO, subtasks: ["ORBIT-18", "ORBIT-19"] }));
        put(issue("ORBIT-16", "Task", { parentKey: "ORBIT-1", statusId: QA }));
        put(issue("ORBIT-18", "Sub-task", { parentKey: "ORBIT-13" }));
        put(issue("ORBIT-19", "Sub-task", { parentKey: "ORBIT-13", statusId: DONE }));
        put(issue("ORBIT-20", "Task", { statusId: TODO }));
      }

      test("flagged first, then the project's own status order, then by key; sub-tasks hang from their card", async () => {
        epicWorld();
        const r = await S.jiraEpicCardsStored("orbit-1");
        if (!r.ok) throw new Error(r.error);
        expect(r.epic).toBe("ORBIT-1");
        expect(r.cards.map((c) => c.task.customId)).toEqual(["ORBIT-11", "ORBIT-10", "ORBIT-13", "ORBIT-16", "ORBIT-12"]);
        expect(r.cards.map((c) => c.blocked)).toEqual([true, false, false, false, false]);
        expect(r.cards.map((c) => c.type)).toEqual(["Bug", "Story", "Task", "Task", "Task"]);
        const withSubs = r.cards.find((c) => c.task.customId === "ORBIT-13")!;
        expect(withSubs.subtasks.map((s) => s.customId)).toEqual(["ORBIT-18", "ORBIT-19"]);
        expect(withSubs.subtasks[1]).toMatchObject({ statusKind: "done", parent: { key: "ORBIT-13" } });
        // A sub-task is nested, never a card of the list; a card of another epic is not here.
        expect(r.cards.some((c) => ["ORBIT-18", "ORBIT-20"].includes(c.task.customId!))).toBe(false);
      });

      test("request budget: the cards, one search for every sub-task, and the statuses", async () => {
        epicWorld();
        await S.jiraEpicCardsStored("ORBIT-1");
        const asks = fake.requests.filter((r) => r.path === searchPath).map((r) => (r.body as { jql: string }).jql);
        // 5 cards at 4 a page, then one search for the one card that has sub-tasks.
        expect(asks).toEqual(["parent = ORBIT-1 ORDER BY key ASC", "parent = ORBIT-1 ORDER BY key ASC", "parent in (ORBIT-13) ORDER BY key ASC"]);
        expect(count("/project/ORBIT/statuses")).toBe(1);
      });

      test("no sub-tasks, no sub-task search", async () => {
        epicWorld();
        fake.state.issues["ORBIT-13"]!.subtasks = [];
        await S.jiraEpicCardsStored("ORBIT-1");
        expect(fake.requests.filter((r) => r.path === searchPath && /parent in/.test((r.body as { jql: string }).jql)).length).toBe(0);
      });

      test("a status that says it is blocked is blocked", () => {
        expect(S.blockedCard({ status: "Blocked", flagged: undefined })).toBe(true);
        expect(S.blockedCard({ status: "Blocked by legal", flagged: undefined })).toBe(true);
        expect(S.blockedCard({ status: "In Progress", flagged: true })).toBe(true);
        expect(S.blockedCard({ status: "In Progress", flagged: undefined })).toBe(false);
      });

      test("a key that is not a card id is refused before any request", async () => {
        for (const bad of ["", "ORBIT", "ORBIT-1 OR 1=1", "../x"]) expect(await S.jiraEpicCardsStored(bad)).toEqual({ ok: false, error: "That is not a Jira card id" });
        expect(fake.requests.length).toBe(0);
      });

      test("429 is throttled", async () => {
        epicWorld();
        fake.fail({ path: searchPath, status: 429, retryAfter: 30 });
        expect(await S.jiraEpicCardsStored("ORBIT-1")).toMatchObject({ ok: false, throttled: true });
      });
    });

    describe("a place in the tree is a list of its own", () => {
      const J2 = async () => await import("../src/jiraboards.ts");
      const keys = async (id: string) => {
        const r = await (await J2()).viewRead(id, { force: true });
        expect(r.ok).toBe(true);
        return r.tasks.map((t) => t.customId ?? "").sort();
      };

      test("space, component, no component, epic, epic in a component and no epic each read their own cards", async () => {
        orbit(fake);
        // One epic spanning three components: the whole epic is every card, a component's share is only its own.
        fake.state.issues["ORBIT-18"] = issue("ORBIT-18", "Task", { parentKey: "ORBIT-1", components: ["Docs"] });
        expect(await keys("scope:ORBIT")).toEqual(["ORBIT-10", "ORBIT-11", "ORBIT-12", "ORBIT-13", "ORBIT-14", "ORBIT-15", "ORBIT-16", "ORBIT-17", "ORBIT-18"].sort());
        expect(await keys("scope:ORBIT|c:Web")).toEqual(["ORBIT-10", "ORBIT-13"]);
        expect(await keys("scope:ORBIT|c:")).toEqual(["ORBIT-12", "ORBIT-14"]);
        expect(await keys("scope:ORBIT|e:ORBIT-1")).toEqual(["ORBIT-10", "ORBIT-11", "ORBIT-17", "ORBIT-18"]);
        expect(await keys("scope:ORBIT|c:Api|e:ORBIT-1")).toEqual(["ORBIT-10", "ORBIT-11", "ORBIT-17"]);
        expect(await keys("scope:ORBIT|c:Web|n")).toEqual(["ORBIT-13"]);
      });

      test("each card says its components and its epic, so the list can be filtered by them", async () => {
        orbit(fake);
        const r = await (await J2()).viewRead("scope:ORBIT|e:ORBIT-1", { force: true });
        const by = Object.fromEntries(r.tasks.map((t) => [t.customId, t]));
        expect(by["ORBIT-10"]!.components).toEqual(["Api", "Web"]);
        expect(by["ORBIT-10"]!.parent).toMatchObject({ key: "ORBIT-1", type: "Epic" });
        expect(by["ORBIT-11"]!.components).toEqual(["Api"]);
      });

      test("it is never saved and never becomes the current view", async () => {
        orbit(fake);
        const B = await J2();
        const V = await import("../src/jiraviews.ts");
        const before = V.currentView(site);
        await B.viewRead("scope:ORBIT|c:Api", { force: true });
        expect(V.currentView(site)).toBe(before);
        expect(V.savedViews(site).some((v) => v.id.startsWith("scope:"))).toBe(false);
      });

      test("an id that is not one this code wrote is not sent as a search", async () => {
        const B = await J2();
        for (const bad of ["scope:orbit", "scope:ORBIT|c:a\u0000b", "scope:ORBIT|e:x", "scope:ORBIT|q:1", "scope:ORBIT OR 1=1"]) {
          expect(await B.viewRead(bad, { force: true })).toMatchObject({ ok: false });
        }
        expect(fake.requests.filter((r) => r.path === searchPath).length).toBe(0);
      });
    });
  });
}

// The cases below do not depend on the personality of the site: Cloud's paged picker is the one with pages.
describe("the list and the picker", () => {
  let fake: FakeJira;
  const readSettings = () => JSON.parse(readFileSync(settingsFile, "utf8"));
  const paths = (p: string) => fake.requests.filter((r) => r.path === p).length;
  const keys = () => S.spacesList().spaces.map((s) => s.key);

  beforeAll(() => { fake = startFakeJira(); });
  beforeEach(async () => {
    fake.reset();
    C.__setCredentialsPath(credFile);
    J.__setJiraSettingsPath(settingsFile);
    rmSync(settingsFile, { force: true });
    J.__setJiraGuard(null);
    C.__clearAll();
    J.__setJiraBase(fake.base);
    expect((await J.connectJira({ site: "acme.atlassian.net", email: FAKE_EMAIL, token: FAKE_TOKEN })).ok).toBe(true);
    fake.requests.length = 0;
  });
  afterAll(async () => { await fake.stop(); });

  test("nothing added is an empty list, and nothing is written for a read", () => {
    expect(S.spacesList()).toEqual({ ok: true, spaces: [] });
    expect(existsSync(settingsFile)).toBe(false);
  });

  test("add keeps the name and the picture, in the order added; again is not a second one", async () => {
    expect(await S.spacesEdit({ add: "ORBIT" })).toEqual({ ok: true, spaces: [{ key: "ORBIT", name: "Orbit", avatarUrl: "https://avatar.acme.example/project/ORBIT/48.png" }] });
    expect(await S.spacesEdit({ add: "ACME" })).toMatchObject({ ok: true });
    expect(await S.spacesEdit({ add: "ORBIT" })).toMatchObject({ ok: true });
    expect(keys()).toEqual(["ORBIT", "ACME"]);
    expect(readSettings().spaces.map((s: { key: string }) => s.key)).toEqual(["ORBIT", "ACME"]);
    // The settings file's other keys are kept.
    J.writeSettingsKey("counted", ["ORBIT"]);
    await S.spacesEdit({ remove: "ACME" });
    expect(readSettings().counted).toEqual(["ORBIT"]);
  });

  test("add reads the one project when the picker's list is not remembered, and the list when it is", async () => {
    await S.spacesEdit({ add: "ORBIT" });
    expect(paths("/project/ORBIT")).toBe(1);
    expect(paths("/project/search")).toBe(0);
    await S.jiraSpacePickerStored("");
    fake.requests.length = 0;
    await S.spacesEdit({ add: "ACME" });
    expect(fake.requests.length).toBe(0);
    expect(keys()).toEqual(["ORBIT", "ACME"]);
  });

  test("add of a project that is not there, a bad key, or with no connection changes nothing", async () => {
    expect(await S.spacesEdit({ add: "NOPE" })).toEqual({ ok: false, error: "No Jira project with that key" });
    for (const bad of ["", "orbit", "ORB-1", "A".repeat(SPACE_KEY_MAX + 1), 7, null]) expect(await S.spacesEdit({ add: bad })).toMatchObject({ ok: false });
    C.__clearAll();
    expect(await S.spacesEdit({ add: "ORBIT" })).toEqual({ ok: false, error: J.NOT_CONNECTED });
    expect(existsSync(settingsFile)).toBe(false);
  });

  test("remove, and removing what is not there", async () => {
    await S.spacesEdit({ add: "ORBIT" });
    await S.spacesEdit({ add: "ACME" });
    expect((await S.spacesEdit({ remove: "NOPE" }))).toMatchObject({ ok: true });
    expect(keys()).toEqual(["ORBIT", "ACME"]);
    expect(await S.spacesEdit({ remove: "ORBIT" })).toMatchObject({ ok: true, spaces: [{ key: "ACME" }] });
    expect(await S.spacesEdit({ remove: "orbit" })).toMatchObject({ ok: false });
  });

  test("order is a permutation of what is there, or it is refused and nothing changes", async () => {
    await S.spacesEdit({ add: "ORBIT" });
    await S.spacesEdit({ add: "ACME" });
    expect(await S.spacesEdit({ order: ["ACME", "ORBIT"] })).toMatchObject({ ok: true });
    expect(keys()).toEqual(["ACME", "ORBIT"]);
    for (const bad of [["ACME"], ["ACME", "ACME"], ["ACME", "ORBIT", "ORBIT"], ["ACME", "ZED"], ["ACME", "ORBIT", "ZED"], [], "ACME,ORBIT", [1, 2]]) {
      expect(await S.spacesEdit({ order: bad })).toMatchObject({ ok: false });
    }
    expect(keys()).toEqual(["ACME", "ORBIT"]);
  });

  test("exactly one verb", async () => {
    for (const bad of [null, [], "add", {}, { add: "ORBIT", remove: "ORBIT" }, { add: "ORBIT", extra: 1 }, { nope: "ORBIT" }]) {
      expect(await S.spacesEdit(bad)).toMatchObject({ ok: false });
    }
    expect(existsSync(settingsFile)).toBe(false);
  });

  test("a settings file with rubbish in it reads as the spaces that are good", () => {
    J.writeSettingsKey("spaces", [{ key: "ORBIT", name: "Orbit" }, { key: "orbit", name: "x" }, "ACME", null, { key: "ORBIT", name: "again" }, { key: "ACME", name: "", avatarUrl: "javascript:alert(1)" }, { key: "A".repeat(SPACE_KEY_MAX + 1), name: "long" }]);
    expect(S.spacesList().spaces).toEqual([{ key: "ORBIT", name: "Orbit" }, { key: "ACME", name: "ACME" }]);
  });

  test("the count comes from the last tree read, and is absent before one", async () => {
    orbit(fake);
    await S.spacesEdit({ add: "ORBIT" });
    expect(S.spacesList().spaces[0]).not.toHaveProperty("count");
    await S.jiraSpaceTreeStored("ORBIT", false, false);
    expect(S.spacesList().spaces[0]!.count).toBe(7);
    J.forgetJira();
    expect(S.spacesList().spaces[0]).not.toHaveProperty("count");
  });

  test("the picker lists every project, with who is added, in as many pages as there are", async () => {
    fake.state.extraProjects = Array.from({ length: 60 }, (_, n) => ({ id: String(11000 + n), key: `ZED${n}`, name: `Zed ${n}` }));
    await S.spacesEdit({ add: "ACME" });
    fake.requests.length = 0;
    const r = await S.jiraSpacePickerStored("");
    if (!r.ok) throw new Error(r.error);
    expect(r.data!.length).toBe(62);
    expect(r.data!.filter((p) => p.added).map((p) => p.key)).toEqual(["ACME"]);
    expect(r.data![0]).toEqual({ key: "ORBIT", name: "Orbit", avatarUrl: "https://avatar.acme.example/project/ORBIT/48.png", added: false });
    // 62 projects at 50 a page is two requests; the second read is the memory's.
    expect(paths("/project/search")).toBe(2);
    expect(fake.requests.map((x) => x.query.startAt)).toEqual(["0", "50"]);
    await S.jiraSpacePickerStored("");
    expect(fake.requests.length).toBe(2);
  });

  test("a typed key that is in the list costs nothing; one that is not listed is read, and one that is not there is an error", async () => {
    fake.state.extraProjects = [{ id: "12000", key: "HIDDEN", name: "Hidden room", unlisted: true }];
    await S.jiraSpacePickerStored("");
    fake.requests.length = 0;
    expect(((await S.jiraSpacePickerStored("orb")) as { data: unknown[] }).data.length).toBe(2);
    expect(fake.requests.length).toBe(0);
    const hidden = await S.jiraSpacePickerStored("hidden");
    // "hidden" is a name fragment of nothing in the list, so it is taken for a key.
    expect(hidden).toMatchObject({ ok: true, data: [{ key: "HIDDEN", name: "Hidden room", added: false }, { key: "ORBIT" }, { key: "ACME" }] });
    expect(paths("/project/HIDDEN")).toBe(1);
    expect(await S.jiraSpacePickerStored("nope")).toMatchObject({ ok: false, error: "No Jira project with that key" });
    expect(await S.jiraSpacePickerStored("no pe!")).toMatchObject({ ok: false, error: "No Jira project with that key" });
  });

  test("a hidden project can be added by its key", async () => {
    fake.state.extraProjects = [{ id: "12000", key: "HIDDEN", name: "Hidden room", unlisted: true }];
    await S.jiraSpacePickerStored("");
    expect(await S.spacesEdit({ add: "HIDDEN" })).toMatchObject({ ok: true, spaces: [{ key: "HIDDEN", name: "Hidden room" }] });
  });

  test("a failing list is an error with its reason, and is not remembered", async () => {
    fake.fail({ path: "/project/search", status: 500, times: 1 });
    expect(await S.jiraSpacePickerStored("")).toMatchObject({ ok: false, error: "Could not reach Jira" });
    expect((await S.jiraSpacePickerStored("")).ok).toBe(true);
    fake.fail({ path: "/project/search", status: 429, retryAfter: 30 });
    J.forgetJira();
    expect(await S.jiraSpacePickerStored("")).toMatchObject({ ok: false, throttled: true });
  });
});

describe("through the gateway", () => {
  const CLOUD_ID = "6c1f0a52-3b7e-4d1a-9f0e-2a5b8c7d9e10";
  const GATEWAY = `https://api.atlassian.com/ex/jira/${CLOUD_ID}`;
  const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  let urls: string[] = [];

  beforeEach(async () => {
    urls = [];
    C.__setCredentialsPath(credFile);
    J.__setJiraSettingsPath(settingsFile);
    rmSync(settingsFile, { force: true });
    C.__clearAll();
    J.__setJiraBase(null);
    J.__setJiraGuard({
      resolver: async () => [{ address: "104.192.136.1", family: 4 }],
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.endsWith("/_edge/tenant_info")) return json({ cloudId: CLOUD_ID });
        if (!url.startsWith(GATEWAY)) return json({}, 401);
        if (url.endsWith("/myself")) return json({ accountId: "acc-0001", displayName: "Ada Example" });
        if (url.endsWith("/components")) return json([]);
        if (url.endsWith("/search/jql")) return json({ issues: [], isLast: true });
        if (url.endsWith("/project/ORBIT")) return json({ key: "ORBIT", name: "Orbit" });
        return json({}, 404);
      },
    });
    expect((await J.connectJira({ site: "acme.atlassian.net", email: "ada@example.com", token: "scoped-token-0001" })).ok).toBe(true);
    urls = [];
  });
  afterAll(() => { J.__setJiraGuard(null); });

  test("every request of a tree read, an epic's cards and an add goes to the gateway of the stored site", async () => {
    expect(await S.spacesEdit({ add: "ORBIT" })).toMatchObject({ ok: true });
    expect((await S.jiraSpaceTreeStored("ORBIT", true, false)).ok).toBe(true);
    expect((await S.jiraEpicCardsStored("ORBIT-1")).ok).toBe(true);
    expect(urls.length).toBeGreaterThan(4);
    expect(urls.filter((u) => !u.startsWith(`${GATEWAY}/rest/api/3/`))).toEqual([]);
  });
});
