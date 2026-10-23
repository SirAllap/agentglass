/*
 * A Jira card read in Jira's own shape: the Details, the files by name, the
 * subtasks and every linked work item, from the one issue request.
 *
 * What a mistake costs: a pane that draws "Components: None" on a project
 * without components, a link "blocks" that is really "is blocked by", an
 * attachment whose redirect address reaches the web, or a card open that
 * quietly grew a request.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-cardread-"));
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
const K = await import("../src/jiraComments.ts");
const R = await import("../src/jiraCardRead.ts");

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

for (const flavor of ["cloud", "datacenter"] as FakeFlavor[]) {
  const dc = flavor === "datacenter";
  describe(`a card in Jira's shape, ${dc ? "Data Center" : "Cloud"}`, () => {
    let fake: FakeJira;
    beforeAll(() => { fake = startFakeJira({ flavor }); });
    afterAll(async () => { await fake.stop(); });
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(credFile);
      C.__clearAll();
      J.__setJiraBase(fake.base);
      J.__setJiraGuard(null);
      const r = dc
        ? await J.connectJira({ site: "jira.acme.example", token: FAKE_PAT })
        : await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      await K.detailStored("ORBIT-1001"); // learns the site's field ids once, so what follows is the card's own cost
      fake.requests.length = 0;
    });
    afterEach(() => { J.__setJiraBase(null); });
    const detail = async (key: string) => (await K.detailStored(key)).data!.detail;
    const facts = async (key: string) => Object.fromEntries((await detail(key)).facts!.map((f) => [f.id, f]));

    test("opening a card is one request (two on Cloud for a card with comments, to know who answers whom), with the named field list and the edit screen's field list", async () => {
      await K.detailStored("ORBIT-1042");
      expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /issue/ORBIT-1042", ...(dc ? [] : ["GET /issue/ORBIT-1042/comment"])]);
      const q = fake.requests[0]!.query;
      expect(q.expand).toBe("editmeta");
      const asked = q.fields!.split(",");
      for (const f of ["summary", "description", "comment", "subtasks", "issuelinks", "attachment", "reporter", "issuetype", "components", "fixVersions", "versions", "timetracking", "parent"]) expect(asked).toContain(f);
      // The change history is never part of opening a card.
      expect(asked).not.toContain("changelog");
      expect(q.expand).not.toContain("changelog");
    });

    test("a Detail the card's edit screen does not offer and the card does not hold is not in the answer", async () => {
      const f = await facts("ORBIT-1042");
      // Fix versions and time are offered here and filled; components are filled though not offered; Affects versions are neither.
      expect(f.components!.value).toBe("Sync");
      expect(f.fixVersions!.value).toBe("2.4");
      // Where the screen offers time, the estimates are two rows that can be changed and the line keeps what is spent.
      expect(f.time!.value).toBe("4h spent");
      expect(f.originalEstimate).toMatchObject({ value: "2d", field: "originalEstimate", raw: "2d" });
      expect(f.remainingEstimate).toMatchObject({ value: "1d 4h", field: "remainingEstimate", raw: "1d 4h" });
      expect("versions" in f).toBe(false);
    });

    test("a Detail the screen offers and nobody filled is a row that says so", async () => {
      const f = await facts("ORBIT-1043");
      expect(f.components).toMatchObject({ value: "" });
      expect(f.start).toMatchObject({ value: "" });
      expect("fixVersions" in f).toBe(false);
      expect("time" in f).toBe(false);
      expect("flag" in f).toBe(false);
    });

    test("reporter, type, start date and flag are read", async () => {
      const f = await facts("ORBIT-1042");
      expect(f.reporter).toMatchObject({ value: "Grace Sample" });
      expect(f.reporter!.initials).toBe("GS");
      expect(f.type!.value).toBe("Bug");
      expect(f.start!.value).toBe("2026-10-05");
      expect(f.flag).toMatchObject({ value: "Impediment", tone: "flag" });
      if (!dc) expect(f.team!.value).toBe("Orbit crew");
      else expect("team" in f).toBe(false);
    });

    test("links of four types in both directions read in the phrase of this card's side", async () => {
      const d = await detail("ORBIT-1050");
      expect(d.linked!.map((l) => [l.phrase, l.direction, l.task.customId, l.type])).toEqual([
        ["blocks", "out", "ACME-8", "Blocks"],
        ["is blocked by", "in", "ACME-7", "Blocks"],
        ["duplicates", "out", "ACME-8", "Duplicate"],
        ["is cloned by", "in", "ACME-7", "Cloners"],
        ["relates to", "in", "ORBIT-1001", "Relates"],
      ]);
    });

    test("a linked card is a row: status, kind and key", async () => {
      const d = await detail("ORBIT-1050");
      const row = d.linked!.find((l) => l.task.customId === "ACME-7")!.task;
      expect(row.status).not.toBe("");
      expect(row.statusKind).toMatch(/open|done|other/);
      expect(row.issueType).toBe("Task");
    });

    test("subtasks are rows with their kind, and a card with none has an empty list", async () => {
      const d = await detail("ORBIT-1043");
      expect(d.subtasks.map((s) => [s.customId, s.issueType])).toEqual([["ORBIT-1046", "Bug"]]);
      expect((await detail("ORBIT-1001")).subtasks).toEqual([]);
      expect((await detail("ORBIT-1001")).linked!.map((l) => l.phrase)).toEqual(["relates to", "relates to"]);
    });

    test("files are listed by name, size, who and when, and carry this app's own route and no address of the site's", async () => {
      const files = (await detail("ORBIT-1042")).attachments!;
      expect(files.map((a) => [a.title, a.ext, a.size, a.who, a.url])).toEqual([
        ["timeout-trace.png", "png", 48210, "Grace Sample", "/jira/file?key=ORBIT-1042&id=30001"],
        ["sync-log.txt", "txt", 1290, "Ada Example", "/jira/file?key=ORBIT-1042&id=30002"],
      ]);
      expect(JSON.stringify(files)).not.toMatch(/atlassian|jira\.acme|token|https?:/);
      expect(files[0]!.at).toBeGreaterThan(0);
      expect((await detail("ORBIT-1001")).attachments).toEqual([]);
    });

    test("the card's remote links are one request that gives the pull requests and every other address", async () => {
      fake.state.remoteLinks["ORBIT-1042"]!.push({ id: 10299, object: { url: "https://docs.acme.example/design/sync", title: "Design note" } });
      fake.requests.length = 0;
      const r = await J.remoteLinksAllStored("ORBIT-1042");
      expect(fake.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /issue/ORBIT-1042/remotelink"]);
      expect(r.data!.links.map((l) => l.number)).toEqual([2196]);
      expect(r.data!.web.map((w) => [w.title, !!w.pr])).toEqual([["#2196 Fix the timeout", true], ["Design note", false]]);
      // The pull-request read the board and the Development section make is the same request and the same rows as before.
      expect((await J.remoteLinksStored("ORBIT-1042")).data!.map((l) => l.number)).toEqual([2196]);
    });

    test("a site's zero time is no time", () => {
      const f = { timetracking: { timeSpent: "0m" } };
      expect(R.factsOf(f, {}, null)).toEqual([]);
      expect(R.factsOf(f, {}, new Set(["timetracking"])).map((x) => [x.id, x.value])).toEqual([["originalEstimate", ""], ["remainingEstimate", ""]]);
      expect(R.factsOf({ timetracking: { timeSpent: "30m", remainingEstimate: "0m" } }, {}, null)[0]!.value).toBe("30m spent");
    });

    test("without the edit screen's list only what holds a value is a row", async () => {
      const issue = { fields: { reporter: null, issuetype: { name: "Task" }, components: [], fixVersions: [{ name: "2.4" }], timetracking: {} } };
      expect(R.factsOf(issue.fields, {}, null).map((f) => f.id)).toEqual(["type", "fixVersions"]);
    });
  });
}

describe("every remote link is a row", () => {
  test("any address is kept, a pull request is marked, an address that is not for a person is dropped", () => {
    const rows = R.webLinksOf([
      { id: 1, object: { url: "https://github.com/acme/orbit/pull/2196", title: "#2196 Fix the timeout" } },
      { id: 2, object: { url: "https://docs.acme.example/design/sync", title: "Design note" } },
      { id: 3, object: { url: "javascript:alert(1)", title: "no" } },
      { id: 4, object: { url: "file:///etc/passwd", title: "no" } },
      { id: 5, object: { url: "https://docs.acme.example/design/sync", title: "Same address twice" } },
      { id: 6, object: { url: "https://status.acme.example/" } },
    ]);
    expect(rows.map((r) => [r.title, r.host, !!r.pr])).toEqual([
      ["#2196 Fix the timeout", "github.com", true],
      ["Design note", "docs.acme.example", false],
      ["status.acme.example", "status.acme.example", false],
    ]);
  });
});
