/*
 * What a Jira card's pane shows beside its words: the sprint, the points, the
 * parent and the subtasks. They come on the same single issue read the words
 * do, asked for by field name, so the pane costs one request more than the
 * words alone only the first time the site's field ids are learned. A site
 * whose fields cannot be read still shows the card, without them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-facts-"));
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
  describe(`a card's facts, ${dc ? "Data Center" : "Cloud"}`, () => {
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
      fake.requests.length = 0;
    });
    afterEach(() => { J.__setJiraBase(null); });
    const wire = () => fake.requests.map((r) => `${r.method} ${r.path}`);

    test("sprint, points and parent ride on the card, subtasks come as cards", async () => {
      const r = await K.detailStored("ORBIT-1042");
      expect(r.ok).toBe(true);
      expect(r.data!.detail.task).toMatchObject({ sprint: "Sprint 4", parent: { key: "ORBIT-1000", title: "Report improvements" } });
      const r2 = await K.detailStored("ORBIT-1043");
      expect(r2.data!.detail.task.subtasks).toBe(1);
      expect(r2.data!.detail.subtasks.map((t) => ({ key: t.customId, status: t.status }))).toEqual([{ key: "ORBIT-1046", status: expect.any(String) }]);
      expect(r2.data!.detail.subtasks[0]!.title).not.toBe("");
    });

    test("with several points fields the card's own read says nothing of points, so it cannot overwrite the board's", async () => {
      const ids = await J.siteFields(J.storedCreds()!);
      const n = ids.ok ? ids.data!.points.length : -1;
      const t = (await K.detailStored("ORBIT-1042")).data!.detail.task;
      if (n > 1) {
        expect("points" in t).toBe(false);
        const asked = fake.requests.filter((r) => r.path.includes("/issue/ORBIT-1042")).map((r) => r.path).join("\n");
        for (const f of ids.data!.points) expect(asked).not.toContain(f);
      } else {
        expect(n).toBe(1);
        expect(t.points).toBe(5);
      }
      expect(n).toBe(dc ? 1 : 2);
    });

    test("a card with none of them carries none of the keys, and says zero subtasks", async () => {
      const t = (await K.detailStored("ORBIT-1001")).data!.detail;
      for (const k of ["sprint", "points"]) expect(k in t.task).toBe(false);
      // Subtasks were asked for and none came back: zero, said outright.
      expect(t.task.subtasks).toBe(0);
      expect(t.subtasks).toEqual([]);
    });

    test("a card whose subtasks were all removed says zero, so the board's stale count does not stand", () => {
      const stale = { id: "20043", customId: "ORBIT-1043", title: "Retry the webhook delivery", subtasks: 2 } as never;
      const asked = K.toDetail({ fields: { subtasks: [] } }, stale, dc ? 2 : 3);
      expect(asked.detail.task.subtasks).toBe(0);
      const notAsked = K.toDetail({ fields: {} }, stale, dc ? 2 : 3);
      expect(notAsked.detail.task.subtasks).toBe(2);
    });

    test("the fields are learned once: the second card is one request", async () => {
      await K.detailStored("ORBIT-1042");
      fake.requests.length = 0;
      await K.detailStored("ORBIT-1043");
      expect(wire()).toEqual(["GET /issue/ORBIT-1043"]);
      const asked = fake.requests[0]!.query.fields!.split(",");
      expect(asked).toEqual(expect.arrayContaining(["parent", "subtasks", dc ? "customfield_10104" : "customfield_10020"]));
    });

    test("a site whose fields cannot be read still shows the card, without them", async () => {
      fake.fail({ path: "/field", method: "GET", status: 500 });
      const r = await K.detailStored("ORBIT-1042");
      expect(r.ok).toBe(true);
      expect(r.data!.detail.task.title).toBe("Fix timeout when syncing the board");
      expect("sprint" in r.data!.detail.task).toBe(false);
      expect(r.data!.detail.task.parent).toMatchObject({ key: "ORBIT-1000" });
    });
  });
}
