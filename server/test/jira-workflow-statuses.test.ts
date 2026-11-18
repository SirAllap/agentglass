/* One source for "the statuses of this project's workflow": the board's columns, and the PR board's "Card status is" list. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-wf-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");
const V = await import("../src/jiraviews.ts");
const B = await import("../src/jiraboards.ts");

let fake: FakeJira;
beforeAll(() => { fake = startFakeJira({ flavor: "cloud" }); });
afterAll(async () => {
  C.__clearAll(); C.__setCredentialsPath(null); V.__setJiraViewsPath(null); J.__setJiraBase(null); J.__setJiraSettingsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  fake.reset();
  fake.state.sprints[3] = [];
  C.__clearAll();
  C.__setCredentialsPath(join(dir, "creds.json"));
  V.__setJiraViewsPath(join(dir, "config", "agentglass", "jira-views.json"));
  V.__clear();
  // Spaces and the column board a space picks are written to the settings file: a path of its own, or they land in whichever file ran first.
  J.__setJiraSettingsPath(join(dir, "jira-settings.json"));
  J.__setJiraBase(fake.base);
  const r = await J.connectJira({ site: "acme.atlassian.net", email: FAKE_EMAIL, token: FAKE_TOKEN });
  expect(r.ok).toBe(true);
});

const WORKFLOW = ["To Do", "In Progress", "In Review", "QA", "Done", "In staging", "Ready for deployment"];

describe("the statuses of a board", () => {
  test("every status of the workflow is a column, in workflow order, whatever the board's own columns hold", async () => {
    // A board that maps only two statuses, under a column named for no status at all.
    fake.state.boards.find((b) => b.id === 2)!.columns = [{ name: "Work in progress", statusIds: ["1"] }, { name: "Finished", statusIds: ["5"] }];
    const a = await B.addViewByChoice("board", "2");
    expect(a.data).toMatchObject({ ok: true });
    const r = await B.viewRead("board:2");
    expect((r.statuses ?? []).map((s) => s.status)).toEqual(WORKFLOW);
    expect((r.statuses ?? []).map((s) => s.status.toLowerCase())).not.toContain("work in progress");
  });
});

describe("the statuses a PR rule offers", () => {
  test("they are the workflow statuses of the saved Jira projects, upper case, once each", async () => {
    expect((await B.addFolderByKey("ORBIT")).ok).toBe(true);
    const got = await B.workflowStatusRows();
    expect(got.map((s) => s.status)).toEqual(WORKFLOW.map((s) => s.toUpperCase()));
  });
});

describe("the order of the statuses a PR rule offers", () => {
  test("it is the picked board's column order, not the workflow's; a status no column holds sits beside its category", async () => {
    // The board shows QA before In Review, and holds no To Do column.
    fake.state.boards.find((b) => b.id === 1)!.columns = [{ name: "Doing", statusIds: ["2"] }, { name: "Check", statusIds: ["4"] }, { name: "Review", statusIds: ["3"] }, { name: "Finished", statusIds: ["5"] }];
    expect((await B.addFolderByKey("ORBIT")).ok).toBe(true);
    const S = await import("../src/jiraSpaces.ts");
    expect(await S.spacesEdit({ add: "ORBIT" })).toMatchObject({ ok: true });
    expect(S.setSpaceColumnBoard("ORBIT", "1")).toMatchObject({ ok: true });
    const got = (await B.workflowStatusRows()).map((s) => s.status);
    const at = (n: string) => got.indexOf(n);
    expect(at("QA")).toBeLessThan(at("IN REVIEW"));
    expect(at("IN PROGRESS")).toBeLessThan(at("QA"));
    expect(got.filter((n) => ["IN PROGRESS", "QA", "IN REVIEW", "DONE"].includes(n))).toEqual(["IN PROGRESS", "QA", "IN REVIEW", "DONE"]);
    expect([...got].sort()).toEqual(WORKFLOW.map((s) => s.toUpperCase()).sort());
  });
});

describe("the order of the columns", () => {
  const names = (r: { statuses?: { status: string }[] }) => (r.statuses ?? []).map((s) => s.status);
  test("the same on every load, whatever cards the board holds; only workflow statuses are columns, never a column or category name", async () => {
    fake.state.boards.find((b) => b.id === 2)!.columns = [{ name: "Work in progress", statusIds: ["2", "3", "4"] }, { name: "Finished", statusIds: ["5"] }];
    expect((await B.addViewByChoice("board", "2")).data).toMatchObject({ ok: true });
    const first = await B.viewRead("board:2");
    // A different card set: every card of the board moves to one status.
    for (const i of Object.values(fake.state.issues)) i.statusId = "4";
    const second = await B.viewRead("board:2", { force: true });
    expect(names(second)).toEqual(names(first));
    expect(names(first)).toEqual(WORKFLOW);
    const bad = [...names(first), ...names(second)].map((n) => n.toLowerCase()).filter((n) => n === "work in progress" || n === "finished");
    expect(bad).toEqual([]);
  });
});

describe("a failed read", () => {
  test("workflowStatusRead reports a project it could not read, and the good one still answers", async () => {
    expect((await B.addFolderByKey("ORBIT")).ok).toBe(true);
    const good = await B.workflowStatusRead();
    expect(good.failed).toBe(false);
    expect(good.rows.length).toBeGreaterThan(0);
    // A second saved project the site does not know: its read fails, the other rows are kept.
    const bad = await B.addFolderByKey("GONE");
    if (bad.ok) {
      const r = await B.workflowStatusRead();
      expect(r.failed).toBe(true);
      expect(r.rows.length).toBe(good.rows.length);
    }
  });
});
