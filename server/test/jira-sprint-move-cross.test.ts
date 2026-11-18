/*
 * "Current sprint" on a card in a view that spans spaces (a starred filter, not a board). The cards of such a view carry
 * the sprint the site says they are in, with its id, so the web can name the sprint a card with none should join; the
 * move then reaches the site and the card is in the sprint on the next read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-sprint-cross-"));
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
const V = await import("../src/jiraviews.ts");
const B = await import("../src/jiraboards.ts");
const S = await import("../src/jiraSprintMove.ts");

let fake: FakeJira;
beforeAll(() => { fake = startFakeJira({ flavor: "cloud" }); });
afterAll(async () => {
  await fake.stop();
  C.__clearAll(); C.__setCredentialsPath(null); V.__setJiraViewsPath(null); J.__setJiraBase(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe("Current sprint from a cross-space filter view", () => {
  beforeEach(async () => {
    fake.reset();
    C.__setCredentialsPath(join(dir, "creds.json"));
    V.__setJiraViewsPath(join(dir, "config", "agentglass", "jira-views.json"));
    V.__clear(); J.__setJiraGuard(null); C.__clearAll(); J.__setJiraBase(fake.base);
    expect((await J.connectJira({ site: "acme.atlassian.net", email: FAKE_EMAIL, token: FAKE_TOKEN })).ok).toBe(true);
    expect((await B.addViewByChoice("filter", "10070")).data).toMatchObject({ ok: true });
  });

  test("the cards carry the running sprint's id, and moving a card with none puts it there", async () => {
    const bare = Object.values(fake.state.issues).find((i) => i.key.startsWith("ORBIT-") && !i.sprints.length)!;
    const r = await B.viewRead("filter:10070");
    expect(r.ok).toBe(true);
    const running = r.tasks.find((t) => t.sprintActive);
    expect(running?.sprintId).toMatch(/^\d+$/);
    const out = await S.moveToSprint(J.storedCreds()!, running!.sprintId, [bare.key]);
    expect(out).toEqual({ ok: true });
    expect(fake.state.issues[bare.key]!.sprints.map((s) => String(s.id))).toEqual([running!.sprintId!]);
  });
});
