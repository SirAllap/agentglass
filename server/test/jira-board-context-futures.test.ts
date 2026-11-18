/*
 * A board's future sprints are paged through: the site answers at most a page of them, and the card menu's Sprint
 * row offers every one. The stand-in pages its sprints two at a time here, so three sprints take two reads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-board-futures-"));
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
const X = await import("../src/jiraBoardContext.ts");

let fake: FakeJira;
const withCreds = <T>(run: (c: import("../src/jira.ts").JiraCreds) => Promise<T>): Promise<T> =>
  J.withStored(async (c) => ({ ok: true, data: await run(c) })).then((r) => r.data as T);
const sprintReads = () => fake.requests.filter((r) => /\/board\/3\/sprint$/.test(r.path) && r.query.state === "future").length;

beforeAll(() => { fake = startFakeJira({ flavor: "cloud", sprintPageSize: 2 }); });
beforeEach(async () => {
  fake.reset();
  C.__clearAll();
  C.__setCredentialsPath(join(dir, "creds.json"));
  J.__setJiraBase(fake.base);
  expect((await J.connectJira({ site: "acme.atlassian.net", email: FAKE_EMAIL, token: FAKE_TOKEN })).ok).toBe(true);
  fake.state.sprints[3] = [
    { id: 41, name: "S2", state: "active" },
    { id: 51, name: "S3", state: "future", startDate: "2026-11-18T09:00:00.000Z", endDate: "2026-12-02T09:00:00.000Z" },
    { id: 52, name: "S4", state: "future" },
    { id: 53, name: "S5", state: "future" },
  ];
  fake.requests.length = 0;
});
afterAll(async () => {
  await fake.stop();
  C.__clearAll();
  C.__setCredentialsPath(null);
  J.__setJiraBase(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe("future sprints, paged", () => {
  test("three future sprints over two pages: all three, in order; the next is the first dated; kept ten minutes", async () => {
    const r = await withCreds((c) => X.futureSprints(c, "3"));
    expect(r.ok).toBe(true);
    expect(r.data!.map((x) => [x.id, x.name])).toEqual([["51", "S3"], ["52", "S4"], ["53", "S5"]]);
    expect(sprintReads()).toBe(2);
    const n = await withCreds((c) => X.nextSprint(c, "3"));
    expect(n.data).toMatchObject({ id: "51", name: "S3" });
    expect(sprintReads()).toBe(2);
  });
});
