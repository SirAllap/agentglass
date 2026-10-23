/*
 * Who is on a Jira card, and the hand-off, against the stand-in site as Cloud
 * (REST v3, account ids) and as Data Center (REST v2, login names).
 *
 * What a mistake here costs: a card handed off with its owner silently taken
 * off and the card never moved; a second write that checks the stamp the first
 * one changed (refused, or unchecked and overwriting whoever a workflow put on
 * the card); `"-1"` sent, which gives the card to the project's default
 * assignee; a short people list read as "that is everybody". Every request
 * count is the person's one action.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-people-"));
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

const credFile = join(dir, "creds.json");
const settingsFile = join(dir, "jira-settings.json");
J.__setJiraSettingsPath(settingsFile);

afterAll(() => {
  C.__clearAll();
  C.__setCredentialsPath(null);
  J.__setJiraBase(null);
  J.__setJiraSettingsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

function suite(flavor: FakeFlavor) {
  const dc = flavor === "datacenter";
  /** How each flavor names a person in a write: an account id, or a login. */
  const grace = dc ? "grace" : "acc-0002";
  const field = dc ? "name" : "accountId";
  describe(`people and the hand-off, ${dc ? "Data Center (v2)" : "Cloud (v3)"}`, () => {
    let fake: FakeJira;
    beforeAll(() => { fake = startFakeJira({ flavor }); });
    afterAll(async () => { await fake.stop(); });
    beforeEach(async () => {
      fake.reset();
      rmSync(settingsFile, { force: true });
      C.__setCredentialsPath(credFile);
      C.__clearAll();
      J.__setJiraBase(fake.base);
      J.__setJiraGuard(null);
      process.env.AGENTGLASS_JIRA_WRITE = "1";
      const r = dc
        ? await J.connectJira({ site: "jira.acme.example", token: FAKE_PAT })
        : await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      // The priority list is remembered after the first card read, as it is in a real session.
      expect((await J.withStored((c) => J.readIssue(c, "ORBIT-1042"))).ok).toBe(true);
      fake.requests.length = 0;
    });
    afterEach(() => {
      // Whatever a test did, the project's default assignee word never went out.
      for (const r of fake.requests) expect(JSON.stringify(r.body ?? null)).not.toContain('"-1"');
      for (const a of added.splice(0)) {
        const list = fake.state.workflow.transitions[a.from]!;
        list.splice(list.findIndex((t) => t.id === a.id), 1);
      }
      delete process.env.AGENTGLASS_JIRA_WRITE;
      J.__setJiraBase(null);
    });

    // The stand-in shares its workflow between sites in one process: what a test adds, it takes out.
    const added: { from: string; id: string }[] = [];
    const addMove = (from: string, t: { id: string; name: string; toStatusId: string; acceptsAssignee?: boolean; postAssign?: string; requiredFields?: string[] }) => {
      fake.state.workflow.transitions[from]!.push({ requiredFields: [], acceptsAssignee: false, ...t });
      added.push({ from, id: t.id });
    };
    const upd = (k: string) => Date.parse(fake.state.issues[k]!.updated);
    const wire = () => fake.requests.map((r) => `${r.method} ${r.path}`);
    const writes = () => fake.requests.filter((r) => r.method !== "GET");
    const handOff = (k: string, choice: { to?: string; clear?: boolean } = {}, updated = upd(k)) => J.handOffStored(k, updated, choice);

    describe("who can be given the card", () => {
      test("asked by what was typed, for this card, as the flavor spells it; inactive people are left out", async () => {
        const r = await J.assignableStored("ORBIT-1042", "a");
        expect(r.ok).toBe(true);
        expect(wire()).toEqual(["GET /user/assignable/search"]);
        const q = fake.requests[0]!.query;
        expect(q.issueKey).toBe("ORBIT-1042");
        expect(q[dc ? "username" : "query"]).toBe("a");
        expect(q[dc ? "query" : "username"]).toBeUndefined();
        expect(q.actionDescriptorId).toBeUndefined();
        expect(r.data!.map((p) => [p.key, p.id, p.name])).toEqual(dc
          // Data Center also matches the login and the email, so the third person scanned is in too.
          ? [["ada", "JIRAUSER10000", "Ada Example"], ["grace", "JIRAUSER10001", "Grace Sample"], ["lin", "JIRAUSER10002", "Lin Tester"]]
          : [["acc-0001", "acc-0001", "Ada Example"], ["acc-0002", "acc-0002", "Grace Sample"]]);
        expect(r.data!.every((p) => p.avatar?.startsWith("https://"))).toBe(true);
      });

      test("a short answer is Jira's scan cap, not the end of the directory", async () => {
        // The stand-in scans three people; the fourth matches and is not in the answer.
        const r = await J.assignableStored("ORBIT-1042", "margaret");
        expect(r).toEqual({ ok: true, data: [] });
        expect(fake.requests[0]!.query.maxResults).toBe("20");
      });

      test("the same text again is remembered; another text is asked", async () => {
        await J.assignableStored("ORBIT-1042", "Gr");
        await J.assignableStored("ORBIT-1042", " gr ");
        expect(fake.requests.length).toBe(1);
        await J.assignableStored("ORBIT-1042", "gra");
        expect(fake.requests.length).toBe(2);
      });

      test("for a move: who can be given the card during it", async () => {
        await J.assignableStored("ORBIT-1042", "", "21");
        expect(fake.requests[0]!.query.actionDescriptorId).toBe("21");
      });

      test("a bad key or move sends nothing; a failure is an error, not nobody", async () => {
        expect((await J.assignableStored("not a key", "")).ok).toBe(false);
        expect((await J.assignableStored("ORBIT-1042", "", "21&x=1")).ok).toBe(false);
        expect(fake.requests.length).toBe(0);
        fake.fail({ path: "/user/assignable/search", status: 500 });
        const r = await J.assignableStored("ORBIT-1042", "zz");
        expect(r).toMatchObject({ ok: false, error: "Could not reach Jira" });
      });
    });

    describe("setting the assignee", () => {
      test("a card whose updated cannot be read is refused and nothing is written", async () => {
        const at = upd("ORBIT-1042");
        fake.state.issues["ORBIT-1042"]!.updated = "not a date";
        const r = await J.setAssigneeStored("ORBIT-1042", null, at);
        expect(r.ok).toBe(false);
        expect(r.conflict).toBeUndefined();
        expect(writes()).toEqual([]);
      });

      test("assign: check, PUT, read back; the body names the person as the flavor does", async () => {
        const r = await J.setAssigneeStored("ORBIT-1001", grace, upd("ORBIT-1001"));
        expect(r.ok).toBe(true);
        expect(r.task?.assignees).toEqual(["Grace Sample"]);
        expect(r.was).toBeUndefined();
        expect(fake.state.issues["ORBIT-1001"]!.assignee).toBe("acc-0002");
        expect(wire()).toEqual(["GET /issue/ORBIT-1001", "PUT /issue/ORBIT-1001/assignee", "GET /issue/ORBIT-1001"]);
        expect(writes()[0]!.body).toEqual({ [field]: grace });
      });

      test("unassign is null, never the default-assignee word", async () => {
        const r = await J.setAssigneeStored("ORBIT-1042", null, upd("ORBIT-1042"));
        expect(r.ok).toBe(true);
        expect(r.task?.assignees).toEqual([]);
        expect(writes()[0]!.body).toEqual({ [field]: null });
      });

      test('"-1" is refused before anything is sent', async () => {
        const r = await J.setAssigneeStored("ORBIT-1042", "-1", upd("ORBIT-1042"));
        expect(r).toEqual({ ok: false, error: "That is not somebody Jira knows" });
        expect(fake.requests.length).toBe(0);
      });

      test("somebody Jira will not take is a sentence, never Jira's body", async () => {
        const r = await J.setAssigneeStored("ORBIT-1042", dc ? "nobody-here" : "acc-9999", upd("ORBIT-1042"));
        expect(r).toEqual({ ok: false, error: "Jira did not take that person: they may not be assignable to this card" });
        expect(fake.state.issues["ORBIT-1042"]!.assignee).toBe("acc-0001");
      });

      test("no permission to assign is a sentence", async () => {
        fake.state.deny.assign.push("ORBIT-1042");
        const r = await J.setAssigneeStored("ORBIT-1042", grace, upd("ORBIT-1042"));
        expect(r).toEqual({ ok: false, error: "Your Jira account cannot assign this card" });
      });

      test("a stale stamp is a conflict and nothing is written", async () => {
        const r = await J.setAssigneeStored("ORBIT-1042", grace, upd("ORBIT-1042") - 1000);
        expect(r).toMatchObject({ ok: false, conflict: true });
        expect(writes()).toEqual([]);
      });

      test("writes off, or no stamp: nothing is sent", async () => {
        expect((await J.setAssigneeStored("ORBIT-1042", grace, 0)).ok).toBe(false);
        delete process.env.AGENTGLASS_JIRA_WRITE;
        expect(await J.setAssigneeStored("ORBIT-1042", grace, upd("ORBIT-1042"))).toEqual({ ok: false, error: "Writing to Jira is switched off" });
        expect(fake.requests.length).toBe(0);
      });
    });

    describe("the hand-off", () => {
      test("the move's screen has the assignee: ONE write, the card moved and nobody on it, four requests", async () => {
        const r = await handOff("ORBIT-1042", { to: "3", clear: true });
        expect(r.ok).toBe(true);
        expect(r.partial).toBeUndefined();
        expect(r.was).toBe("In Progress");
        expect(r.task).toMatchObject({ status: "In Review", assignees: [] });
        expect(writes().length).toBe(1);
        expect(writes()[0]!.body).toEqual({ transition: { id: "21" }, fields: { assignee: null } });
        expect(fake.requests.length).toBeLessThanOrEqual(4);
        expect(wire()).toEqual(["GET /issue/ORBIT-1042", "GET /issue/ORBIT-1042/transitions", "POST /issue/ORBIT-1042/transitions", "GET /issue/ORBIT-1042"]);
      });

      test("the screen has no assignee: move, look, then take off; two writes, six requests", async () => {
        const r = await handOff("ORBIT-1042", { to: "1", clear: true });
        expect(r.ok).toBe(true);
        expect(r.partial).toBeUndefined();
        expect(r.task).toMatchObject({ status: "To Do", assignees: [] });
        expect(writes().map((w) => w.body)).toEqual([{ transition: { id: "22" } }, { [field]: null }]);
        expect(wire()).toEqual([
          "GET /issue/ORBIT-1042", "GET /issue/ORBIT-1042/transitions", "POST /issue/ORBIT-1042/transitions",
          "GET /issue/ORBIT-1042", "PUT /issue/ORBIT-1042/assignee", "GET /issue/ORBIT-1042",
        ]);
        expect(fake.requests.length).toBeLessThanOrEqual(6);
      });

      test("THE TRAP: a second write guarded by the stamp the person saw is refused after the move", async () => {
        // What a client that sequenced the two writes itself would do, with one stamp.
        const seen = upd("ORBIT-1042");
        expect((await J.moveStored("ORBIT-1042", "22", seen)).ok).toBe(true);
        const second = await J.setAssigneeStored("ORBIT-1042", null, seen);
        expect(second).toMatchObject({ ok: false, conflict: true });
        expect(fake.state.issues["ORBIT-1042"]!.assignee).toBe("acc-0001");
        // The hand-off's own second precondition is the assignee, so the same two steps land.
        fake.reset();
        fake.requests.length = 0;
        const r = await handOff("ORBIT-1042", { to: "1", clear: true });
        expect(r).toMatchObject({ ok: true, task: { status: "To Do", assignees: [] } });
      });

      test("a workflow that puts somebody on the card on the way in: kept, said, no PUT", async () => {
        addMove("2", { id: "24", name: "Straight to QA", toStatusId: "4", postAssign: "acc-0003" });
        const r = await handOff("ORBIT-1042", { to: "4", clear: true });
        expect(r.ok).toBe(true);
        expect(r.partial).toBe("Moved to QA; Lin Tester was put on it meanwhile, so nobody was taken off");
        expect(r.task).toMatchObject({ status: "QA", assignees: ["Lin Tester"] });
        expect(writes().filter((w) => w.method === "PUT")).toEqual([]);
      });

      test("the same workflow step after an atomic clear is said as well", async () => {
        const r = await handOff("ORBIT-1043", { to: "4", clear: true });
        expect(r.ok).toBe(true);
        expect(r.partial).toBe("Moved to QA; Lin Tester was put on it by the workflow");
        expect(writes().length).toBe(1);
      });

      test("the screen took the field but the same person is still on it: said as still assigned, not as the workflow", async () => {
        addMove("2", { id: "26", name: "Keep owner", toStatusId: "4", acceptsAssignee: true, postAssign: "acc-0001" });
        const r = await handOff("ORBIT-1042", { to: "4", clear: true });
        expect(r.ok).toBe(true);
        expect(r.partial).toBe("Moved to QA, but Ada Example is still assigned: Jira did not take them off");
      });

      test("already there: refused after the one read, before the moves are asked", async () => {
        expect(await handOff("ORBIT-1042", { to: "2" })).toEqual({ ok: false, error: "ORBIT-1042 is already in In Progress" });
        expect(fake.requests.length).toBe(1);
      });

      test("the PUT fails after the move: moved, still assigned, said as a warning", async () => {
        fake.fail({ path: "/issue/ORBIT-1042/assignee", method: "PUT", status: 500 });
        const r = await handOff("ORBIT-1042", { to: "1", clear: true });
        expect(r.ok).toBe(true);
        expect(r.partial).toBe("Moved to To Do, but Ada Example is still assigned: Could not reach Jira");
        expect(r.task).toMatchObject({ status: "To Do", assignees: ["Ada Example"] });
        expect(fake.state.issues["ORBIT-1042"]!.statusId).toBe("1");
      });

      test("a stale stamp: a conflict, zero writes", async () => {
        const r = await handOff("ORBIT-1042", { to: "3", clear: true }, upd("ORBIT-1042") - 1000);
        expect(r).toMatchObject({ ok: false, conflict: true });
        expect(writes()).toEqual([]);
        expect(fake.requests.length).toBe(1);
      });

      test("not clearing: one write, the assignee stays", async () => {
        const r = await handOff("ORBIT-1042", { to: "1", clear: false });
        expect(r).toMatchObject({ ok: true, task: { status: "To Do", assignees: ["Ada Example"] } });
        expect(writes().map((w) => w.body)).toEqual([{ transition: { id: "22" } }]);
      });

      test("nobody on the card: nothing to take off, one write", async () => {
        const r = await handOff("ORBIT-1001", { to: "2", clear: true });
        expect(r.ok).toBe(true);
        expect(writes().map((w) => w.body)).toEqual([{ transition: { id: "11" } }]);
      });

      test("a destination not reachable from here, or one that needs a field: refused, zero writes", async () => {
        J.setHandoffRule("ORBIT", { to: { id: "5", name: "Done" }, askTo: false, clear: true, askClear: false });
        expect(await handOff("ORBIT-1042")).toEqual({ ok: false, error: "ORBIT-1042 cannot go to Done from In Progress" });
        const r = await handOff("ORBIT-1044", { to: "5" });
        expect(r.error).toBe("That move needs resolution, which cannot be filled in here yet");
        expect(await handOff("ORBIT-1042", { to: "2" })).toEqual({ ok: false, error: "ORBIT-1042 is already in In Progress" });
        expect(writes()).toEqual([]);
      });

      test("a 409 on the move is a conflict; a 400 is our sentence", async () => {
        fake.fail({ path: "/issue/ORBIT-1042/transitions", method: "POST", status: 409, times: 1 });
        expect(await handOff("ORBIT-1042", { to: "1", clear: true })).toMatchObject({ ok: false, conflict: true });
        fake.fail({ path: "/issue/ORBIT-1042/transitions", method: "POST", status: 400, times: 1 });
        expect(await handOff("ORBIT-1042", { to: "1", clear: true })).toEqual({ ok: false, error: "Jira did not accept that move. The card may have moved on, or you cannot move it" });
        expect(fake.state.issues["ORBIT-1042"]!.assignee).toBe("acc-0001");
      });

      test("with no choice sent, the project's setting decides; with none set, nothing is sent", async () => {
        expect(await handOff("ORBIT-1042")).toEqual({ ok: false, error: "No hand-off is set for ORBIT: choose where it goes in Settings" });
        expect(writes()).toEqual([]);
        J.setHandoffRule("ORBIT", { to: { id: "3", name: "In Review" }, askTo: false, clear: true, askClear: false });
        const r = await handOff("ORBIT-1042");
        expect(r).toMatchObject({ ok: true, task: { status: "In Review", assignees: [] } });
        // What was asked in the dialog wins over the setting.
        fake.reset();
        const kept = await handOff("ORBIT-1042", { to: "3", clear: false });
        expect(kept).toMatchObject({ ok: true, task: { status: "In Review", assignees: ["Ada Example"] } });
      });

      test("writes off, a bad key, a bad status: nothing is sent", async () => {
        expect((await handOff("ORBIT-1042", { to: "x" })).ok).toBe(false);
        expect((await J.handOffStored("bad", 1)).ok).toBe(false);
        delete process.env.AGENTGLASS_JIRA_WRITE;
        expect(await handOff("ORBIT-1042", { to: "3" })).toEqual({ ok: false, error: "Writing to Jira is switched off" });
        expect(fake.requests.length).toBe(0);
      });
    });

    describe("the hand-off's settings", () => {
      test("a project's statuses, once across its issue types, remembered", async () => {
        const r = await J.projectStatusesStored("ORBIT");
        expect(r.data!.map((s) => [s.id, s.name, s.kind])).toEqual([
          ["1", "To Do", "open"], ["2", "In Progress", "open"], ["3", "In Review", "open"], ["4", "QA", "open"], ["5", "Done", "done"],
        ]);
        await J.projectStatusesStored("ORBIT");
        expect(wire()).toEqual(["GET /project/ORBIT/statuses"]);
        expect((await J.projectStatusesStored("not a key")).ok).toBe(false);
      });

      test("a rule is kept beside the write switch, and flipping the switch keeps the rule", () => {
        const rule = { to: { id: "4", name: "QA" }, askTo: true, clear: true, askClear: false };
        expect(J.setHandoffRule("ORBIT", rule).ok).toBe(true);
        J.setJiraWrites(true);
        J.setJiraWrites(false);
        expect(J.jiraSettings().handoff).toEqual({ ORBIT: rule });
        expect(JSON.parse(readFileSync(settingsFile, "utf8")).writes).toBe(false);
        expect(J.setHandoffRule("ORBIT", null).ok).toBe(true);
        expect(J.jiraSettings().handoff).toEqual({});
      });

      test("what is not a rule is refused, and a hand-edited file is read for what it can be", () => {
        expect(J.setHandoffRule("orbit", { to: null }).ok).toBe(false);
        expect(J.setHandoffRule("ORBIT", "QA").ok).toBe(false);
        expect(J.setHandoffRule("ORBIT", { to: { id: "../x", name: "QA" } }).error).toBe("That is not one of the project's statuses");
        expect(J.setHandoffRule("ORBIT", { to: null, askTo: true }).ok).toBe(true);
        expect(J.jiraSettings().handoff.ORBIT).toEqual({ to: null, askTo: true, clear: false, askClear: false });
      });
    });
  });
}

suite("cloud");
suite("datacenter");

test("not connected: every call is the sentence, and nothing is asked", async () => {
  C.__setCredentialsPath(credFile);
  C.__clearAll();
  expect(await J.assignableStored("ORBIT-1042", "")).toEqual({ ok: false, error: "Jira is not connected" });
  expect(await J.setAssigneeStored("ORBIT-1042", null, 1)).toEqual({ ok: false, error: "Jira is not connected" });
  expect(await J.handOffStored("ORBIT-1042", 1)).toEqual({ ok: false, error: "Jira is not connected" });
});
