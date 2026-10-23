/*
 * The "assigned to me" list is asked for on every visit to the tab and every
 * return to the window. What it costs on the wire: one search a minute for the
 * site, however many ask at once, and Refresh is the only thing that skips it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-mine-"));
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

let fake: FakeJira;
beforeAll(() => { fake = startFakeJira({ pageSize: 50 }); });
beforeEach(async () => {
  fake.reset();
  C.__setCredentialsPath(join(dir, "creds.json"));
  C.__clearAll();
  J.__setJiraBase(fake.base);
  J.__setJiraGuard(null);
  expect((await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).ok).toBe(true);
  fake.requests.length = 0;
});
afterEach(() => { J.__setJiraBase(null); });
afterAll(async () => {
  await fake.stop();
  C.__clearAll();
  C.__setCredentialsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const searches = () => fake.requests.filter((r) => r.path === "/search/jql").length;
const mine = (fresh = false) => J.withStored((c) => J.mine(c, { fresh }));

describe("assigned to me, asked often", () => {
  test("a second ask within the minute is not a request", async () => {
    const a = await mine();
    const b = await mine();
    expect(searches()).toBe(1);
    expect(b).toBe(a);
  });

  test("asks that arrive while one is in the air join it", async () => {
    const all = await Promise.all([mine(), mine(), mine()]);
    expect(searches()).toBe(1);
    expect(all.every((r) => r.ok)).toBe(true);
  });

  test("Refresh asks again, even while one is in the air, and what it learned is what is kept", async () => {
    const slow = mine();
    const forced = await mine(true);
    await slow;
    expect(searches()).toBe(2);
    fake.state.issues["ORBIT-1042"]!.assignee = "acc-0002";
    expect((await mine()).data!.tasks.map((t) => t.customId)).toContain("ORBIT-1000");
    expect(searches()).toBe(2);
    expect(forced.ok).toBe(true);
  });

  test("a failure is not kept: the next ask goes out", async () => {
    fake.fail({ path: "/search/jql", status: 500, times: 1 });
    expect((await mine()).ok).toBe(false);
    expect((await mine()).ok).toBe(true);
    expect(searches()).toBe(2);
  });

  test("a minute later it is asked again", async () => {
    const real = Date.now;
    await mine();
    Date.now = () => real() + 61_000;
    try { await mine(); } finally { Date.now = real; }
    expect(searches()).toBe(2);
  });

  test("a read that was in the air when the connection changed is not kept", async () => {
    const inAir = mine();
    J.__setJiraBase(fake.base);
    await inAir;
    await mine();
    expect(searches()).toBe(2);
  });

  test("a disconnect forgets the list", async () => {
    await mine();
    J.disconnectJira();
    expect((await mine()).error).toBe("Jira is not connected");
    expect(searches()).toBe(1);
  });
});
