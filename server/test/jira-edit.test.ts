/*
 * Changing a card's Details and its comments through the client, against the
 * Cloud fake (REST v3) and its Data Center personality (REST v2). Each action
 * counts the requests it cost, and each refusal proves that nothing past the
 * refusal was sent: the fake is as forgiving as Jira (it takes a field the
 * edit screen does not list), so a refusal here is OUR guard and never the fake's.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-edit-"));
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
const E = await import("../src/jiraEdit.ts");
const D = await import("../src/jiraDoor.ts");
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

describe("planEdit: what a write may carry", () => {
  const ids = { start: "customfield_10015", flag: "customfield_10021" };
  const plan = (ask: Record<string, unknown>, v: 2 | 3 = 3, i: { start?: string; flag?: string } = ids) => E.planEdit({ field: ask.field, value: ask.value, add: ask.add, remove: ask.remove }, i, v);

  test("a title is trimmed, one line, never empty", () => {
    expect(plan({ field: "summary", value: "  Retry the export  " })).toMatchObject({ ok: true, body: { fields: { summary: "Retry the export" } } });
    expect(plan({ field: "summary", value: "   " })).toMatchObject({ ok: false });
    expect(plan({ field: "summary", value: "a\nb" })).toMatchObject({ ok: false });
    expect(plan({ field: "summary", value: "x".repeat(256) })).toMatchObject({ ok: false });
  });

  test("a priority goes by id and nothing else", () => {
    expect(plan({ field: "priority", value: "2" })).toMatchObject({ ok: true, body: { fields: { priority: { id: "2" } } } });
    expect(plan({ field: "priority", value: "High" })).toMatchObject({ ok: false });
    expect(plan({ field: "priority", value: null })).toMatchObject({ ok: false });
  });

  test("a label is an add or a remove operation, one of them", () => {
    expect(plan({ field: "labels", add: "ops" })).toMatchObject({ ok: true, body: { update: { labels: [{ add: "ops" }] } } });
    expect(plan({ field: "labels", remove: "ops" })).toMatchObject({ ok: true, body: { update: { labels: [{ remove: "ops" }] } } });
    expect(plan({ field: "labels", add: "a", remove: "b" })).toMatchObject({ ok: false });
    expect(plan({ field: "labels" })).toMatchObject({ ok: false });
    expect(plan({ field: "labels", add: "two words" })).toMatchObject({ ok: false });
    // Never the whole list: that would overwrite a label somebody else added a moment ago.
    expect(JSON.stringify(plan({ field: "labels", add: "ops" }))).not.toContain('"fields"');
  });

  test("a date takes a real day or null, and null is how it comes off", () => {
    expect(plan({ field: "duedate", value: "2026-02-28" })).toMatchObject({ ok: true, body: { fields: { duedate: "2026-02-28" } } });
    expect(plan({ field: "duedate", value: null })).toMatchObject({ ok: true, body: { fields: { duedate: null } } });
    expect(plan({ field: "duedate", value: "2026-02-30" })).toMatchObject({ ok: false });
    expect(plan({ field: "duedate", value: "" })).toMatchObject({ ok: false });
    expect(plan({ field: "start", value: "2026-02-01" })).toMatchObject({ ok: true, gate: "customfield_10015", body: { fields: { customfield_10015: "2026-02-01" } } });
    expect(plan({ field: "start", value: "2026-02-01" }, 3, {})).toMatchObject({ ok: false });
  });

  test("an estimate clears with the empty string: null is accepted by Jira and changes nothing", () => {
    expect(plan({ field: "originalEstimate", value: "" })).toMatchObject({ ok: true, gate: "timetracking", body: { fields: { timetracking: { originalEstimate: "" } } } });
    expect(plan({ field: "remainingEstimate", value: "2h 30m" })).toMatchObject({ ok: true, body: { fields: { timetracking: { remainingEstimate: "2h 30m" } } } });
    expect(plan({ field: "remainingEstimate", value: null })).toMatchObject({ ok: false });
    expect(plan({ field: "remainingEstimate", value: "soon" })).toMatchObject({ ok: false });
  });

  test("the flag is a boolean: on is the option, off is null", () => {
    expect(plan({ field: "flag", value: true })).toMatchObject({ ok: true, gate: "customfield_10021", body: { fields: { customfield_10021: [{ value: "Impediment" }] } } });
    expect(plan({ field: "flag", value: false })).toMatchObject({ ok: true, body: { fields: { customfield_10021: null } } });
    expect(plan({ field: "flag", value: "yes" })).toMatchObject({ ok: false });
  });

  test("a parent is a card id or null, and Data Center leaves it to Jira", () => {
    expect(plan({ field: "parent", value: "orbit-7" })).toMatchObject({ ok: true, body: { fields: { parent: { key: "ORBIT-7" } } } });
    expect(plan({ field: "parent", value: null })).toMatchObject({ ok: true, body: { fields: { parent: null } } });
    expect(plan({ field: "parent", value: "not a key" })).toMatchObject({ ok: false });
    expect(plan({ field: "parent", value: "ORBIT-7" }, 2)).toMatchObject({ ok: false });
  });

  test("anything else is refused by name", () => {
    expect(plan({ field: "components", value: "x" })).toMatchObject({ ok: false });
    expect(plan({ field: undefined })).toMatchObject({ ok: false });
  });

  test("isDay is a calendar, not a pattern", () => {
    expect(E.isDay("2024-02-29")).toBe(true);
    expect(E.isDay("2025-02-29")).toBe(false);
    expect(E.isDay("2025-13-01")).toBe(false);
    expect(E.isDay(20250101)).toBe(false);
  });

  test("editOf lists only what the edit screen offers, and nothing when it said nothing", () => {
    const list = { ids: ["1", "2"], names: ["High", "Low"] };
    expect(E.editOf(null, ids, list, 3)).toBeNull();
    const e = E.editOf(new Set(["summary", "priority", "customfield_10021", "timetracking", "parent"]), ids, list, 3)!;
    expect(e.fields).toEqual(["summary", "priority", "parent", "flag", "originalEstimate", "remainingEstimate"]);
    expect(e.priorities).toEqual([{ id: "1", name: "High" }, { id: "2", name: "Low" }]);
    expect(e.reply).toBe(true);
    // Not offered: no choices either, and Data Center has no thread nor a parent write.
    const dc = E.editOf(new Set(["summary", "parent"]), ids, list, 2)!;
    expect(dc.fields).toEqual(["summary"]);
    expect(dc.priorities).toEqual([]);
    expect(dc.reply).toBe(false);
    // Which priority it has now is the site's id, so a menu can mark the right row.
    expect(E.editOf(new Set(["priority"]), ids, list, 3, { priority: { id: "2", name: "Low" } })!.priority).toEqual({ id: "2", name: "Low" });
    expect(E.editOf(new Set(["priority"]), ids, list, 3, { priority: null })!.priority).toBeUndefined();
  });
});

describe("what a comment row says about itself", () => {
  const row = (extra: Record<string, unknown>) => R.commentRows([{ id: "7", author: { displayName: "Ada Example", accountId: "acc-0001" }, body: "x", created: "2026-01-14T09:00:00.000+0000", updated: "2026-01-14T09:00:00.000+0000", ...extra }], 2, "acc-0001").comments[0]!;
  test("parentId is read whether the site sends a number (a real one does) or text", () => {
    expect(row({ parentId: 123 }).parentId).toBe("123");
    expect(row({ parentId: "123" }).parentId).toBe("123");
    expect(row({}).parentId).toBeUndefined();
  });
  test("edited needs a second between created and updated, and restricted names the role", () => {
    expect(row({}).edited).toBeUndefined();
    expect(row({ updated: "2026-01-14T09:00:00.900+0000" }).edited).toBeUndefined();
    expect(row({ updated: "2026-01-14T09:00:01.000+0000" }).edited).toBe(true);
    expect(row({ visibility: { type: "role", value: "Developers" } }).restricted).toBe("Developers");
    expect(row({ visibility: { type: "group", identifier: "g-1" } }).restricted).toBe("g-1");
  });
});

describe("the door's edit body", () => {
  test("clear is the one way to take a value off, and it says which fields it applies to", () => {
    expect(D.editAsk({ field: "duedate", clear: true })).toMatchObject({ value: null });
    expect(D.editAsk({ field: "originalEstimate", clear: true })).toMatchObject({ value: "" });
    expect(D.editAsk({ field: "flag", clear: true })).toMatchObject({ value: false });
    expect(typeof D.editAsk({ field: "summary", clear: true })).toBe("string");
    expect(typeof D.editAsk({ field: "duedate", clear: true, value: "2026-01-01" })).toBe("string");
    expect(typeof D.editAsk({ field: "duedate", clear: "yes" })).toBe("string");
  });
  test("a flag may be said as text", () => {
    expect(D.editAsk({ field: "flag", value: "true" })).toMatchObject({ value: true });
    expect(typeof D.editAsk({ field: "flag", value: "maybe" })).toBe("string");
  });
});

function suite(flavor: FakeFlavor) {
  const dc = flavor === "datacenter";
  describe(`editing a card, ${dc ? "Data Center (v2)" : "Cloud (v3)"}`, () => {
    let fake: FakeJira;
    let stamp = 0;
    beforeAll(() => { fake = startFakeJira({ flavor }); });
    afterAll(async () => { await fake.stop(); });
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(credFile);
      C.__clearAll();
      E.__forgetOffered();
      J.__setJiraBase(fake.base);
      J.__setJiraGuard(null);
      process.env.AGENTGLASS_JIRA_WRITE = "1";
      const r = dc
        ? await J.connectJira({ site: "jira.acme.example", token: FAKE_PAT })
        : await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      fake.state.issues["ORBIT-1042"]!.editmeta = ["summary", "description", "labels", "priority", "duedate", "assignee", "reporter", "startDate", "flagged", "timetracking", ...(dc ? [] : ["parent"])];
      expect((await J.withStored((c) => J.siteFields(c))).ok).toBe(true);
      // The card is opened first, as the pane does: that read is what remembers which fields it lets a person change.
      const open = await K.detailStored("ORBIT-1042");
      expect(open.ok).toBe(true);
      stamp = open.data!.detail.task.updated;
      fake.requests.length = 0;
    });
    afterEach(() => { delete process.env.AGENTGLASS_JIRA_WRITE; J.__setJiraBase(null); });

    const writes = () => fake.requests.filter((r) => r.method !== "GET");

    test("a priority change costs the stamp read, the PUT and the card read back, and the answer is the card as it now is", async () => {
      const r = await E.editStored("ORBIT-1042", { field: "priority", value: "5" }, stamp);
      expect(r.ok).toBe(true);
      expect(r.task!.priority).not.toBe(null);
      expect(fake.state.issues["ORBIT-1042"]!.priorityId).toBe("5");
      // Three on both: Cloud's `returnIssue` answers with only the fields the PUT changed and no `updated`, so it is not the read-back.
      expect(fake.requests.map((q) => q.method)).toEqual(["GET", "PUT", "GET"]);
      expect(fake.requests[1]!.path).not.toContain("returnIssue");
      expect(fake.requests[1]!.query.returnIssue).toBeUndefined();
      // An option goes by its id: the name is never sent.
      expect(JSON.stringify(writes()[0]!.body)).toBe(JSON.stringify({ fields: { priority: { id: "5" } } }));
      expect(r.edit?.fields).toContain("priority");
      expect(r.facts).toBeDefined();
    });

    test("a field the edit screen does not list is refused and nothing at all is sent", async () => {
      fake.requests.length = 0;
      const r = await E.editStored("ORBIT-1042", { field: "parent", value: "ORBIT-1" }, stamp);
      expect(r.ok).toBe(false);
      if (!dc) { // Cloud lists it above; take it away and ask again
        fake.state.issues["ORBIT-1042"]!.editmeta = ["summary"];
        E.__forgetOffered();
        expect((await K.detailStored("ORBIT-1042")).ok).toBe(true);
        fake.requests.length = 0;
        const again = await E.editStored("ORBIT-1042", { field: "duedate", value: "2026-03-01" }, stamp);
        expect(again).toMatchObject({ ok: false });
        expect(fake.requests).toEqual([]);
      }
      expect(writes()).toEqual([]);
    });

    test("with nothing remembered the stamp read carries editmeta, and a field outside it is refused before the PUT", async () => {
      fake.state.issues["ORBIT-1042"]!.editmeta = ["summary"];
      E.__forgetOffered();
      const r = await E.editStored("ORBIT-1042", { field: "duedate", value: "2026-03-01" }, stamp);
      expect(r.ok).toBe(false);
      expect(fake.requests.map((q) => q.method)).toEqual(["GET"]);
      expect(fake.requests[0]!.query.expand).toBe("editmeta");
      expect(fake.state.issues["ORBIT-1042"]!.dueDate ?? null).toBe(null);
    });

    test("a stale stamp is a conflict and the PUT is never sent", async () => {
      const r = await E.editStored("ORBIT-1042", { field: "summary", value: "Retry the export" }, stamp - 5000);
      expect(r).toMatchObject({ ok: false, conflict: true });
      expect(writes()).toEqual([]);
      expect(fake.state.issues["ORBIT-1042"]!.summary).not.toBe("Retry the export");
    });

    test("with writing to Jira switched off nothing is sent", async () => {
      delete process.env.AGENTGLASS_JIRA_WRITE;
      const r = await E.editStored("ORBIT-1042", { field: "summary", value: "Retry the export" }, stamp);
      expect(r).toMatchObject({ ok: false });
      expect(fake.requests).toEqual([]);
      // And without the switch the card does not even say what could be changed.
      expect((await K.detailStored("ORBIT-1042")).data!.detail.edit).toBeUndefined();
    });

    test("labels go as add and remove operations, and a date and an estimate come off the way Jira clears them", async () => {
      let cur = stamp;
      const next = async (ask: Record<string, unknown>) => {
        const r = await E.editStored("ORBIT-1042", ask as never, cur);
        expect(r.ok).toBe(true);
        cur = r.task!.updated;
        return r;
      };
      await next({ field: "labels", add: "ops" });
      expect(fake.state.issues["ORBIT-1042"]!.labels).toContain("ops");
      await next({ field: "labels", remove: "ops" });
      expect(fake.state.issues["ORBIT-1042"]!.labels).not.toContain("ops");
      await next({ field: "duedate", value: "2026-03-01" });
      expect(fake.state.issues["ORBIT-1042"]!.dueDate).toBe("2026-03-01");
      const cleared = await next({ field: "duedate", value: null });
      expect(fake.state.issues["ORBIT-1042"]!.dueDate).toBe(null);
      expect(cleared.task!.due).toBe(null);
      await next({ field: "originalEstimate", value: "2h" });
      expect(fake.state.issues["ORBIT-1042"]!.timetracking?.originalEstimate).toBe("2h");
      await next({ field: "originalEstimate", value: "" });
      expect(fake.state.issues["ORBIT-1042"]!.timetracking?.originalEstimate).toBeUndefined();
      const labelPuts = writes().filter((q) => JSON.stringify(q.body).includes("labels")).map((q) => JSON.stringify(q.body));
      expect(labelPuts).toEqual([JSON.stringify({ update: { labels: [{ add: "ops" }] } }), JSON.stringify({ update: { labels: [{ remove: "ops" }] } })]);
    });

    test("the flag and the start date use the site's own field ids", async () => {
      const on = await E.editStored("ORBIT-1042", { field: "flag", value: true }, stamp);
      expect(on.ok).toBe(true);
      expect(fake.state.issues["ORBIT-1042"]!.flagged).toBe("Impediment");
      expect(on.facts!.find((f) => f.id === "flag")).toMatchObject({ tone: "flag", field: "flag", raw: "1" });
      const off = await E.editStored("ORBIT-1042", { field: "flag", value: false }, on.task!.updated);
      expect(off.ok).toBe(true);
      expect(fake.state.issues["ORBIT-1042"]!.flagged).toBe(null);
      const start = await E.editStored("ORBIT-1042", { field: "start", value: "2026-02-01" }, off.task!.updated);
      expect(start.ok).toBe(true);
      expect(start.facts!.find((f) => f.id === "start")).toMatchObject({ value: "2026-02-01", raw: "2026-02-01", field: "start" });
    });

    test("an answer from Jira's own words is never passed on", async () => {
      fake.fail({ path: "/issue/ORBIT-1042", method: "PUT", status: 400, times: 1 });
      const r = await E.editStored("ORBIT-1042", { field: "summary", value: "x" }, stamp);
      expect(r).toMatchObject({ ok: false, error: "Jira did not take that value" });
    });

    test("the card read says what may be changed, from editmeta and only while writing is on", async () => {
      const open = await K.detailStored("ORBIT-1042");
      const e = open.data!.detail.edit!;
      expect(e.fields).toContain("summary");
      expect(e.fields).toContain("flag");
      expect(e.fields).toContain("remainingEstimate");
      expect(e.fields.includes("parent")).toBe(!dc);
      expect(e.priorities.length).toBeGreaterThan(1);
      expect(e.priority?.id).toBe(String(fake.state.issues["ORBIT-1042"]!.priorityId));
      expect(e.reply).toBe(!dc);
      // Estimates are two rows of their own when the screen offers them.
      expect(open.data!.detail.facts!.map((f) => f.id)).toEqual(expect.arrayContaining(["originalEstimate", "remainingEstimate"]));
    });
  });

  describe(`comments, ${dc ? "Data Center (v2)" : "Cloud (v3)"}`, () => {
    let fake: FakeJira;
    beforeAll(() => { fake = startFakeJira({ flavor }); });
    afterAll(async () => { await fake.stop(); });
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(credFile);
      C.__clearAll();
      E.__forgetOffered();
      J.__setJiraBase(fake.base);
      J.__setJiraGuard(null);
      process.env.AGENTGLASS_JIRA_WRITE = "1";
      const r = dc
        ? await J.connectJira({ site: "jira.acme.example", token: FAKE_PAT })
        : await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      expect((await J.withStored((c) => J.readIssue(c, "ORBIT-1042"))).ok).toBe(true);
    });
    afterEach(() => { delete process.env.AGENTGLASS_JIRA_WRITE; J.__setJiraBase(null); });

    const mine = async (text: string) => {
      const r = await K.commentStored("ORBIT-1042", text, []);
      expect(r.ok).toBe(true);
      return r.detail!.comments.filter((c) => c.mine).at(-1)!;
    };

    test("your own comment is changed in two requests, and it reads as edited", async () => {
      const c = await mine("First words");
      expect(c.edited).toBeUndefined();
      fake.requests.length = 0;
      const r = await K.editCommentStored("ORBIT-1042", c.id, "Better words", []);
      expect(r.ok).toBe(true);
      expect(r.comment).toMatchObject({ id: c.id, text: "Better words", edited: true, mine: true });
      expect(fake.requests.map((q) => `${q.method} ${q.path.split("/").slice(-2).join("/")}`)).toEqual([`GET comment/${c.id}`, `PUT comment/${c.id}`]);
    });

    test("a changed comment keeps the people it names, because the row carries them back", async () => {
      const who = dc ? "ada" : "acc-0001";
      const first = await K.commentStored("ORBIT-1042", "hello @Ada Example", [{ id: who, name: "Ada Example" }]);
      const c = first.detail!.comments.filter((x) => x.mine).at(-1)!;
      expect(c.mentions).toEqual([{ id: who, name: "Ada Example" }]);
      const r = await K.editCommentStored("ORBIT-1042", c.id, "hello again @Ada Example", c.mentions);
      expect(r.ok).toBe(true);
      const stored = JSON.stringify(fake.state.issues["ORBIT-1042"]!.comments.find((x) => x.id === c.id)!.body);
      expect(stored).toContain(dc ? "[~ada]" : '"type":"mention"');
      // Sent back with no mentions it would be plain text: that is what the row's `mentions` are for.
      const flat = await K.editCommentStored("ORBIT-1042", c.id, "hello @Ada Example", []);
      expect(flat.ok).toBe(true);
      expect(JSON.stringify(fake.state.issues["ORBIT-1042"]!.comments.find((x) => x.id === c.id)!.body)).not.toContain(dc ? "[~ada]" : '"type":"mention"');
    });

    test("somebody else's comment is refused after the read and never written", async () => {
      const issue = fake.state.issues["ORBIT-1042"]!;
      issue.comments.push({ id: "29001", author: dc ? "grace" : "acc-0002", created: issue.updated, updated: issue.updated, body: dc ? "Their words" : { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Their words" }] }] } });
      fake.requests.length = 0;
      const e = await K.editCommentStored("ORBIT-1042", "29001", "Mine now", []);
      expect(e).toMatchObject({ ok: false });
      const d = await K.deleteCommentStored("ORBIT-1042", "29001");
      expect(d).toMatchObject({ ok: false });
      expect(fake.requests.filter((q) => q.method !== "GET")).toEqual([]);
      expect(issue.comments.some((c) => c.id === "29001")).toBe(true);
    });

    test("opening a card asks for its threads only on Cloud, and only when it has comments", async () => {
      fake.requests.length = 0;
      expect((await K.detailStored("ORBIT-1042")).ok).toBe(true);
      expect(fake.requests.filter((q) => q.path.endsWith("/comment")).length).toBe(dc ? 0 : 1);
      fake.state.issues["ORBIT-1043"]!.comments = [];
      fake.requests.length = 0;
      expect((await K.detailStored("ORBIT-1043")).ok).toBe(true);
      expect(fake.requests.filter((q) => q.path.endsWith("/comment")).length).toBe(0);
    });

    test("a delete is the read and the DELETE, and the comment is gone", async () => {
      const c = await mine("Words to remove");
      fake.requests.length = 0;
      const r = await K.deleteCommentStored("ORBIT-1042", c.id);
      expect(r).toMatchObject({ ok: true, removed: true });
      expect(fake.requests.map((q) => q.method)).toEqual(["GET", "DELETE"]);
      expect(fake.state.issues["ORBIT-1042"]!.comments.some((x) => x.id === c.id)).toBe(false);
    });

    test("an id that is not a comment id never reaches the site", async () => {
      fake.requests.length = 0;
      expect(await K.deleteCommentStored("ORBIT-1042", "../../issue/ORBIT-1")).toMatchObject({ ok: false });
      expect(await K.editCommentStored("ORBIT-1042", "12x", "words", [])).toMatchObject({ ok: false });
      expect(fake.requests).toEqual([]);
    });

    test("an empty edit is refused, and so is any change with writing switched off", async () => {
      const c = await mine("Words");
      fake.requests.length = 0;
      expect(await K.editCommentStored("ORBIT-1042", c.id, "   ", [])).toMatchObject({ ok: false });
      delete process.env.AGENTGLASS_JIRA_WRITE;
      expect(await K.editCommentStored("ORBIT-1042", c.id, "x", [])).toMatchObject({ ok: false });
      expect(await K.deleteCommentStored("ORBIT-1042", c.id)).toMatchObject({ ok: false });
      expect(fake.requests).toEqual([]);
    });

    test("the door's verbs go through the same functions: an edit, a reply, and a delete that needs its confirm", async () => {
      const open = await K.detailStored("ORBIT-1042");
      const stamp = open.data!.detail.task.updated;
      const c = await mine("Door comment");
      fake.requests.length = 0;
      const unsure = await D.runDoor("comment-delete", { key: "ORBIT-1042", id: c.id });
      expect(unsure.status).toBe(400);
      expect(fake.requests).toEqual([]);
      const said = await D.runDoor("comment-edit", { key: "ORBIT-1042", id: c.id, text: "Changed at the door" });
      expect(said.body).toMatchObject({ ok: true, state: { edited: true } });
      const gone = await D.runDoor("comment-delete", { key: "ORBIT-1042", id: c.id, confirm: true });
      expect(gone.body).toMatchObject({ ok: true, state: { removed: true } });
      const edited = await D.runDoor("edit", { key: "ORBIT-1042", field: "summary", value: "Door title", updated: (await K.detailStored("ORBIT-1042")).data!.detail.task.updated });
      expect(edited.status).toBe(200);
      expect((edited.body.untrusted as { title: string }).title).toBe("Door title");
      // A stamp that is not the card's is a 409, as on the screen, and the title stays.
      const stale = await D.runDoor("edit", { key: "ORBIT-1042", field: "summary", value: "Other", updated: stamp - 9000 });
      expect(stale.status).toBe(409);
      expect(fake.state.issues["ORBIT-1042"]!.summary).toBe("Door title");
      const reply = await D.runDoor("comment", { key: "ORBIT-1042", text: "a thread", reply_to: "99999" });
      expect(reply.status).toBe(400);
    });

    if (dc) {
      test("a reply is not offered on Data Center, and nothing is sent", async () => {
        const c = await mine("A comment");
        fake.requests.length = 0;
        const r = await K.commentStored("ORBIT-1042", "an answer", [], c.id);
        expect(r).toMatchObject({ ok: false });
        expect(fake.requests).toEqual([]);
      });
    } else {
      test("a reply carries parentId and costs the POST and the card read back; the thread comes with the next open", async () => {
        const c = await mine("A comment");
        fake.requests.length = 0;
        const r = await K.commentStored("ORBIT-1042", "an answer", [], c.id);
        expect(r.ok).toBe(true);
        const posts = fake.requests.filter((q) => q.method === "POST");
        expect(posts.length).toBe(1);
        expect((posts[0]!.body as { parentId?: string }).parentId).toBe(c.id);
        // The card read back does not ask who answers whom again: the pane keeps what it knew.
        expect(fake.requests.length).toBe(2);
        expect(r.detail!.comments.find((x) => x.text === "an answer")!.parentId).toBeUndefined();
        // Opening the card asks once more, because the comments inside an issue read carry no parentId (measured on a real site).
        fake.requests.length = 0;
        const open = await K.detailStored("ORBIT-1042");
        expect(fake.requests.map((q) => `${q.method} ${q.path.endsWith("/comment") ? "comment-list" : "issue"}`)).toEqual(["GET issue", "GET comment-list"]);
        expect(open.data!.detail.comments.find((x) => x.text === "an answer")!.parentId).toBe(c.id);
      });
      test("a reply to a comment that is not on the card is refused by the site and says so", async () => {
        const r = await K.commentStored("ORBIT-1042", "an answer", [], "99999");
        expect(r).toMatchObject({ ok: false });
        expect(r.error).toContain("reply");
      });
      test("a comment restricted to a role says so", async () => {
        const issue = fake.state.issues["ORBIT-1042"]!;
        issue.comments.push({ id: "29002", author: "acc-0002", created: issue.updated, updated: issue.updated, body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Staff only" }] }] }, visibility: { type: "role", value: "Developers" } });
        const open = await K.detailStored("ORBIT-1042");
        expect(open.data!.detail.comments.find((c) => c.id === "29002")).toMatchObject({ restricted: "Developers" });
      });
    }
  });
}
suite("cloud");
suite("datacenter");

describe("label suggestions", () => {
  let fake: FakeJira;
  beforeAll(() => { fake = startFakeJira(); });
  afterAll(async () => { await fake.stop(); });
  beforeEach(async () => {
    fake.reset();
    C.__setCredentialsPath(credFile);
    C.__clearAll();
    J.__setJiraBase(fake.base);
    J.__setJiraGuard(null);
    await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
  });
  afterEach(() => { J.__setJiraBase(null); });
  test("one read per typed query, and only the names a label may be", async () => {
    fake.state.issues["ORBIT-1042"]!.labels = ["backend", "billing", "ops"];
    fake.requests.length = 0;
    const r = await E.labelSuggestionsStored("b");
    expect(r.data).toEqual(expect.arrayContaining(["backend", "billing"]));
    expect(r.data!.every((l) => l.startsWith("b"))).toBe(true);
    await E.labelSuggestionsStored("b");
    expect(fake.requests.length).toBe(1);
  });
});
