/*
 * What sits around a board's cards: the kind and the flag on each row, the
 * parent a row sits under, the board's quick filters and sprint and epics, and
 * what a toggled filter costs. The budget is part of the behaviour, so the
 * requests are counted at the stand-in: the extra fields ride in the one
 * search (no request per card), the three context reads are asked once per
 * board per ten minutes, and a toggle is the one search it narrows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-board-areas-"));
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
const X = await import("../src/jiraBoardContext.ts");
const D = await import("../src/jiraDoor.ts");
const F = await import("../src/jirafields.ts");

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

const SITES: Record<FakeFlavor, string> = { cloud: "acme.atlassian.net", datacenter: "jira.acme.example" };

/*
 * The Areas tree counts from ONE kept read of the cards under the board's epics: not a search per area, and not again
 * for ten minutes. Sub-tasks are left out (their parent is a story, not an area).
 */
for (const flavor of ["cloud", "datacenter"] as const) {
  describe(`board areas, ${flavor}`, () => {
    const site = SITES[flavor];
    const dc = flavor === "datacenter";
    const searchPath = dc ? "/search" : "/search/jql";
    let fake: FakeJira;
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
      const a = await B.addViewByChoice("board", "3");
      expect(a.data).toMatchObject({ ok: true });
      fake.requests.length = 0;
    });
    afterEach(() => { J.__setJiraBase(null); });
    afterAll(async () => { await fake.stop(); });

    test("every card under an epic, in one kept read; the second ask costs nothing", async () => {
      const r = await withCreds((c) => B.readBoardAreas(c, "3"));
      expect(r.ok).toBe(true);
      expect(r.data!.tasks.length).toBeGreaterThan(0);
      expect(r.data!.tasks.every((t) => !!t.parent)).toBe(true);
      expect(r.data!.tasks.some((t) => t.parent!.key === "ORBIT-1000")).toBe(true);
      const sent = fake.requests.filter((q) => q.path === searchPath);
      expect(sent.length).toBe(1);
      const jql = (sent[0]!.body as { jql: string }).jql;
      expect(jql).toContain("parent is not EMPTY");
      expect(jql).toContain("subTaskIssueTypes()");
      fake.requests.length = 0;
      await withCreds((c) => B.readBoardAreas(c, "3"));
      await withCreds((c) => B.readBoardAreas(c, "board:3".replace("board:", "")));
      expect(fake.requests.length).toBe(0);
    });

    test("where epics are named as areas, only their cards and the open epics beside them are asked for", async () => {
      const seed = fake.state.issues["ORBIT-1000"]!;
      fake.state.issues["ORBIT-1900"] = { ...structuredClone(seed), id: "91900", key: "ORBIT-1900", summary: "Area: Game" };
      const r = await withCreds((c) => B.readBoardAreas(c, "3"));
      expect(r.ok).toBe(true);
      const jql = (fake.requests.filter((q) => q.path === searchPath).at(-1)!.body as { jql: string }).jql;
      expect(jql).toMatch(/parent in \(ORBIT-1900(, [A-Z]+-\d+)*\)/);
      expect(jql).not.toContain("parent is not EMPTY");
    });

    test("a sub-task is not an area's card", async () => {
      const subs = Object.values(fake.state.issues).filter((i) => i.issueType === "Sub-task").map((i) => i.key);
      const r = await withCreds((c) => B.readBoardAreas(c, "3"));
      for (const k of subs) expect(r.data!.tasks.map((t) => t.customId)).not.toContain(k);
    });

    test("the agent door reads the same areas, the team's words under untrusted, and refuses a board that is not a number", async () => {
      const seed = fake.state.issues["ORBIT-1000"]!;
      fake.state.issues["ORBIT-1900"] = { ...structuredClone(seed), id: "91900", key: "ORBIT-1900", summary: "Area: Game" };
      fake.state.issues["ORBIT-1901"] = { ...structuredClone(fake.state.issues["ORBIT-1042"]!), id: "91901", key: "ORBIT-1901", parentKey: "ORBIT-1900" };
      const a = await D.runDoor("areas", { board: "board:3" });
      expect(a.body).toMatchObject({ ok: true, untrusted: { areas: expect.arrayContaining([expect.objectContaining({ key: "ORBIT-1900", name: "Game", total: 1, group: "area" })]) } });
      expect(D.isActing("areas")).toBe(false);
      expect((await D.runDoor("areas", { board: "x" })).body).toMatchObject({ ok: false });
    });

    test("a board that is not a number is refused without a request", async () => {
      const r = await withCreds((c) => B.readBoardAreas(c, "x"));
      expect(r.ok).toBe(false);
      expect(fake.requests.length).toBe(0);
    });
  });
}
