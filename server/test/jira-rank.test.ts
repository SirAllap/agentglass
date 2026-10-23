/*
 * Ranking a card on its board: the body is built from card keys only, the write
 * is behind the Jira write switch, one drop is one request, and the held board
 * reads are dropped so the next read says the order Jira now holds.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-rank-"));
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
const R = await import("../src/jiraRank.ts");
const D = await import("../src/jiraDoor.ts");

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

describe("the body of a rank (pure)", () => {
  test("one card, one neighbour, and which side", () => {
    expect(R.rankBody("orbit-1043", { before: "ORBIT-1042" })).toEqual({ ok: true, body: { issues: ["ORBIT-1043"], rankBeforeIssue: "ORBIT-1042" } });
    expect(R.rankBody("ORBIT-1043", { after: "orbit-1046" })).toEqual({ ok: true, body: { issues: ["ORBIT-1043"], rankAfterIssue: "ORBIT-1046" } });
  });
  test("each guard refuses with a sentence and no body", () => {
    const no = (key: string, ask: Record<string, unknown>) => { const r = R.rankBody(key, ask); expect(r.ok).toBe(false); return (r as { error: string }).error; };
    expect(no("not a key", { before: "ORBIT-1042" })).toContain("not a Jira card id");
    expect(no("ORBIT-1043", { before: "../x" })).toContain("not a Jira card id");
    expect(no("ORBIT-1043", { before: "ORBIT-1043" })).toContain("itself");
    expect(no("ORBIT-1043", { before: "orbit-1043" })).toContain("itself");
    expect(no("ORBIT-1043", {})).toContain("before one card or after");
    expect(no("ORBIT-1043", { before: "ORBIT-1042", after: "ORBIT-1046" })).toContain("before one card or after");
    expect(no("ORBIT-1043", { before: "" })).toContain("before one card or after");
    // A number or an object is not a key, and never reaches the body as one.
    expect(no("ORBIT-1043", { before: 42 })).toContain("not a Jira card id");
    expect(no("ORBIT-1043", { before: { key: "ORBIT-1042" } })).toContain("not a Jira card id");
  });
});

for (const flavor of ["cloud", "datacenter"] as const) {
  describe(`rank, ${flavor}`, () => {
    const dc = flavor === "datacenter";
    const site = ({ cloud: "acme.atlassian.net", datacenter: "jira.acme.example" } as Record<FakeFlavor, string>)[flavor];
    let fake: FakeJira;
    const puts = () => fake.requests.filter((r) => r.method === "PUT");
    const order = async () => (await B.viewRead("board:3", { force: true })).tasks.map((t) => t.customId);
    const withCreds = <T>(run: (c: import("../src/jira.ts").JiraCreds) => Promise<T>): Promise<T> =>
      J.withStored(async (c) => ({ ok: true, data: await run(c) })).then((r) => r.data as T);

    beforeAll(() => { fake = startFakeJira({ flavor, pageSize: 50 }); });
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(credFile);
      V.__setJiraViewsPath(viewsFile);
      V.__clear();
      J.__setJiraGuard(null);
      C.__clearAll();
      J.__setJiraBase(fake.base);
      expect((await J.connectJira(dc ? { site, token: FAKE_PAT } : { site, email: FAKE_EMAIL, token: FAKE_TOKEN })).ok).toBe(true);
      expect((await B.addViewByChoice("board", "3")).data).toMatchObject({ ok: true });
      process.env.AGENTGLASS_JIRA_WRITE = "1";
      fake.requests.length = 0;
    });
    afterEach(() => { delete process.env.AGENTGLASS_JIRA_WRITE; J.__setJiraBase(null); });
    afterAll(async () => { await fake.stop(); });

    test("a drop is one request, the one write, and the next read shows the new order", async () => {
      const before = await order();
      const [a, b, c] = before as string[];
      // The first card goes behind the third.
      fake.requests.length = 0;
      const r = await withCreds((creds) => R.rankCard(creds, a!, { after: c }));
      expect(r).toEqual({ ok: true });
      expect(fake.requests.length).toBe(1);
      expect(puts().length).toBe(1);
      expect(puts()[0]!.path).toBe("/rest/agile/1.0/issue/rank");
      expect(puts()[0]!.body).toEqual({ issues: [a], rankAfterIssue: c });
      // Not the minute held before the write: the read is Jira's order now.
      const held = await B.viewRead("board:3");
      expect(held.tasks.map((t) => t.customId)).toEqual([b, c, a, ...(before as string[]).slice(3)]);
    });

    test("with the write switch off nothing is sent", async () => {
      delete process.env.AGENTGLASS_JIRA_WRITE;
      const r = await withCreds((creds) => R.rankCard(creds, "ORBIT-1043", { before: "ORBIT-1042" }));
      expect(r).toMatchObject({ ok: false, error: J.WRITE_OFF });
      expect(fake.requests.length).toBe(0);
    });

    test("a refused body is refused before any request", async () => {
      const r = await withCreds((creds) => R.rankCard(creds, "ORBIT-1043", { before: "ORBIT-1043" }));
      expect(r.ok).toBe(false);
      expect(fake.requests.length).toBe(0);
    });

    test("Jira's refusals are our sentences, never its text", async () => {
      fake.state.denyRank.push("ORBIT-1043");
      const denied = await withCreds((creds) => R.rankCard(creds, "ORBIT-1043", { before: "ORBIT-1042" }));
      expect(denied).toMatchObject({ ok: false, error: "Your Jira account cannot rank that card" });
      const gone = await withCreds((creds) => R.rankCard(creds, "ORBIT-1042", { before: "ORBIT-9999" }));
      expect(gone.ok).toBe(false);
      expect(gone.error).not.toContain("Cannot rank those issues");
    });

    test("a refused rank leaves the held read alone", async () => {
      const first = await B.viewRead("board:3");
      fake.requests.length = 0;
      fake.state.denyRank.push("ORBIT-1043");
      await withCreds((creds) => R.rankCard(creds, "ORBIT-1043", { before: "ORBIT-1042" }));
      const again = await B.viewRead("board:3");
      expect(again.at).toBe(first.at);
    });

    test("the door verb is acting, goes through the same function, and answers with its own state", async () => {
      expect(D.isActing("rank")).toBe(true);
      expect(D.DOOR_VERBS).toContain("rank");
      const ok = await D.runDoor("rank", { key: "ORBIT-1043", before: "ORBIT-1042" });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ ok: true, state: { ranked: true } });
      expect(puts().length).toBe(1);
      const bad = await D.runDoor("rank", { key: "ORBIT-1043" });
      expect(bad.status).toBe(400);
      expect(puts().length).toBe(1);
    });
  });
}
