/*
 * The flow's Session start step: a worker's first turn moves its Jira card to
 * the status the project picked, through the move door — once, and only when
 * a project turned it on. Against the stand-in Jira, Cloud only: the move
 * itself is already proven against both flavours in jira-move.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-session-start-move-"));
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
const { putSetting } = await import("../src/preflightStore.ts");
const { drainReports } = await import("../src/seatreport.ts");
const { moveCardOnSessionStart } = await import("../src/agents/sessionStartMove.ts");

const credFile = join(dir, "creds.json");
J.__setJiraSettingsPath(join(dir, "jira-settings.json"));

afterAll(() => {
  C.__clearAll();
  C.__setCredentialsPath(null);
  J.__setJiraBase(null);
  J.__setJiraSettingsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const ROOT = "/code/orbit";
const REF = { tracker: "jira" as const, id: "orbit-1042" };

describe("the Session start move step", () => {
  let fake: FakeJira;
  beforeAll(() => { fake = startFakeJira({ flavor: "cloud" }); });
  afterAll(async () => { await fake.stop(); });
  beforeEach(async () => {
    fake.reset();
    C.__setCredentialsPath(credFile);
    C.__clearAll();
    J.__setJiraBase(fake.base);
    J.__setJiraGuard(null);
    process.env.AGENTGLASS_JIRA_WRITE = "1";
    const r = await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
    expect(r.ok).toBe(true);
    fake.requests.length = 0;
    putSetting(ROOT, "flow.sessionStart.move", false);
    putSetting(ROOT, "flow.sessionStart.moveStatus", "");
  });
  afterEach(() => {
    delete process.env.AGENTGLASS_JIRA_WRITE;
    J.__setJiraBase(null);
  });

  const wire = () => fake.requests.map((r) => `${r.method} ${r.path}`);

  test("off: nothing is read or written", async () => {
    await moveCardOnSessionStart(ROOT, "builder-1", REF);
    expect(fake.requests.length).toBe(0);
    expect(drainReports(ROOT)).toEqual([]);
  });

  test("no status configured: on, but nothing to move to", async () => {
    putSetting(ROOT, "flow.sessionStart.move", true);
    await moveCardOnSessionStart(ROOT, "builder-1", REF);
    expect(fake.requests.length).toBe(0);
  });

  test("not a Jira card: a ClickUp ref is left alone", async () => {
    putSetting(ROOT, "flow.sessionStart.move", true);
    putSetting(ROOT, "flow.sessionStart.moveStatus", "In Review");
    await moveCardOnSessionStart(ROOT, "builder-1", { tracker: "clickup", id: "9zzz0abc1" });
    expect(fake.requests.length).toBe(0);
  });

  test("on, with a status: moves once through the move door", async () => {
    putSetting(ROOT, "flow.sessionStart.move", true);
    putSetting(ROOT, "flow.sessionStart.moveStatus", "In Review");
    await moveCardOnSessionStart(ROOT, "builder-1", REF);
    const posts = fake.requests.filter((r) => r.method !== "GET");
    expect(posts.length).toBe(1);
    expect(posts[0]!.path).toBe("/issue/ORBIT-1042/transitions");
    const after = await J.withStored((c) => J.readIssue(c, "ORBIT-1042"));
    expect(after.ok).toBe(true);
    expect(after.data!.status).toBe("In Review");
  });

  test("already in the target status: nothing is moved, and the move door is never asked", async () => {
    putSetting(ROOT, "flow.sessionStart.move", true);
    putSetting(ROOT, "flow.sessionStart.moveStatus", "In Progress");
    await moveCardOnSessionStart(ROOT, "builder-1", REF);
    expect(wire()).toEqual(["GET /issue/ORBIT-1042"]);
  });

  test("jira.writes.move off: the refusal names that switch, and nothing moves", async () => {
    putSetting(ROOT, "flow.sessionStart.move", true);
    putSetting(ROOT, "flow.sessionStart.moveStatus", "In Review");
    J.setJiraWriteKind("move", false);
    await moveCardOnSessionStart(ROOT, "builder-1", REF);
    expect(fake.requests.length).toBe(0);
    const reports = drainReports(ROOT);
    expect(reports.length).toBe(1);
    expect(reports[0]!.state).toContain("Moving cards is switched off in Settings");
    J.setJiraWriteKind("move", true);
  });
});

describe("the session-start move is kept per project", () => {
  // Without a PER_PROJECT entry and a doorRoot case, the settings door refused
  // the switch for every project ("name the project root"), and a value that
  // did land went to the app-wide row, so one project's switch moved them all.
  test("one project's switch and status never reach another project", async () => {
    const { PER_PROJECT } = await import("../src/preflightStore.ts");
    const { sessionStartMoveSetting } = await import("../src/agents/sessionStartMove.ts");
    expect(PER_PROJECT).toContain("flow.sessionStart.move");
    expect(PER_PROJECT).toContain("flow.sessionStart.moveStatus");
    putSetting("/home/a/orbit-move-on", "flow.sessionStart.move", true);
    putSetting("/home/a/orbit-move-on", "flow.sessionStart.moveStatus", "In development");
    expect(sessionStartMoveSetting("/home/a/orbit-move-on")).toEqual({ on: true, status: "In development" });
    expect(sessionStartMoveSetting("/home/a/acme-move-off")).toEqual({ on: false, status: "" });
  });
  test("the settings door keeps the root a person or a seat names for these ids", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(src).toContain(`id.startsWith("workers.") || id.startsWith("flow.sessionStart.")`);
  });
});
