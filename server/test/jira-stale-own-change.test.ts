/*
 * A Jira card's `updated` moves for a comment, a label or a worklog as well as
 * for the fields a write sets. Measured: the person's own comment moved it, and
 * the assignee change they made next was refused as "somebody changed this
 * card". The card is read the way the panel reads it (that leaves the
 * baseline), changed behind the panel's back, and written with the old stamp.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import users from "./fixtures/jira/users.json";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-stale-"));
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
const S = await import("../src/jiraSteps.ts");
const { __clearSeen } = await import("../src/cardStamp.ts");

const credFile = join(dir, "creds.json");
J.__setJiraSettingsPath(join(dir, "jira-settings.json"));

afterAll(() => {
  C.__clearAll();
  C.__setCredentialsPath(null);
  // The directory is a module the whole run shares: take the second Ada back out.
  users.splice(users.findIndex((u) => u.accountId === ADA2), 1);
  J.__setJiraBase(null);
  J.__setJiraSettingsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const KEY = "ORBIT-1042";
/** Somebody who reads exactly like the card's assignee (Ada Example) but is another person: another account id, another Data Center key. */
const ADA2 = "acc-0099";
users.push({ accountId: ADA2, name: "ada", key: "JIRAUSER10099", displayName: "Ada Example", active: true, emailVisible: true, email: "ada2@acme.example" });

