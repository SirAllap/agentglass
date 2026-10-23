/*
 * Steps for Jira, run against the stand-in site as Cloud (REST v3, ADF, account
 * ids) and as Data Center (REST v2, wiki markup, logins).
 *
 * What a mistake here costs: a stamp checked twice, so the second write of one
 * step is refused (or, unchecked, overwrites whoever a workflow put on the
 * card); an assignee taken off before the card has moved, so a refused move
 * leaves a card with no owner and still in its old column; a move retried
 * because the comment after it failed; a comment posted with `{author}` still
 * in it; a link written twice. Every acceptance line has a test, and the
 * ordering one was watched going red with the writes swapped.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-steps-"));
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

const PR = { url: "https://github.com/acme/orbit/pull/318", title: "Retry the export", number: 318, author: "octo-ada" };

function suite(flavor: FakeFlavor) {
  const dc = flavor === "datacenter";
  const me = dc ? "ada" : "acc-0001";
  const lin = dc ? "lin" : "acc-0003";
  const field = dc ? "name" : "accountId";
  describe(`steps, ${dc ? "Data Center (v2)" : "Cloud (v3)"}`, () => {
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
      expect((await J.withStored((c) => J.readIssue(c, "ORBIT-1042"))).ok).toBe(true);
      fake.requests.length = 0;
    });
    afterEach(() => {
      delete process.env.AGENTGLASS_JIRA_WRITE;
      J.__setJiraBase(null);
      fake.state.workflow.transitions["4"] = fake.state.workflow.transitions["4"]!.filter((t) => t.id !== "43");
    });

    const upd = (k: string) => Date.parse(fake.state.issues[k]!.updated);
    const wire = () => fake.requests.map((r) => `${r.method} ${r.path}`);
    const writes = () => fake.requests.filter((r) => r.method !== "GET");
    const setup = (step: "handoff" | "review" | "merge", blocks: unknown[]) => {
      const r = S.setJiraSteps({ [step]: { enabled: true, blocks } });
      expect(r).toMatchObject({ ok: true });
    };
    const run = (k: string, step: "handoff" | "review" | "merge" = "handoff", choice: Record<string, unknown> = {}, pr: unknown = PR, updated = upd(k)) =>
      S.runStepStored(k, updated, step, choice as never, pr as never);
    const person = (k: string) => fake.state.issues[k]!.assignee;
    const status = (k: string) => fake.state.workflow.statuses.find((s) => s.id === fake.state.issues[k]!.statusId)!.name;

    describe("the move", () => {
      test("the first name a transition from here reaches wins, and the card moves in one write", async () => {
        setup("handoff", [{ type: "move", statusNames: ["QA", "in review"] }]);
        const r = await run("ORBIT-1042");
        expect(r).toMatchObject({ ok: true, was: "In Progress", task: { status: "In Review" } });
        expect(r.partial).toBeUndefined();
        expect(writes().length).toBe(1);
        expect(writes()[0]!.body).toEqual({ transition: { id: "21" } });
        expect(wire()).toEqual(["GET /issue/ORBIT-1042", "GET /issue/ORBIT-1042/transitions", "POST /issue/ORBIT-1042/transitions", "GET /issue/ORBIT-1042"]);
      });

      test("a name nothing reaches, from a status that is not it, is refused with no write", async () => {
        setup("handoff", [{ type: "move", statusNames: ["QA"] }]);
        const r = await run("ORBIT-1042");
        expect(r.ok).toBe(false);
        expect(r.error).toContain("cannot go to QA from In Progress");
        expect(writes().length).toBe(0);
      });

      test("a move whose screen needs a field is refused before any write", async () => {
        setup("handoff", [{ type: "move", statusNames: ["Done"] }, { type: "comment", text: "Done: {pr}" }]);
        const r = await run("ORBIT-1044");
        expect(r.ok).toBe(false);
        expect(r.error).toContain("needs resolution");
        expect(writes().length).toBe(0);
      });

      test("a card already in the status is told so, and nothing is written", async () => {
        setup("handoff", [{ type: "move", statusNames: ["In Progress"] }]);
        const r = await run("ORBIT-1042");
        expect(r).toEqual({ ok: false, error: "ORBIT-1042 is already in In Progress" });
        expect(writes().length).toBe(0);
      });

      test("a card already in one of the names is left there, not moved on to the next", async () => {
        setup("handoff", [{ type: "move", statusNames: ["In Progress", "In Review"] }]);
        const r = await run("ORBIT-1042");
        expect(r).toEqual({ ok: false, error: "ORBIT-1042 is already in In Progress" });
        expect(writes().length).toBe(0);
        expect(status("ORBIT-1042")).toBe("In Progress");
      });

      test("a block that does not ask ignores a status a caller names", async () => {
        setup("handoff", [{ type: "move", statusNames: ["In Review"] }]);
        const r = await run("ORBIT-1042", "handoff", { to: "To Do" });
        expect(r).toMatchObject({ ok: true, task: { status: "In Review" } });
      });

      test("a block that asks takes the person's status over the starting names", async () => {
        setup("handoff", [{ type: "move", statusNames: ["QA"], ask: true }]);
        const r = await run("ORBIT-1042", "handoff", { to: "In Review" });
        expect(r).toMatchObject({ ok: true, task: { status: "In Review" } });
      });
    });

    describe("the assignee", () => {
      test("taking it off, where the screen has the assignee: inside the move, one write", async () => {
        setup("handoff", [{ type: "move", statusNames: ["In Review"] }, { type: "unassign", who: "all" }]);
        const r = await run("ORBIT-1042");
        expect(r).toMatchObject({ ok: true, task: { status: "In Review", assignees: [] } });
        expect(r.partial).toBeUndefined();
        expect(writes().length).toBe(1);
        expect(writes()[0]!.body).toEqual({ transition: { id: "21" }, fields: { assignee: null } });
      });

      test("taking it off on a screenless move: the move first, then the assignee, and the stamp is not asked twice", async () => {
        setup("handoff", [{ type: "move", statusNames: ["To Do"] }, { type: "unassign", who: "all" }]);
        const r = await run("ORBIT-1042");
        expect(r).toMatchObject({ ok: true, task: { status: "To Do", assignees: [] } });
        expect(r.partial).toBeUndefined();
        // The order is the point: an assignee write first changes `updated`, and every later write then meets a stamp that moved.
        expect(wire().filter((w) => w.startsWith("POST") || w.startsWith("PUT"))).toEqual(["POST /issue/ORBIT-1042/transitions", "PUT /issue/ORBIT-1042/assignee"]);
        expect(wire().indexOf("PUT /issue/ORBIT-1042/assignee")).toBeGreaterThan(wire().indexOf("POST /issue/ORBIT-1042/transitions"));
        expect(person("ORBIT-1042")).toBeNull();
        // The assignee was read between the two writes, not compared by stamp.
        const between = wire().slice(wire().indexOf("POST /issue/ORBIT-1042/transitions"), wire().indexOf("PUT /issue/ORBIT-1042/assignee"));
        expect(between).toEqual(["POST /issue/ORBIT-1042/transitions", "GET /issue/ORBIT-1042"]);
      });

      test("somebody put on the card meanwhile is left on it, and said", async () => {
        setup("handoff", [{ type: "move", statusNames: ["To Do"] }, { type: "unassign", who: "all" }]);
        // A workflow step that gives the card to somebody on the way in.
        fake.state.workflow.transitions["2"]!.find((t) => t.id === "22")!.postAssign = "acc-0003";
        try {
          const r = await run("ORBIT-1042");
          expect(r.ok).toBe(true);
          expect(r.partial).toContain("Lin Tester was put on it meanwhile");
          expect(writes().map((w) => w.method)).toEqual(["POST"]);
        } finally { delete fake.state.workflow.transitions["2"]!.find((t) => t.id === "22")!.postAssign; }
      });

      test("assigning me, inside the move: the person pressing, as the flavor spells them", async () => {
        setup("handoff", [{ type: "move", statusNames: ["In Review"] }, { type: "assign", who: "me" }]);
        const r = await run("ACME-7");
        expect(r).toMatchObject({ ok: true, task: { status: "In Review" } });
        expect(writes().length).toBe(1);
        expect(writes()[0]!.body).toEqual({ transition: { id: "21" }, fields: { assignee: { [field]: me } } });
        expect(person("ACME-7")).toBe("acc-0001");
      });

      test("assigning a named person, with no move at all: one write on the card, after the stamp", async () => {
        setup("review", [{ type: "assign", who: "person", person: { id: lin, name: "Lin Tester" } }]);
        const r = await run("ORBIT-1042", "review");
        expect(r.ok).toBe(true);
        expect(r.was).toBeUndefined();
        expect(writes().map((w) => `${w.method} ${w.path}`)).toEqual(["PUT /issue/ORBIT-1042/assignee"]);
        expect(person("ORBIT-1042")).toBe("acc-0003");
      });

      test("taking named people off: the stored key is compared with the key a write takes", async () => {
        setup("handoff", [{ type: "unassign", who: "people", people: [{ id: me, name: "Ada Tester" }] }]);
        const r = await run("ORBIT-1042");
        expect(r.ok).toBe(true);
        expect(person("ORBIT-1042")).toBeNull();
      });

      test("assigning a named person is not reported as the workflow's doing", async () => {
        setup("review", [{ type: "assign", who: "person", person: { id: lin, name: "Lin Tester" } }]);
        const r = await run("ORBIT-1042", "review");
        expect(r.ok).toBe(true);
        expect(r.partial).toBeUndefined();
      });

      test("assigning the person who is already on it writes nothing", async () => {
        setup("review", [{ type: "assign", who: "person", person: { id: me, name: "Ada Tester" } }]);
        const r = await run("ORBIT-1042", "review");
        expect(r).toEqual({ ok: false, error: "Nothing to do for ORBIT-1042" });
        expect(writes().length).toBe(0);
      });

      test("a person who asks when it runs: the choice wins, and null is nobody", async () => {
        setup("handoff", [{ type: "assign", ask: true, who: "none" }]);
        expect((await run("ORBIT-1042", "handoff", { assign: lin })).ok).toBe(true);
        expect(person("ORBIT-1042")).toBe("acc-0003");
        fake.requests.length = 0;
        expect((await run("ORBIT-1042", "handoff", { assign: null })).ok).toBe(true);
        expect(person("ORBIT-1042")).toBeNull();
      });

      test("the default-assignee word is refused before any request", async () => {
        setup("handoff", [{ type: "assign", ask: true, who: "none" }]);
        const r = await run("ORBIT-1042", "handoff", { assign: "-1" });
        expect(r).toEqual({ ok: false, error: "That is not somebody Jira knows" });
        expect(fake.requests.length).toBe(0);
      });
    });

    describe("the comment and the link", () => {
      test("a comment, in the format the site speaks, with the placeholders filled in", async () => {
        setup("handoff", [{ type: "move", statusNames: ["In Review"] }, { type: "comment", text: "Opened {pr} by {author}, now {status}: {pr_url}" }]);
        const r = await run("ORBIT-1042");
        expect(r).toMatchObject({ ok: true, task: { status: "In Review" } });
        const post = writes().find((w) => w.path === "/issue/ORBIT-1042/comment")!;
        const body = (post.body as { body: unknown }).body;
        if (dc) expect(typeof body).toBe("string");
        else expect((body as { type: string }).type).toBe("doc");
        const said = JSON.stringify(body);
        expect(said).toContain("#318 Retry the export");
        expect(said).toContain("octo-ada");
        expect(said).toContain("In Review");
        expect(said).not.toContain("{pr}");
      });

      test("a placeholder this place cannot fill is refused before the move, not posted as written", async () => {
        setup("handoff", [{ type: "move", statusNames: ["In Review"] }, { type: "comment", text: "By {author}" }]);
        const r = await run("ORBIT-1042", "handoff", {}, { url: PR.url });
        expect(r.ok).toBe(false);
        expect(r.error).toContain("{author}");
        expect(writes().length).toBe(0);
        expect(status("ORBIT-1042")).toBe("In Progress");
      });

      test("a comment that asks when it runs is posted as the person edited it", async () => {
        setup("review", [{ type: "comment", text: "Draft {pr}", ask: true }]);
        const r = await run("ORBIT-1042", "review", { comment: "Edited by hand" });
        expect(r.ok).toBe(true);
        expect(JSON.stringify(writes().find((w) => w.path === "/issue/ORBIT-1042/comment")!.body)).toContain("Edited by hand");
      });

      test("a failing comment after a successful move reports partial, and the move is not retried", async () => {
        setup("handoff", [{ type: "move", statusNames: ["In Review"] }, { type: "comment", text: "Opened {pr}" }]);
        fake.fail({ path: "/issue/ORBIT-1042/comment", method: "POST", status: 400 });
        const r = await run("ORBIT-1042");
        expect(r.ok).toBe(true);
        expect(r.partial).toBe("Moved to In Review, but the comment was not posted: Jira did not accept that comment");
        expect(r.task).toMatchObject({ status: "In Review" });
        expect(status("ORBIT-1042")).toBe("In Review");
        expect(writes().filter((w) => w.path === "/issue/ORBIT-1042/transitions").length).toBe(1);
        expect(writes().filter((w) => w.path === "/issue/ORBIT-1042/comment").length).toBe(1);
      });

      test("the link is written once, and a second run leaves it", async () => {
        setup("handoff", [{ type: "link" }]);
        const a = await run("ORBIT-1042");
        expect(a.ok).toBe(true);
        const had = fake.state.remoteLinks["ORBIT-1042"]!.length;
        expect(fake.state.remoteLinks["ORBIT-1042"]!.filter((l) => l.object.url === PR.url).length).toBe(1);
        const b = await run("ORBIT-1042");
        expect(b.ok).toBe(true);
        expect(fake.state.remoteLinks["ORBIT-1042"]!.length).toBe(had);
        expect(writes().filter((w) => w.path.endsWith("/remotelink")).length).toBe(1);
      });

      test("a step that links, with no pull request, is refused before any request", async () => {
        setup("handoff", [{ type: "link" }]);
        const r = await run("ORBIT-1042", "handoff", {}, null);
        expect(r).toEqual({ ok: false, error: "This step links a pull request, and none was given" });
        expect(fake.requests.length).toBe(0);
      });

      test("a link that fails after the move is partial, and the move stands", async () => {
        setup("handoff", [{ type: "move", statusNames: ["In Review"] }, { type: "link" }]);
        fake.fail({ path: "/issue/ORBIT-1042/remotelink", method: "POST", status: 400 });
        const r = await run("ORBIT-1042");
        expect(r.ok).toBe(true);
        expect(r.partial).toBe("Moved to In Review, but the pull request was not linked: Jira did not accept that link");
        expect(status("ORBIT-1042")).toBe("In Review");
      });

      test("every block at once, in order: move, assignee inside it, comment, link", async () => {
        setup("handoff", [{ type: "move", statusNames: ["In Review"] }, { type: "assign", who: "me" }, { type: "comment", text: "Opened {pr}" }, { type: "link" }]);
        const r = await run("ACME-7", "handoff", {}, PR);
        expect(r.ok).toBe(true);
        expect(r.partial).toBeUndefined();
        expect(writes().map((w) => `${w.method} ${w.path}`)).toEqual(["POST /issue/ACME-7/transitions", "POST /issue/ACME-7/comment", "POST /issue/ACME-7/remotelink"]);
      });
    });

    describe("what is refused before a write", () => {
      test("a stamp that is not the one the person saw: 409, and no write", async () => {
        setup("handoff", [{ type: "move", statusNames: ["In Review"] }, { type: "unassign", who: "all" }, { type: "comment", text: "Opened {pr}" }]);
        const r = await run("ORBIT-1042", "handoff", {}, PR, upd("ORBIT-1042") - 1000);
        expect(r).toMatchObject({ ok: false, conflict: true });
        expect(writes().length).toBe(0);
        expect(status("ORBIT-1042")).toBe("In Progress");
      });

      test("writes off, or a step that is off: nothing is sent", async () => {
        setup("handoff", [{ type: "move", statusNames: ["In Review"] }]);
        expect(S.setJiraSteps({ handoff: { enabled: false } })).toMatchObject({ ok: true });
        expect(await run("ORBIT-1042")).toEqual({ ok: false, error: "That step is switched off: turn it on in Settings" });
        expect(S.setJiraSteps({ handoff: { enabled: true } })).toMatchObject({ ok: true });
        delete process.env.AGENTGLASS_JIRA_WRITE;
        expect(await run("ORBIT-1042")).toEqual({ ok: false, error: "Writing to Jira is switched off" });
        expect(fake.requests.length).toBe(0);
      });

      test("something that is not a step, or not a card, is refused with no request", async () => {
        setup("handoff", [{ type: "move", statusNames: ["In Review"] }]);
        expect(await run("ORBIT-1042", "elsewhere" as never)).toEqual({ ok: false, error: "That is not one of the steps" });
        expect(await S.runStepStored("not a card", 1, "handoff")).toEqual({ ok: false, error: "That is not a Jira card id" });
        expect(fake.requests.length).toBe(0);
      });
    });

    describe("two runs at once", () => {
      test("the second is refused as already running, and writes nothing", async () => {
        setup("review", [{ type: "comment", text: "Review: {pr}" }]);
        const [a, b] = await Promise.all([run("ORBIT-1042", "review"), run("orbit-1042", "review", {}, PR, upd("ORBIT-1042"))]);
        const results = [a, b];
        expect(results.filter((r) => r.ok).length).toBe(1);
        expect(results.find((r) => !r.ok)!.error).toContain("already running");
        expect(writes().filter((w) => w.path === "/issue/ORBIT-1042/comment").length).toBe(1);
      });

      test("the lock is let go when the run ends, failed or not", async () => {
        setup("review", [{ type: "comment", text: "Review: {pr}" }]);
        expect((await run("ORBIT-1042", "review")).ok).toBe(true);
        // The comment bumped the stamp, so the repeat is a stale one, and not a lock.
        const again = await run("ORBIT-1042", "review", {}, PR, 1);
        expect(again.error ?? "").not.toContain("already running");
        expect((await run("ORBIT-1042", "review")).error ?? "").not.toContain("already running");
      });
    });

    describe("a hand-off from before steps", () => {
      const legacy = (rules: Record<string, unknown>) => writeFileSync(settingsFile, JSON.stringify({ writes: true, handoff: rules }));
      const inReview = { to: { id: "3", name: "In Review" }, askTo: false, askClear: false };

      test("two projects whose rules differ keep both behaviours, and the file is not rewritten by reading it", async () => {
        legacy({ ORBIT: { ...inReview, clear: true }, ACME: { ...inReview, clear: false } });
        const before = readFileSync(settingsFile, "utf8");
        expect(S.jiraSteps().overrides).toEqual(["ACME"]);
        const orbit = await run("ORBIT-1042");
        expect(orbit).toMatchObject({ ok: true, task: { status: "In Review", assignees: [] } });
        const acme = await run("ACME-7");
        expect(acme).toMatchObject({ ok: true, task: { status: "In Review" } });
        // The older rule for ACME keeps the person on the card.
        expect(person("ACME-7")).toBe("acc-0002");
        expect(readFileSync(settingsFile, "utf8")).toBe(before);
      });

      test("saving another step leaves the older rules in charge of the hand-off", async () => {
        legacy({ ORBIT: { ...inReview, clear: true }, ACME: { ...inReview, clear: false } });
        const saved = S.setJiraSteps({ review: { enabled: true, blocks: [{ type: "comment", text: "Review: {pr}" }] } });
        expect(saved).toMatchObject({ ok: true, overrides: ["ACME"] });
        expect(JSON.parse(readFileSync(settingsFile, "utf8")).steps).not.toHaveProperty("handoff");
        expect(S.jiraSteps().overrides).toEqual(["ACME"]);
        const acme = await run("ACME-7");
        expect(acme).toMatchObject({ ok: true, task: { status: "In Review" } });
        expect(person("ACME-7")).toBe("acc-0002");
      });

      test("a project whose older rule asked about the assignee still takes the answer", async () => {
        legacy({ ORBIT: { ...inReview, clear: true }, ACME: { ...inReview, clear: false, askClear: true } });
        expect(S.jiraSteps().overrides).toContain("ACME");
        const r = await run("ACME-7", "handoff", { clear: true });
        expect(r).toMatchObject({ ok: true, task: { status: "In Review", assignees: [] } });
        expect(person("ACME-7")).toBeNull();
      });

      test("saving the step is the person's edit: the older rules stop winning", async () => {
        legacy({ ORBIT: { ...inReview, clear: true }, ACME: { ...inReview, clear: false } });
        expect(S.jiraSteps().steps.handoff.blocks).toEqual([{ type: "move", statusNames: ["In Review"] }, { type: "unassign", who: "all" }]);
        S.setJiraSteps({ handoff: { blocks: [{ type: "move", statusNames: ["In Review"] }, { type: "unassign", who: "all" }] } });
        expect(S.jiraSteps().overrides).toEqual([]);
        const acme = await run("ACME-7");
        expect(acme).toMatchObject({ ok: true, task: { status: "In Review", assignees: [] } });
      });
    });
  });
}

suite("cloud");
suite("datacenter");

describe("the settings", () => {
  beforeEach(() => { rmSync(settingsFile, { force: true }); });
  const blocks = [{ type: "move", statusNames: ["Ready"] }, { type: "assign", who: "person", person: { id: "acc-0003", name: "Lin Tester" } }, { type: "comment", text: "{pr}" }, { type: "link" }];

  test("a step with every Jira block is saved, ids as strings, and reads back the same", () => {
    const r = S.setJiraSteps({ merge: { enabled: true, blocks } });
    expect(r).toMatchObject({ ok: true });
    expect(S.jiraSteps().steps.merge as unknown).toEqual({ enabled: true, blocks });
  });

  test("the closed schema: an unknown key, a number for a Jira person, a custom field and a second block of a kind are refused, and nothing is written", () => {
    for (const bad of [
      { nope: {} },
      { handoff: { enabled: true, statusNames: ["x"] } },
      { handoff: { blocks: [{ type: "assign", who: "person", person: { id: 12, name: "Lin" } }] } },
      { handoff: { blocks: [{ type: "field", field: "Team", value: "Blue" }] } },
      { handoff: { blocks: [{ type: "move", statusNames: ["a"], fallback: true }] } },
      { handoff: { blocks: [{ type: "link", ask: true }] } },
      { handoff: { blocks: [{ type: "move", statusNames: ["a"] }, { type: "move", statusNames: ["b"] }] } },
      { handoff: { blocks: [{ type: "assign", who: "person", person: { id: "-1", name: "Default" } }] } },
      { handoff: { blocks: [{ type: "assign", who: "author" }] } },
    ]) {
      const r = S.setJiraSteps(bad);
      expect(r.ok).toBe(false);
      expect(existsSync(settingsFile)).toBe(false);
    }
  });

  test("a refusal in the second step leaves the first unsaved too", () => {
    const r = S.setJiraSteps({ handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["a"] }] }, review: { blocks: [{ type: "nope" }] } });
    expect(r.ok).toBe(false);
    expect(existsSync(settingsFile)).toBe(false);
  });

  test("a hand-edited step that does not validate falls back to its default, and the others still apply", () => {
    writeFileSync(settingsFile, JSON.stringify({ steps: { handoff: { enabled: true, blocks: [{ type: "bogus" }] }, merge: { enabled: true, blocks: [{ type: "link" }] } } }));
    const s = S.jiraSteps().steps;
    expect(s.handoff).toEqual({ enabled: false, blocks: [] });
    expect(s.merge).toEqual({ enabled: true, blocks: [{ type: "link" }] });
  });

  test("the write switch and the older rules in the same file survive a save", () => {
    writeFileSync(settingsFile, JSON.stringify({ writes: true, handoff: { ORBIT: { to: { id: "3", name: "In Review" }, askTo: false, clear: false, askClear: false } } }));
    S.setJiraSteps({ review: { enabled: true, blocks: [{ type: "link" }] } });
    const file = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(file.writes).toBe(true);
    expect(file.handoff.ORBIT.to.id).toBe("3");
    expect(file.steps.review.blocks).toEqual([{ type: "link" }]);
  });

  test("the older rules read into one step: names in order, clear as take-off, the asks kept", () => {
    const rule = (name: string, o: Record<string, unknown> = {}) => ({ to: { id: "1", name }, askTo: false, clear: false, askClear: false, ...o });
    expect(S.stepFromRules({})).toEqual({ step: { enabled: false, blocks: [] }, overrides: [] });
    expect(S.stepFromRules({ BLUE: rule("Ready", { clear: true }), ACME: rule("Ready", { clear: true }) })).toEqual({
      step: { enabled: true, blocks: [{ type: "move", statusNames: ["Ready"] }, { type: "unassign", who: "all" }] }, overrides: [],
    });
    const mixed = S.stepFromRules({ ACME: rule("Ready", { askTo: true }), BLUE: rule("Verify", { askClear: true }) });
    expect(mixed.step.blocks).toEqual([{ type: "move", statusNames: ["Ready", "Verify"], ask: true }, { type: "unassign", who: "none", ask: true }]);
    expect(mixed.overrides).toEqual(["ACME", "BLUE"]);
  });

  test("ClickUp's own settings still refuse the link, with the sentence they always had", async () => {
    const { applyPrefs, defaultPrefs } = await import("../src/clickupPrefs.ts");
    expect(applyPrefs(defaultPrefs(), { handoff: { blocks: [{ type: "link" }] } })).toEqual({ ok: false, error: "handoff.blocks[0].type must be move, unassign, assign, comment or field" });
    expect(applyPrefs(defaultPrefs(), { handoff: { blocks: [{ type: "assign", who: "person", person: { id: "acc-1", name: "Lin" } }] } }).ok).toBe(false);
  });
});
