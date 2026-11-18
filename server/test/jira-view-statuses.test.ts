/*
 * The columns a plain view (a search, a filter, "assigned to me") shows for a
 * project, when that project is not a saved folder: they should still follow
 * a board's column order, found on the site, not fall back to category then
 * alphabetical order. And when a project has no board at all, the fallback
 * itself must never let a status named "Done" land ahead of another status
 * in the done category by alphabet.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-view-statuses-"));
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
const S = await import("../src/jiraSpaces.ts");
const { ASSIGNED_VIEW_ID: ASSIGNED } = await import("../../shared/providers.ts");

const credFile = join(dir, "creds.json");
const viewsFile = join(dir, "config", "agentglass", "jira-views.json");
const site = "acme.atlassian.net";
let fake: FakeJira;

beforeAll(() => { fake = startFakeJira(); });
beforeEach(async () => {
  fake.reset();
  C.__setCredentialsPath(credFile);
  V.__setJiraViewsPath(viewsFile);
  V.__clear();
  J.__setJiraGuard(null);
  C.__clearAll();
  J.__setJiraBase(fake.base);
  expect((await J.connectJira({ email: FAKE_EMAIL, site, token: FAKE_TOKEN })).ok).toBe(true);
  // ACME is never a saved folder in these tests: only its own board on the site may give its column order.
  expect(V.savedFolders(site)).toEqual([]);
});
afterEach(() => { J.__setJiraBase(null); });
afterAll(async () => {
  await fake.stop();
  C.__clearAll();
  C.__setCredentialsPath(null);
  V.__setJiraViewsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const addIssue = (key: string, statusId: string) => {
  const seed = fake.state.issues["ACME-7"]!;
  fake.state.issues[key] = { ...structuredClone(seed), key, id: `9${key.split("-")[1]}`, statusId, assignee: null, comments: [] };
};

describe("a project that is not a saved folder", () => {
  test("still follows its own board's column order, not category then alphabet", async () => {
    // A board for ACME whose column order is neither alphabetical nor category order, pushed first so the lookup finds it.
    fake.state.boards.unshift({
      id: 900, name: "ACME scrambled board", type: "kanban", projectKey: "ACME", filterId: "10011",
      columns: [
        { name: "QA", statusIds: ["4"] },
        { name: "In Review", statusIds: ["3"] },
        { name: "To Do", statusIds: ["1"] },
        { name: "In Progress", statusIds: ["2"] },
        { name: "Done", statusIds: ["5"] },
      ],
    } as (typeof fake.state.boards)[number]);
    addIssue("ACME-91", "1");
    addIssue("ACME-92", "2");
    addIssue("ACME-93", "3");
    addIssue("ACME-94", "4");
    // ACME-7 (status 2) and ACME-8 (status 5) are already seeded.

    const r = await B.viewRead("scope:ACME");
    expect(r.ok).toBe(true);
    expect((r.statuses ?? []).map((s) => s.status)).toEqual(["QA", "In Review", "To Do", "In Progress", "Done"]);
  });

  test("a status no column holds goes next to the board's columns of its category, not after Done", async () => {
    // The board shows "In Review" nowhere (a Blocked the workflow has and the board leaves out). It is in progress, so it
    // goes before the board's first in-progress column; before this it sorted after every placed column, Done included.
    fake.state.boards.unshift({
      id: 901, name: "ACME board without review", type: "kanban", projectKey: "ACME", filterId: "10011",
      columns: [
        { name: "To Do", statusIds: ["1"] },
        { name: "QA", statusIds: ["4"] },
        { name: "In Progress", statusIds: ["2"] },
        { name: "Done", statusIds: ["5"] },
      ],
    } as (typeof fake.state.boards)[number]);
    addIssue("ACME-91", "1");
    addIssue("ACME-93", "3");
    addIssue("ACME-94", "4");
    const r = await B.viewRead("scope:ACME");
    expect(r.ok).toBe(true);
    expect((r.statuses ?? []).map((s) => s.status)).toEqual(["To Do", "In Review", "QA", "In Progress", "Done"]);
    // Drawn between the steps, but not one: "Move to" from To Do skips it to QA, and a card in it is offered no next step.
    expect((r.statuses ?? []).filter((s) => s.offFlow).map((s) => s.status)).toEqual(["In Review"]);
  });

  test("when no board's filter is exactly this project, Automatic reads the board whose location is, not the first Jira listed", async () => {
    // The default fixture's ACME boards match "project = ACME" exactly: dropped so this test is about the fallback, not that tier.
    fake.state.boards = fake.state.boards.filter((b) => b.projectKey !== "ACME");
    // Pushed in this order so "Release" sits first: a naive "first" pick would land there, which is the bug this guards against.
    const release = {
      id: 960, name: "Release", type: "kanban", projectKey: "ACME", filterId: "10070", noLocation: true,
      columns: [{ name: "Backlog", statusIds: [] }, { name: "Doing", statusIds: ["2"] }, { name: "Done", statusIds: ["5"] }],
    };
    const acmeBoard = {
      id: 961, name: "ACME board", type: "kanban", projectKey: "ACME", filterId: "10060",
      columns: Array.from({ length: 13 }, (_, i) => ({ name: `Col ${i}`, statusIds: i === 0 ? ["1"] : i === 12 ? ["5"] : [] })),
    };
    fake.state.boards.unshift(release as unknown as (typeof fake.state.boards)[number], acmeBoard as (typeof fake.state.boards)[number]);
    const r = await B.viewRead("scope:ACME");
    expect(r.ok).toBe(true);
    expect(r.statusBoard).toMatchObject({ id: "961", name: "ACME board" });
  });
});

describe("a saved project with several boards in opposite column orders", () => {
  // Two custom ORBIT boards, pushed first so a naive "first" pick lands on A: only B's filter is ORBIT and nothing else.
  const boardA = {
    id: 950, name: "ORBIT board A", type: "kanban", projectKey: "ORBIT", filterId: "10010", // not project-only
    columns: [
      { name: "QA", statusIds: ["4"] },
      { name: "To Do", statusIds: ["1"] },
      { name: "In Progress", statusIds: ["2"] },
      { name: "In Review", statusIds: ["3"] },
      { name: "Done", statusIds: ["5"] },
    ],
  };
  const boardB = {
    id: 951, name: "ORBIT board B", type: "kanban", projectKey: "ORBIT", filterId: "10010", // project = ORBIT, nothing else
    columns: [
      { name: "To Do", statusIds: ["1"] },
      { name: "In Progress", statusIds: ["2"] },
      { name: "In Review", statusIds: ["3"] },
      { name: "QA", statusIds: ["4"] },
      { name: "Done", statusIds: ["5"] },
    ],
  };
  beforeEach(() => {
    fake.state.boards.unshift(boardB as (typeof fake.state.boards)[number], boardA as (typeof fake.state.boards)[number]);
  });

  test("Automatic picks the board whose filter is only this project, not the first one Jira listed", async () => {
    await B.addFolderByKey("ORBIT");
    const r = await B.viewRead("scope:ORBIT");
    expect(r.ok).toBe(true);
    expect((r.statuses ?? []).map((s) => s.status)).toEqual(["To Do", "In Progress", "In Review", "QA", "Done"]);
  });

  test("a board already opened wins over the filter-only rule", async () => {
    await B.addFolderByKey("ORBIT");
    V.putCache(site, "board:950", { view: { id: "board:950", name: "ORBIT board A", url: "", addedAt: 0 }, tasks: [], columns: [], at: Date.now() });
    const r = await B.viewRead("scope:ORBIT");
    expect(r.ok).toBe(true);
    expect((r.statuses ?? []).map((s) => s.status)).toEqual(["QA", "To Do", "In Progress", "In Review", "Done"]);
  });

});

describe("a project added only as a sidebar space (no legacy folder)", () => {
  const settingsFile = join(dir, "jira-settings.json");
  const boardA = {
    id: 950, name: "ORBIT board A", type: "kanban", projectKey: "ORBIT", filterId: "10010", // not project-only
    columns: [
      { name: "QA", statusIds: ["4"] },
      { name: "To Do", statusIds: ["1"] },
      { name: "In Progress", statusIds: ["2"] },
      { name: "In Review", statusIds: ["3"] },
      { name: "Done", statusIds: ["5"] },
    ],
  };
  const boardB = {
    id: 951, name: "ORBIT board B", type: "kanban", projectKey: "ORBIT", filterId: "10010", // project = ORBIT, nothing else
    columns: [
      { name: "To Do", statusIds: ["1"] },
      { name: "In Progress", statusIds: ["2"] },
      { name: "In Review", statusIds: ["3"] },
      { name: "QA", statusIds: ["4"] },
      { name: "Done", statusIds: ["5"] },
    ],
  };
  beforeEach(async () => {
    J.__setJiraSettingsPath(settingsFile);
    fake.state.boards.unshift(boardB as (typeof fake.state.boards)[number], boardA as (typeof fake.state.boards)[number]);
    const added = await S.spacesEdit({ add: "ORBIT" });
    expect(added.ok).toBe(true);
    expect(V.savedFolders(site)).toEqual([]); // no legacy folder: this project is a space only
  });
  afterEach(() => { J.__setJiraSettingsPath(null); });

  test("Automatic still reads the project's own boards, same as a saved folder would", async () => {
    const r = await B.viewRead("scope:ORBIT");
    expect(r.ok).toBe(true);
    expect((r.statuses ?? []).map((s) => s.status)).toEqual(["To Do", "In Progress", "In Review", "QA", "Done"]);
    expect(r.statusBoard).toEqual({ id: "951", name: "ORBIT board B", key: "ORBIT" });
  });

  test("the space's own Settings pick wins over Automatic", async () => {
    const picked = S.setSpaceColumnBoard("ORBIT", "950");
    expect(picked.ok).toBe(true);
    const r = await B.viewRead("scope:ORBIT", { force: true });
    expect(r.ok).toBe(true);
    expect((r.statuses ?? []).map((s) => s.status)).toEqual(["QA", "To Do", "In Progress", "In Review", "Done"]);
    expect(r.statusBoard).toEqual({ id: "950", name: "ORBIT board A", key: "ORBIT" });
  });

  test("clearing it back to Automatic drops the override", async () => {
    S.setSpaceColumnBoard("ORBIT", "950");
    S.setSpaceColumnBoard("ORBIT", undefined);
    const r = await B.viewRead("scope:ORBIT", { force: true });
    expect(r.ok).toBe(true);
    expect((r.statuses ?? []).map((s) => s.status)).toEqual(["To Do", "In Progress", "In Review", "QA", "Done"]);
  });
});

describe("a cold server whose board configuration has not arrived yet", () => {
  const board = {
    id: 900, name: "ACME scrambled board", type: "kanban", projectKey: "ACME", filterId: "10011",
    columns: [
      { name: "QA", statusIds: ["4"] },
      { name: "In Review", statusIds: ["3"] },
      { name: "To Do", statusIds: ["1"] },
      { name: "In Progress", statusIds: ["2"] },
      { name: "Done", statusIds: ["5"] },
    ],
  };
  const seedCards = () => { addIssue("ACME-91", "1"); addIssue("ACME-93", "3"); addIssue("ACME-94", "4"); };

  test("an answer without the board's order is not an answer: it is not painted, not kept, and the next one has the order", async () => {
    fake.state.boards.unshift(board as (typeof fake.state.boards)[number]);
    seedCards();
    fake.fail({ path: "/rest/agile/1.0/board/900/configuration", status: 500, times: 1 });
    const first = await B.viewRead("scope:ACME");
    // Today this is ok with category order (To Do, In Progress, QA ...): the order a moment later moves every column.
    expect(first.ok ? (first.statuses ?? []).map((s) => s.status) : []).toEqual([]);
    expect(first.ok).toBe(false);
    const second = await B.viewRead("scope:ACME", { force: true });
    expect(second.ok).toBe(true);
    expect((second.statuses ?? []).map((s) => s.status)).toEqual(["QA", "In Review", "To Do", "In Progress", "Done"]);
  });

  test("the cached copy kept on disk never carries a fallback order", async () => {
    fake.state.boards.unshift(board as (typeof fake.state.boards)[number]);
    seedCards();
    fake.fail({ path: "/rest/agile/1.0/board/900/configuration", status: 500, times: 1 });
    await B.viewRead("scope:ACME");
    expect(V.cachedFor(site, "scope:ACME")).toBeUndefined();
  });
});

describe("a board list Jira refuses", () => {
  const boardsPath = "/rest/agile/1.0/board";
  const seed = () => { addIssue("ACME-91", "1"); addIssue("ACME-94", "4"); };

  test("403/404 (board gone, access lost) falls back to the workflow order and paints once", async () => {
    seed();
    fake.fail({ path: boardsPath, status: 404, times: 50 });
    const r = await B.viewRead("scope:ACME");
    expect(r.ok).toBe(true);
    expect((r.statuses ?? []).length).toBeGreaterThan(0);
  });

  test("a 5xx is transient: nothing is painted, and the next read has the order", async () => {
    fake.state.boards.unshift({ id: 900, name: "ACME board", type: "kanban", projectKey: "ACME", filterId: "10011", columns: [{ name: "To Do", statusIds: ["1"] }, { name: "QA", statusIds: ["4"] }] } as (typeof fake.state.boards)[number]);
    seed();
    fake.fail({ path: boardsPath, status: 500, times: 1 });
    const first = await B.viewRead("scope:ACME");
    expect(first.ok).toBe(false);
    const second = await B.viewRead("scope:ACME", { force: true });
    expect(second.ok).toBe(true);
  });
});

describe("a project with no board at all", () => {
  test("keeps category order, but a status named Done is always last in the done category", async () => {
    fake.state.boards = fake.state.boards.filter((b) => b.projectKey !== "ACME");
    addIssue("ACME-96", "1"); // To Do, new
    addIssue("ACME-94", "6"); // In staging, done
    addIssue("ACME-95", "7"); // Ready for deployment, done
    // ACME-7 (status 2, In Progress) and ACME-8 (status 5, Done) are already seeded.

    const r = await B.viewRead("scope:ACME");
    expect(r.ok).toBe(true);
    expect((r.statuses ?? []).map((s) => s.status)).toEqual(["To Do", "In Progress", "In staging", "Ready for deployment", "Done"]);
  });
});

describe("\"Assigned to me\" across two projects", () => {
  const orbit = { id: 910, name: "ORBIT board", type: "kanban", projectKey: "ORBIT", filterId: "10010", columns: [
    { name: "QA", statusIds: ["4"] }, { name: "In Review", statusIds: ["3"] }, { name: "To Do", statusIds: ["1"] }, { name: "In Progress", statusIds: ["2"] }, { name: "Done", statusIds: ["5"] },
  ] };
  const acme = { id: 911, name: "ACME board", type: "kanban", projectKey: "ACME", filterId: "10011", columns: [
    { name: "To Do", statusIds: ["1"] }, { name: "In Progress", statusIds: ["2"] }, { name: "In Review", statusIds: ["3"] }, { name: "QA", statusIds: ["4"] }, { name: "Done", statusIds: ["5"] },
  ] };
  const mineOnly = (cards: [string, string][]) => {
    for (const i of Object.values(fake.state.issues)) i.assignee = "acc-0003";
    for (const [key, status] of cards) {
      addIssue(key, status);
      fake.state.issues[key]!.assignee = "acc-0001";
      fake.state.issues[key]!.projectKey = key.split("-")[0]!;
    }
  };
  const names = async () => {
    const r = await B.viewRead(ASSIGNED, { force: true });
    return r.ok ? (r.statuses ?? []).map((s) => s.status) : ["NOT OK"];
  };

  test("the project holding most of the cards gives the order, not the one wearing more different statuses", async () => {
    fake.state.boards.unshift(orbit as (typeof fake.state.boards)[number], acme as (typeof fake.state.boards)[number]);
    // ORBIT: three cards, one status. ACME: two cards, two statuses. Counted by status, ACME wins "main".
    mineOnly([["ORBIT-2001", "1"], ["ORBIT-2002", "1"], ["ORBIT-2003", "1"], ["ACME-2001", "2"], ["ACME-2002", "3"]]);
    expect(await names()).toEqual(["QA", "In Review", "To Do", "In Progress", "Done"]);
  });

  test("a status project A's board places keeps A's position when another project's card wears its own copy, and an empty board column stays", async () => {
    const order = ["Backlog", "Shaping", "In design", "Ready for engineering", "In development", "Code review", "Pre QA", "In QA", "READY FOR QA", "QA complete", "BLOCKED", "Ready for deployment", "In staging", "Done", "Won't do"];
    const cat = (n: string) => (["Backlog", "Shaping", "In design", "Ready for engineering"].includes(n) ? "new" : ["Done", "Won't do"].includes(n) ? "done" : "indeterminate");
    const wf = fake.state.workflow;
    const keep = structuredClone(wf.statuses);
    wf.statuses = [...order.map((name, i) => ({ id: String(100 + i), name, category: cat(name) })), { id: "200", name: "READY FOR QA", category: "indeterminate" }];
    // BLOCKED is a column of the board, but the workflow lists it under the Epic type alone.
    wf.epicOnly = [String(100 + order.indexOf("BLOCKED"))];
    try {
      const ids = (names: string[]) => names.map((n) => String(100 + order.indexOf(n)));
      const boardA = { id: 920, name: "ORBIT board", type: "kanban", projectKey: "ORBIT", filterId: "10010", columns: order.map((n) => ({ name: n, statusIds: ids([n]) })) };
      // Project B's own board puts its copy of Ready for QA ahead of In QA.
      const bOrder = ["Backlog", "Ready for QA", "In QA", "Done"];
      const boardB = { id: 921, name: "ACME board", type: "kanban", projectKey: "ACME", filterId: "10011", columns: [{ name: "Backlog", statusIds: ids(["Backlog"]) }, { name: "Ready for QA", statusIds: ["200"] }, { name: "In QA", statusIds: ids(["In QA"]) }, { name: "Done", statusIds: ids(["Done"]) }] };
      void bOrder;
      fake.state.boards.unshift(boardA as (typeof fake.state.boards)[number], boardB as (typeof fake.state.boards)[number]);
      const cards: [string, string][] = [];
      for (let i = 0; i < 6; i++) cards.push([`ORBIT-${3001 + i}`, ids([order[i % 8]!])[0]!]);
      for (let i = 0; i < 3; i++) cards.push([`ACME-${3001 + i}`, "200"]);
      mineOnly(cards);
      // Every read pays for at most one new board configuration: the second project's board is read from the second read on.
      for (let i = 0; i < 3; i++) { const n = await names(); expect(n).toEqual(order); }
    } finally { wf.statuses = keep; delete wf.epicOnly; }
  });
});