function suite(flavor: FakeFlavor) {
  const dc = flavor === "datacenter";
  const grace = dc ? "grace" : "acc-0002";
  describe(`a stamp that moved under other fields, ${dc ? "Data Center (v2)" : "Cloud (v3)"}`, () => {
    let fake: FakeJira;
    beforeAll(() => { fake = startFakeJira({ flavor }); });
    afterAll(async () => { await fake.stop(); });
    beforeEach(async () => {
      fake.reset();
      __clearSeen();
      C.__setCredentialsPath(credFile);
      C.__clearAll();
      J.__setJiraBase(fake.base);
      J.__setJiraGuard(null);
      process.env.AGENTGLASS_JIRA_WRITE = "1";
      const r = dc
        ? await J.connectJira({ site: "jira.acme.example", token: FAKE_PAT })
        : await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      // The panel reads the card: that read is what a later write is compared with.
      expect((await J.withStored((c) => J.readIssue(c, KEY, { fresh: true }))).ok).toBe(true);
      fake.requests.length = 0;
    });
    afterEach(() => {
      delete process.env.AGENTGLASS_JIRA_WRITE;
      J.__setJiraBase(null);
      rmSync(join(dir, "jira-settings.json"), { force: true });
    });

    const issue = () => fake.state.issues[KEY]!;
    const seenAt = () => Date.parse(issue().updated);
    /** The card moves on: a later stamp, whatever the test changed besides. */
    const touch = () => { issue().updated = new Date(seenAt() + 60_000).toISOString().replace("Z", "+0000"); };
    const writes = () => fake.requests.filter((r) => r.method !== "GET");

    describe("moving the card", () => {
      test("only the stamp moved: the transition goes out", async () => {
        const at = seenAt();
        touch();
        const r = await J.moveStored(KEY, "21", at);
        expect(r.ok).toBe(true);
        expect(r.conflict).toBeUndefined();
        expect(writes().map((w) => `${w.method} ${w.path}`)).toEqual([`POST /issue/${KEY}/transitions`]);
        expect(issue().statusId).toBe("3");
      });

      test("the assignee changed, not the status: the transition goes out", async () => {
        const at = seenAt();
        issue().assignee = "acc-0002";
        touch();
        expect((await J.moveStored(KEY, "21", at)).ok).toBe(true);
        expect(writes()).toHaveLength(1);
      });

      test("the status changed: conflict, says what it is now, nothing written", async () => {
        const at = seenAt();
        issue().statusId = "1";
        touch();
        const r = await J.moveStored(KEY, "21", at);
        expect(r.ok).toBe(false);
        expect(r.conflict).toBe(true);
        expect(r.error).toBe("This card changed while you had it open: its status is now To Do. Reloaded");
        expect(writes()).toEqual([]);
      });

      test("a stamp nobody read is the old conflict", async () => {
        touch();
        const r = await J.moveStored(KEY, "21", seenAt() - 120_000);
        expect(r.conflict).toBe(true);
        expect(r.error).toBe("Somebody changed this card while you had it open, reloaded");
        expect(writes()).toEqual([]);
      });
    });

    describe("setting the assignee", () => {
      test("only the stamp moved: the assignee write goes out", async () => {
        const at = seenAt();
        touch();
        const r = await J.setAssigneeStored(KEY, grace, at);
        expect(r.ok).toBe(true);
        expect(writes().map((w) => `${w.method} ${w.path}`)).toEqual([`PUT /issue/${KEY}/assignee`]);
        expect(issue().assignee).toBe("acc-0002");
      });

      test("the status changed, not the assignee: the write goes out", async () => {
        const at = seenAt();
        issue().statusId = "3";
        touch();
        expect((await J.setAssigneeStored(KEY, grace, at)).ok).toBe(true);
        expect(writes()).toHaveLength(1);
      });

      test("somebody else was put on the card: conflict, names who, nothing written", async () => {
        const at = seenAt();
        issue().assignee = "acc-0002";
        touch();
        const r = await J.setAssigneeStored(KEY, grace, at);
        expect(r.ok).toBe(false);
        expect(r.conflict).toBe(true);
        expect(r.error).toBe("This card changed while you had it open: it is now assigned to Grace Sample. Reloaded");
        expect(writes()).toEqual([]);
      });

      test("the card was cleared: the sentence says nobody is on it", async () => {
        const at = seenAt();
        issue().assignee = null;
        touch();
        const r = await J.setAssigneeStored(KEY, grace, at);
        expect(r.error).toBe("This card changed while you had it open: it now has nobody assigned. Reloaded");
        expect(writes()).toEqual([]);
      });

      test("a stamp nobody read is the old conflict", async () => {
        touch();
        const r = await J.setAssigneeStored(KEY, grace, seenAt() - 120_000);
        expect(r.conflict).toBe(true);
        expect(r.error).toBe("Somebody changed this card while you had it open, reloaded");
        expect(writes()).toEqual([]);
      });
    });

    // Two people can share a display name; the card shows both as "Ada Example", and only the id tells them apart.
    describe("an assignee who reads the same", () => {
      test("setting the assignee: another account with the same name is a conflict, nothing written", async () => {
        const at = seenAt();
        issue().assignee = ADA2;
        touch();
        const r = await J.setAssigneeStored(KEY, grace, at);
        expect(r.ok).toBe(false);
        expect(r.conflict).toBe(true);
        expect(r.error).toBe("This card changed while you had it open: it is now assigned to Ada Example. Reloaded");
        expect(writes()).toEqual([]);
      });
    });

    // The two writes that may move the card and change who has it hold both to what the person saw.
    const runners: Record<string, (at: number) => Promise<{ ok: boolean; conflict?: boolean; error?: string }>> = {
      "hand-off": (at) => J.handOffStored(KEY, at, { to: "3" }),
      "step": (at) => {
        expect(S.setJiraSteps({ handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["In Review"] }] } })).toMatchObject({ ok: true });
        return S.runStepStored(KEY, at, "handoff", {});
      },
    };
    for (const [name, run] of Object.entries(runners)) {
      describe(`the ${name} after the card's stamp moved`, () => {
        test("only the stamp moved: it goes out", async () => {
          const at = seenAt();
          touch();
          const r = await run(at);
          expect(r.ok).toBe(true);
          expect(r.conflict).toBeUndefined();
          expect(writes().map((w) => `${w.method} ${w.path}`)).toContain(`POST /issue/${KEY}/transitions`);
          expect(issue().statusId).toBe("3");
        });

        test("the status changed: conflict, nothing written", async () => {
          const at = seenAt();
          issue().statusId = "1";
          touch();
          const r = await run(at);
          expect(r.ok).toBe(false);
          expect(r.conflict).toBe(true);
          expect(r.error).toBe("This card changed while you had it open: its status is now To Do. Reloaded");
          expect(writes()).toEqual([]);
        });

        test("somebody else was put on the card: conflict, nothing written", async () => {
          const at = seenAt();
          issue().assignee = "acc-0002";
          touch();
          const r = await run(at);
          expect(r.conflict).toBe(true);
          expect(r.error).toBe("This card changed while you had it open: it is now assigned to Grace Sample. Reloaded");
          expect(writes()).toEqual([]);
        });

        test("another account with the same display name is a conflict too", async () => {
          const at = seenAt();
          issue().assignee = ADA2;
          touch();
          const r = await run(at);
          expect(r.conflict).toBe(true);
          expect(r.error).toBe("This card changed while you had it open: it is now assigned to Ada Example. Reloaded");
          expect(writes()).toEqual([]);
        });
      });
    }
  });
}

suite("cloud");
suite("datacenter");
