/*
 * Mine and the people chip, on a board: they go into the search sent to Jira ("mine" -> assignee = currentUser(), a
 * person picked -> assignee = "<id>"), the same way a board's own quick filter does, so the count is the site's answer
 * and never a slice of the first 150 cards the board happened to read. Pressed together they OR into one clause: me, or
 * them - never a card that must be both.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-board-mine-people-"));
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
const site = "acme.atlassian.net";
let fake: FakeJira;

const searches = () => fake.requests.filter((r) => r.path === "/search/jql");
const keysOf = (r: { tasks: { customId?: string }[] }) => r.tasks.map((t) => t.customId);
const addBoard = async (id: string) => { const r = await B.addViewByChoice("board", id); expect(r.data).toMatchObject({ ok: true }); fake.requests.length = 0; };

beforeAll(() => { fake = startFakeJira({ pageSize: 50 }); });
beforeEach(async () => {
  fake.reset();
  C.__setCredentialsPath(credFile);
  V.__setJiraViewsPath(viewsFile);
  V.__clear();
  J.__setJiraGuard(null);
  C.__clearAll();
  J.__setJiraBase(fake.base);
  expect((await J.connectJira({ email: FAKE_EMAIL, site, token: FAKE_TOKEN })).ok).toBe(true);
  fake.state.sprints[3] = [];
  await addBoard("3");
});
afterEach(() => { J.__setJiraBase(null); });
afterAll(async () => {
  await fake.stop();
  C.__clearAll();
  C.__setCredentialsPath(null);
  V.__setJiraViewsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe("Mine on a board", () => {
  test("narrows the one search sent to Jira, not the page already read", async () => {
    const whole = await B.viewRead("board:3");
    fake.requests.length = 0;
    const mine = await B.viewRead("board:3", { quick: ["mine"] });
    expect(mine.ok).toBe(true);
    expect(mine.tasks.length).toBeGreaterThan(0);
    expect(mine.tasks.length).toBeLessThan(whole.tasks.length);
    const sent = searches().map((s) => (s.body as { jql: string }).jql);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("assignee = currentUser()");
  });

  test("the people chip asks for an account id, the same way", async () => {
    fake.requests.length = 0;
    const r = await B.viewRead("board:3", { quick: ["people:acc-0002"] });
    expect(r.ok).toBe(true);
    expect(keysOf(r)).toEqual(["ORBIT-1043"]);
    const sent = (searches()[0]!.body as { jql: string }).jql;
    expect(sent).toContain('assignee = "acc-0002"');
  });

  test("Mine and a person together OR into one clause: the union, not the cards that are both", async () => {
    fake.requests.length = 0;
    const r = await B.viewRead("board:3", { quick: ["mine", "people:acc-0002"] });
    expect(r.ok).toBe(true);
    const sent = (searches()[0]!.body as { jql: string }).jql;
    expect(sent).toContain("(assignee = currentUser() OR assignee = \"acc-0002\")");
    // acc-0002 alone has ORBIT-1043; mine alone has at least ORBIT-1000, 1042, 1050. The union has both sets.
    expect(keysOf(r)).toContain("ORBIT-1043");
    expect(keysOf(r)).toContain("ORBIT-1042");
    expect(searches().length).toBe(1);
  });

  test("an id ASSIGNEE_ID refuses is dropped, never sent to Jira as text", async () => {
    fake.requests.length = 0;
    const r = await B.viewRead("board:3", { quick: ["people:\"); DROP"] });
    expect(r.ok).toBe(true);
    const sent = (searches()[0]!.body as { jql: string }).jql;
    expect(sent).not.toContain("DROP");
    expect(sent).not.toContain("assignee =");
  });
});
