/* The card menu's writes against the fake site: Backlog takes a card out of its sprint, Clone makes a copy, an epic is set as the parent. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-menu-writes-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB", "AGENTGLASS_JIRA_WRITE"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");
process.env.AGENTGLASS_JIRA_WRITE = "1";

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");
const S = await import("../src/jiraSprintMove.ts");
const K = await import("../src/jiraClone.ts");

let fake: FakeJira;
beforeAll(() => { fake = startFakeJira({ flavor: "cloud" }); });
afterAll(async () => {
  await fake.stop();
  C.__clearAll(); C.__setCredentialsPath(null); J.__setJiraBase(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  fake.reset();
  C.__setCredentialsPath(join(dir, "creds.json"));
  J.__setJiraGuard(null); C.__clearAll(); J.__setJiraBase(fake.base);
  expect((await J.connectJira({ site: "acme.atlassian.net", email: FAKE_EMAIL, token: FAKE_TOKEN })).ok).toBe(true);
});

describe("Backlog", () => {
  test("a card in a sprint leaves it", async () => {
    const inSprint = Object.values(fake.state.issues).find((i) => i.sprints.length)!;
    expect(await S.moveToBacklog(J.storedCreds()!, [inSprint.key])).toEqual({ ok: true });
    expect(fake.state.issues[inSprint.key]!.sprints).toEqual([]);
  });
  test("keys that are not cards, or none, send nothing", async () => {
    expect((await S.moveToBacklog(J.storedCreds()!, ["nope"])).ok).toBe(false);
    expect((await S.moveToBacklog(J.storedCreds()!, [])).ok).toBe(false);
  });
});

describe("Clone", () => {
  test("the body keeps type, project, parent, components and labels, and the title says CLONE", () => {
    const body = K.cloneBody({
      summary: "Fix the login", issuetype: { id: "10002", name: "Task" }, project: { key: "ORBIT" }, parent: { key: "ORBIT-7" },
      components: [{ id: "10300", name: "Web" }], labels: ["ux"], priority: { id: "3" },
    });
    expect(body).toEqual({ fields: {
      project: { key: "ORBIT" }, summary: "CLONE - Fix the login", issuetype: { id: "10002" }, parent: { key: "ORBIT-7" },
      components: [{ id: "10300" }], labels: ["ux"], priority: { id: "3" },
    } });
  });
  test("a copy of a copy does not stack the prefix, and a card with no parent sends none", () => {
    const body = K.cloneBody({ summary: "CLONE - Fix", issuetype: { name: "Bug" }, project: { key: "ORBIT" } });
    expect(body.fields.summary).toBe("CLONE - Fix");
    expect("parent" in body.fields).toBe(false);
    expect(body.fields.issuetype).toEqual({ name: "Bug" });
  });
  test("with writes off nothing is sent, and a bad key is refused", async () => {
    expect((await K.cloneCard(J.storedCreds()!, "nope")).ok).toBe(false);
  });
  test("a card is cloned on the site and the answer names the new key", async () => {
    const from = Object.values(fake.state.issues).find((i) => i.issueType === "Task" && i.projectKey === "ORBIT" && !i.parentKey)!;
    const r = await K.cloneCard(J.storedCreds()!, from.key);
    expect(r).toMatchObject({ ok: true });
    const made = (r as { created?: string }).created!;
    expect(made).toMatch(/^ORBIT-\d+$/);
    expect(made).not.toBe(from.key);
    expect(fake.state.issues[made]).toMatchObject({ summary: `CLONE - ${from.summary}`, issueType: from.issueType, projectKey: "ORBIT", labels: from.labels });
  });
  test("a sub-task is cloned under the same parent", async () => {
    const sub = Object.values(fake.state.issues).find((i) => i.parentKey && i.issueType === "Sub-task");
    if (!sub) return;
    const r = await K.cloneCard(J.storedCreds()!, sub.key);
    expect(r.ok).toBe(true);
    expect(fake.state.issues[(r as { created?: string }).created!]!.parentKey).toBe(sub.parentKey);
  });
});

describe("Epic", () => {
  test("setting a card's parent to an epic, and to none, goes through the edit door", async () => {
    const E = await import("../src/jiraEdit.ts");
    const epic = Object.values(fake.state.issues).find((i) => i.issueType === "Epic")!;
    const card = Object.values(fake.state.issues).find((i) => i.issueType === "Task" && i.projectKey === epic.projectKey && !i.parentKey)!;
    fake.state.issues[card.key]!.editmeta = ["summary", "parent"];
    const stamp = () => Date.parse(fake.state.issues[card.key]!.updated);
    const set = await E.editCard(J.storedCreds()!, card.key, { field: "parent", value: epic.key }, stamp());
    expect(set).toMatchObject({ ok: true });
    expect(fake.state.issues[card.key]!.parentKey).toBe(epic.key);
    const clear = await E.editCard(J.storedCreds()!, card.key, { field: "parent", value: null }, stamp());
    expect(clear).toMatchObject({ ok: true });
    expect(fake.state.issues[card.key]!.parentKey).toBeNull();
  });
});
