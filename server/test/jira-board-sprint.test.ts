/*
 * A board in an active sprint reads the sprint's own cards, not the first page of the project's ranking.
 * The fixture is the shape that failed on a real site: a long done history ranked ahead of the sprint, so the
 * single capped search answered only history. The decision (which two queries) is a pure function; the rest is
 * counted at the stand-in.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-board-context-"));
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

describe("the two reads of a board in a sprint (pure)", () => {
  const where = ["(project = ORBIT)", "status in (1, 2, 5)"];
  test("the sprint is asked by its id, the rest is the open cards that are not in it", () => {
    const q = B.sprintQueries(where, "ORDER BY Rank ASC", "41");
    expect(q.sprint).toBe("(project = ORBIT) AND status in (1, 2, 5) AND sprint = 41 ORDER BY Rank ASC");
    expect(q.rest).toBe("(project = ORBIT) AND status in (1, 2, 5) AND (sprint is EMPTY OR sprint != 41) AND statusCategory != Done ORDER BY Rank ASC");
  });
  test("the rest keeps the cards that have no sprint at all, and leaves the done history out", () => {
    const { rest } = B.sprintQueries(where, "", "41");
    // `NOT sprint = 41` alone answered no card at all on the site measured: a card with no sprint is not "not in 41" to it.
    expect(rest).toContain("sprint is EMPTY OR");
    expect(rest).not.toMatch(/NOT sprint/i);
    expect(rest).toContain("statusCategory != Done");
  });
  test("no order is none appended", () => {
    expect(B.sprintQueries(where, "", "41").sprint.endsWith("sprint = 41")).toBe(true);
  });
});

for (const flavor of ["cloud", "datacenter"] as const) {
  describe(`a board in a sprint, ${flavor}`, () => {
    const dc = flavor === "datacenter";
    const site = dc ? "jira.acme.example" : "acme.atlassian.net";
    const searchPath = dc ? "/search" : "/search/jql";
    let fake: FakeJira;
    const searches = () => fake.requests.filter((r) => r.path === searchPath);
    const jqlOf = (r: { body?: unknown }) => (r.body as { jql: string }).jql;
    const active = { id: 41, name: "Sprint 4", state: "active" as const };

    beforeAll(() => { fake = startFakeJira({ flavor, pageSize: 50 }); });
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(credFile);
      V.__setJiraViewsPath(viewsFile);
      V.__clear();
      J.__setJiraGuard(null);
      C.__clearAll();
      J.__setJiraBase(fake.base);
      const r = await J.connectJira(dc ? { site, token: FAKE_PAT } : { site, email: FAKE_EMAIL, token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      const a = await B.addViewByChoice("board", "3");
      expect(a.data).toMatchObject({ ok: true });
      fake.requests.length = 0;
    });
    afterEach(() => { J.__setJiraBase(null); });
    afterAll(async () => { await fake.stop(); });

    /** The shape of a project with a long history: its done cards are ranked first, the sprint comes after. */
    const seedHistory = () => {
      // The stock cards carry a sprint of the same name under another id; the board's own is 41.
      for (const i of Object.values(fake.state.issues)) i.sprints = i.sprints.map((x) => (x.name === active.name ? active : x));
      const base = fake.state.issues["ORBIT-1001"]!;
      for (let n = 0; n < 160; n++) {
        const key = `ORBIT-${5000 + n}`;
        fake.state.issues[key] = { ...structuredClone(base), id: String(80000 + n), key, summary: `Old ${n}`, statusId: "5", sprints: [], rank: `0|a${String(n).padStart(5, "0")}:` };
      }
      for (let n = 0; n < 4; n++) {
        const key = `ORBIT-${6000 + n}`;
        fake.state.issues[key] = { ...structuredClone(base), id: String(90000 + n), key, summary: `Sprint card ${n}`, statusId: ["1", "2", "5", "1"][n]!, sprints: [active], rank: `0|z${String(n).padStart(5, "0")}:` };
      }
    };

    test("the sprint's cards come first, done ones too, though the history is ranked ahead of them", async () => {
      seedHistory();
      const r = await B.viewRead("board:3");
      expect(r.ok).toBe(true);
      const keys = r.tasks.map((t) => t.customId);
      const inSprint = r.tasks.filter((t) => t.sprint === "Sprint 4");
      expect(keys).toEqual(expect.arrayContaining(["ORBIT-6000", "ORBIT-6001", "ORBIT-6002", "ORBIT-6003"]));
      // Every card of the sprint comes before every card outside it.
      expect(r.tasks.slice(0, inSprint.length).every((t) => t.sprint === "Sprint 4")).toBe(true);
      // None of the 160 old done cards is read: the history is not the board.
      expect(keys.some((k) => /^ORBIT-5\d{3}$/.test(k ?? ""))).toBe(false);
      // Done cards of the sprint are there.
      expect(inSprint.some((t) => t.statusKind === "done")).toBe(true);
    });

    test("the rest are open cards outside the sprint, and none is counted twice", async () => {
      seedHistory();
      const r = await B.viewRead("board:3");
      const outside = r.tasks.filter((t) => t.sprint !== "Sprint 4");
      expect(outside.length).toBeGreaterThan(0);
      expect(outside.every((t) => t.statusKind !== "done")).toBe(true);
      const keys = r.tasks.map((t) => t.id);
      expect(new Set(keys).size).toBe(keys.length);
    });

    test("costs the sprint's pages and one page of the rest, and nothing when read again", async () => {
      seedHistory();
      await B.viewRead("board:3");
      const sent = searches().map(jqlOf);
      expect(sent.length).toBe(2);
      expect(sent[0]).toContain("sprint = 41");
      expect(sent[1]).toContain("sprint is EMPTY OR sprint != 41");
      expect(fake.requests.filter((q) => /\/board\/3\/sprint/.test(q.path)).length).toBe(1);
      fake.requests.length = 0;
      await B.viewRead("board:3");
      expect(fake.requests.length).toBe(0);
    });

    test("the rest is one page, and says when there is more", async () => {
      seedHistory();
      const base = fake.state.issues["ORBIT-1001"]!;
      for (let n = 0; n < 70; n++) {
        const key = `ORBIT-${7000 + n}`;
        fake.state.issues[key] = { ...structuredClone(base), id: String(95000 + n), key, summary: `Idea ${n}`, statusId: "1", sprints: [], rank: `0|y${String(n).padStart(5, "0")}:` };
      }
      const r = await B.viewRead("board:3");
      expect(searches().filter((q) => jqlOf(q).includes("sprint is EMPTY")).length).toBe(1);
      expect(r.truncated).toBe(true);
    });

    test("a board with no active sprint is the one search it was", async () => {
      fake.state.sprints[3] = [];
      seedHistory();
      await B.viewRead("board:3");
      expect(searches().length).toBeGreaterThanOrEqual(1);
      expect(searches().every((q) => !jqlOf(q).includes("sprint"))).toBe(true);
    });
  });
}
