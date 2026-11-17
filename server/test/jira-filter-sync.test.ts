/*
 * "Sync from / to Jira filter" against the stand-in site. A read is free; a write replaces the filter's JQL on the site and
 * only goes out behind the write switch. What a mistake costs: a filter overwritten with the switch off, or one written with
 * its name dropped (Jira refuses an update without the name), or an id that is not a number reaching the path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-filter-sync-"));
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
const F = await import("../src/jiraFilterSync.ts");
const settingsFile = join(dir, "jira-settings.json");
J.__setJiraSettingsPath(settingsFile);

let fake: FakeJira;
beforeAll(() => { fake = startFakeJira({ flavor: "cloud" }); });
afterAll(async () => {
  await fake.stop();
  C.__clearAll(); C.__setCredentialsPath(null); J.__setJiraBase(null); J.__setJiraSettingsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  fake.reset();
  rmSync(settingsFile, { force: true });
  C.__setCredentialsPath(join(dir, "creds.json"));
  C.__clearAll();
  J.__setJiraBase(fake.base);
  J.__setJiraGuard(null);
  delete process.env.AGENTGLASS_JIRA_WRITE;
  expect((await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).ok).toBe(true);
  fake.requests.length = 0;
});

const stored = <T,>(f: (c: import("../src/jira.ts").JiraCreds) => Promise<T>) => J.withStored(f as never) as Promise<{ ok: boolean; data?: unknown; error?: string }>;

describe("sync from / to a Jira filter", () => {
  test("a read gives the filter's name and JQL, with one request and no write", async () => {
    const fav = await stored((c) => J.jiraCall<{ id: string }[]>(c, "/rest/api/3/filter/favourite"));
    const first = (fav.data as { id: string; name: string; jql: string }[])[0]!;
    fake.requests.length = 0;
    const r = await stored((c) => F.readFilter(c, first.id));
    expect(r.data).toEqual({ id: first.id, name: first.name, jql: first.jql });
    expect(fake.requests.map((x) => x.method)).toEqual(["GET"]);
  });
  test("an id that is not a number never reaches the site", async () => {
    const r = await stored((c) => F.readFilter(c, "../user"));
    expect(r.ok).toBe(false);
    expect(fake.requests.length).toBe(0);
  });
  test("a write with the switch off sends nothing", async () => {
    const r = await stored((c) => F.writeFilterJql(c, "10020", "project = ORBIT"));
    expect(r.ok).toBe(false);
    expect(r.error).toBe(J.WRITE_OFF);
    expect(fake.requests.length).toBe(0);
  });
  test("with the switch on the JQL is replaced, the name is sent back unchanged, and a read shows the change", async () => {
    J.setJiraWrites(true);
    const before = await stored((c) => F.readFilter(c, "10020"));
    const { name, jql: original } = before.data as { name: string; jql: string };
    fake.requests.length = 0;
    const w = await stored((c) => F.writeFilterJql(c, "10020", "project = ORBIT AND labels = security"));
    expect(w.ok).toBe(true);
    const put = fake.requests.filter((x) => x.method === "PUT");
    expect(put.length).toBe(1);
    expect(put[0]!.body).toEqual({ name, jql: "project = ORBIT AND labels = security" });
    expect(((await stored((c) => F.readFilter(c, "10020"))).data as { jql: string }).jql).toBe("project = ORBIT AND labels = security");
    // The stand-in shares its filters between tests in one process: put the original back.
    expect((await stored((c) => F.writeFilterJql(c, "10020", original))).ok).toBe(true);
    J.setJiraWrites(false);
  });
  test("an empty search is never written", async () => {
    J.setJiraWrites(true);
    const w = await stored((c) => F.writeFilterJql(c, "10020", "   "));
    expect(w.ok).toBe(false);
    expect(fake.requests.some((x) => x.method === "PUT")).toBe(false);
    J.setJiraWrites(false);
  });
});
