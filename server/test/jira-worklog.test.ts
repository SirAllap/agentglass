/*
 * Time logged on a Jira card, through the client and the agent door, against the Cloud fake (REST v3, notes as ADF) and its
 * Data Center personality (REST v2, notes as wiki text). The pure decisions come first (a time, a day, the four ways the remaining
 * estimate follows), then each write: what it costs in requests, what it sends, and for every refusal the proof that nothing
 * past it was sent.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";
import { ADJUST_MODES, adjustEffect, adjustOf, adjustQuery, minutesOf, parseDuration, remainingNow, startedStamp, workSaid } from "../../shared/jiraWorklog.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-worklog-"));
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
const A = await import("../src/jiraActivity.ts");
const W = await import("../src/jiraWorklog.ts");
const D = await import("../src/jiraDoor.ts");
const credFile = join(dir, "creds.json");

afterAll(() => {
  C.__clearAll();
  C.__setCredentialsPath(null);
  J.__setJiraBase(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe("parseDuration: a time as Jira reads it", () => {
  test("hours, minutes, days and weeks are written once, largest first", () => {
    expect(parseDuration("1h 30m")).toEqual({ ok: true, text: "1h 30m", zero: false });
    expect(parseDuration("1h30m")).toMatchObject({ ok: true, text: "1h 30m" });
    expect(parseDuration("  90M ")).toMatchObject({ ok: true, text: "90m" });
    expect(parseDuration("30m 1h")).toMatchObject({ ok: true, text: "1h 30m" });
    expect(parseDuration("1w, 2d 3h 4m")).toMatchObject({ ok: true, text: "1w 2d 3h 4m" });
  });
  test("nothing, no unit, a decimal, a word, or a unit twice is a sentence and not a time", () => {
    for (const bad of ["", "   ", "90", "1.5h", "1h banana", "banana", "h", "-1h", "1h 2h", "1 hour", 90, null, undefined, {}]) {
      const r = parseDuration(bad);
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error.length).toBeGreaterThan(5);
    }
    expect((parseDuration("1h 2h") as { error: string }).error).toContain("twice");
  });
  test("zero is refused for time logged, and allowed where nothing left is an answer (a new estimate)", () => {
    expect(parseDuration("0m")).toEqual({ ok: false, error: "Time must be more than zero" });
    expect(parseDuration("0h 0m")).toMatchObject({ ok: false });
    expect(parseDuration("0m", { allowZero: true })).toEqual({ ok: true, text: "0m", zero: true });
    // Four digits a unit, as an estimate is: a wall of digits is not a time.
    expect(parseDuration("12345h").ok).toBe(false);
  });
});

describe("minutesOf: whether two times are one", () => {
  test("hours and minutes add up; days and weeks are the site's to say, so they are not guessed", () => {
    expect(minutesOf("90m")).toBe(90);
    expect(minutesOf("1h 30m")).toBe(90);
    expect(minutesOf("0m")).toBe(0);
    expect(minutesOf("1d")).toBeNull();
    expect(minutesOf("1w 1h")).toBeNull();
    expect(minutesOf("soon")).toBeNull();
  });
});

describe("startedStamp: the day the work was done", () => {
  const now = new Date(2026, 9, 11, 14, 5, 9);
  test("no day sends nothing, so Jira takes the moment of the request", () => {
    for (const none of [undefined, null, ""]) expect(startedStamp(none, now)).toEqual({ ok: true });
  });
  test("today keeps the clock, an earlier day is at nine, both in Jira's format with the zone's offset", () => {
    const re = /^2026-10-1[01]T\d\d:\d\d:\d\d\.000[+-]\d{4}$/;
    const today = startedStamp("2026-10-11", now) as { started: string };
    expect(today.started).toMatch(re);
    expect(today.started.slice(0, 19)).toBe("2026-10-11T14:05:09");
    const before = startedStamp("2026-10-10", now) as { started: string };
    expect(before.started).toMatch(re);
    expect(before.started.slice(0, 19)).toBe("2026-10-10T09:00:00");
    const off = -now.getTimezoneOffset();
    expect(today.started.slice(-5)).toBe(`${off < 0 ? "-" : "+"}${String(Math.floor(Math.abs(off) / 60)).padStart(2, "0")}${String(Math.abs(off) % 60).padStart(2, "0")}`);
  });
  test("a day that has not happened, or is not a day, is refused", () => {
    expect(startedStamp("2026-10-12", now)).toMatchObject({ ok: false });
    expect((startedStamp("2026-10-12", now) as { error: string }).error).toContain("has happened");
    for (const bad of ["2026-02-30", "2026-13-01", "yesterday", "2026-1-1", 20261011, "2026-10-11T10:00"]) expect(startedStamp(bad, now)).toEqual({ ok: false, error: "That is not a day" });
  });
});

describe("the four ways the remaining estimate follows", () => {
  test("each mode names the query Jira reads: new and manual carry a time, and a delete's manual is increaseBy", () => {
    expect(adjustQuery("add", { mode: "auto" })).toBe("adjustEstimate=auto");
    expect(adjustQuery("add", { mode: "leave" })).toBe("adjustEstimate=leave");
    expect(adjustQuery("add", { mode: "new", value: "2h 30m" })).toBe("adjustEstimate=new&newEstimate=2h+30m");
    expect(adjustQuery("add", { mode: "manual", value: "1h" })).toBe("adjustEstimate=manual&reduceBy=1h");
    expect(adjustQuery("delete", { mode: "manual", value: "1h" })).toBe("adjustEstimate=manual&increaseBy=1h");
    expect(adjustQuery("edit", { mode: "new", value: "0m" })).toBe("adjustEstimate=new&newEstimate=0m");
  });
  test("no mode is Jira's own default, auto", () => {
    expect(adjustOf(undefined, "add")).toEqual({ ok: true, adjust: { mode: "auto" } });
    expect(adjustOf(null, "delete")).toEqual({ ok: true, adjust: { mode: "auto" } });
  });
  test("an edit has no manual; a mode that is not one is refused; new and manual need a time, and only new may be nothing", () => {
    expect(ADJUST_MODES.edit).not.toContain("manual");
    expect(adjustOf({ mode: "manual", value: "1h" }, "edit")).toMatchObject({ ok: false });
    for (const bad of [{ mode: "everything" }, { mode: 7 }, "auto", [], {}]) expect(adjustOf(bad, "add")).toMatchObject({ ok: false });
    expect(adjustOf({ mode: "new" }, "add")).toMatchObject({ ok: false });
    expect(adjustOf({ mode: "new", value: "0m" }, "add")).toEqual({ ok: true, adjust: { mode: "new", value: "0m" } });
    expect(adjustOf({ mode: "manual", value: "0m" }, "add")).toMatchObject({ ok: false });
    expect(adjustOf({ mode: "manual", value: "1h30m" }, "delete")).toEqual({ ok: true, adjust: { mode: "manual", value: "1h 30m" } });
    // What leave and auto carry is dropped: a stray value must not reach the query.
    expect(adjustOf({ mode: "leave", value: "9h" }, "add")).toEqual({ ok: true, adjust: { mode: "leave" } });
  });
  test("the sentences say what the estimate will do before, and what it did after", () => {
    expect(adjustEffect("add", { mode: "auto" }, "1h 30m")).toBe("The remaining estimate goes down by 1h 30m");
    expect(adjustEffect("add", { mode: "leave" }, "1h")).toBe("The remaining estimate stays as it is");
    expect(adjustEffect("add", { mode: "new", value: "2h" }, "1h")).toBe("The remaining estimate is set to 2h");
    expect(adjustEffect("add", { mode: "manual", value: "30m" }, "1h")).toBe("The remaining estimate goes down by 30m");
    expect(adjustEffect("delete", { mode: "auto" }, "1h 30m")).toBe("The remaining estimate goes back up by 1h 30m");
    expect(adjustEffect("delete", { mode: "manual", value: "30m" }, "1h")).toBe("The remaining estimate goes up by 30m");
    expect(remainingNow("1d 4h", "1d 2h 30m")).toBe("The remaining estimate went from 1d 4h to 1d 2h 30m");
    expect(remainingNow("4h", "4h")).toBe("The remaining estimate is still 4h");
    expect(remainingNow("", "")).toBe("The remaining estimate is still none");
    expect(workSaid("add", "1h 30m", "1d 4h", "1d 2h 30m")).toBe("Logged 1h 30m. The remaining estimate went from 1d 4h to 1d 2h 30m.");
    expect(workSaid("delete", "1h 30m", "4h", "5h 30m")).toContain("Deleted the entry of 1h 30m.");
  });
});

function suite(flavor: FakeFlavor) {
  const dc = flavor === "datacenter";
  describe(`work log, ${dc ? "Data Center (v2)" : "Cloud (v3)"}`, () => {
    let fake: FakeJira;
    beforeAll(() => { fake = startFakeJira({ flavor }); });
    afterAll(async () => { await fake.stop(); });
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(credFile);
      C.__clearAll();
      J.__setJiraBase(fake.base);
      process.env.AGENTGLASS_JIRA_WRITE = "1";
      const r = dc
        ? await J.connectJira({ site: "jira.acme.example", token: FAKE_PAT })
        : await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      fake.requests.length = 0;
    });
    afterEach(() => { delete process.env.AGENTGLASS_JIRA_WRITE; J.__setJiraBase(null); });

    const KEY = "ORBIT-1042";
    const issue = (k = KEY) => fake.state.issues[k]!;
    const stamp = (k = KEY) => Date.parse(issue(k).updated.replace("+0000", "Z"));
    const writes = () => fake.requests.filter((r) => r.method !== "GET");
    const wire = () => fake.requests.map((r) => `${r.method} ${r.path.replace(/^.*\/rest\/api\/\d/, "")}`).filter((w) => !/^GET \/(field|priority|myself)/.test(w));
    /** The entries on the card as the fake holds them: mine is 40002, another person's 40001. */
    const mine = "40002", theirs = "40001";
    const left = () => issue().timetracking?.remainingEstimate;

    test("the card read says time tracking is on, and the entries say whose they are", async () => {
      const r = await K.detailStored(KEY);
      expect(r.data!.detail.tracking).toEqual({ remaining: "1d 4h", original: "2d", spent: "4h" });
      const rows = r.data!.detail.events!.filter((e) => e.kind === "worklog");
      expect(rows.map((e) => [e.entry!.id, e.entry!.mine])).toEqual([[theirs, false], [mine, true]]);
      expect(rows[0]!.entry).toMatchObject({ time: "45m", note: "Reproduced the timeout with a large board" });
    });

    test("a card the site does not track time on has no tracking, and a write is refused with no write", async () => {
      issue().noTimeTracking = true;
      const r = await K.detailStored(KEY);
      expect(r.data!.detail.tracking).toBeUndefined();
      fake.requests.length = 0;
      const out = await W.logWorkStored(KEY, { time: "1h" }, stamp());
      expect(out).toMatchObject({ ok: false });
      expect(out.error).toContain("Time tracking is off");
      expect(writes()).toEqual([]);
    });

    test("logging time: the stamp, the POST and the card read back, and the estimate drops by the time", async () => {
      const out = await W.logWorkStored(KEY, { time: "1h 30m", note: "Pairing on the export" }, stamp());
      expect(out).toMatchObject({ ok: true, before: "1d 4h", after: "1d 2h 30m" });
      expect(out.said).toBe("Logged 1h 30m. The remaining estimate went from 1d 4h to 1d 2h 30m.");
      expect(out.entry).toMatch(/^\d+$/);
      expect(out.detail!.tracking!.remaining).toBe("1d 2h 30m");
      expect(out.detail!.events!.some((e) => e.entry?.id === out.entry && e.entry?.mine && e.entry?.time === "1h 30m")).toBe(true);
      const post = writes();
      expect(post).toHaveLength(1);
      expect(post[0]!.method).toBe("POST");
      expect(post[0]!.query).toEqual({ adjustEstimate: "auto" });
      expect(post[0]!.body).toMatchObject({ timeSpent: "1h 30m" });
      expect((post[0]!.body as { started?: unknown }).started).toBeUndefined();
      // The note travels in the site's own format.
      const note = (post[0]!.body as { comment: unknown }).comment;
      if (dc) expect(note).toBe("Pairing on the export");
      else expect(note).toMatchObject({ type: "doc", version: 1 });
      // Three requests in all: the stamp and estimate, the POST, the card again.
      const card = fake.requests.filter((r) => r.path === "/issue/ORBIT-1042");
      expect(card.map((r) => r.method)).toEqual(["GET", "GET"]);
      expect(card[0]!.query.fields).toBe("updated,timetracking");
    });

    test("the day it was done is sent in Jira's format, and a time with no note sends no comment", async () => {
      const out = await W.logWorkStored(KEY, { time: "45m", started: "2026-10-09" }, stamp());
      expect(out.ok).toBe(true);
      const body = writes()[0]!.body as { started: string; comment?: unknown };
      expect(body.started).toMatch(/^2026-10-09T09:00:00\.000[+-]\d{4}$/);
      expect(body.comment).toBeUndefined();
      expect(issue().worklogs!.at(-1)!.started).toBe(body.started);
    });

    test("each of the four modes reaches the site as its own query, and the estimate follows", async () => {
      // 1d 4h is 12h. auto: 12h - 1h; leave: 12h; new: as typed; manual: 12h - 30m.
      const cases: [Parameters<typeof W.logWorkStored>[1], Record<string, string>, string][] = [
        [{ time: "1h", adjust: { mode: "auto" } }, { adjustEstimate: "auto" }, "1d 3h"],
        [{ time: "1h", adjust: { mode: "leave" } }, { adjustEstimate: "leave" }, "1d 4h"],
        [{ time: "1h", adjust: { mode: "new", value: "2h 30m" } }, { adjustEstimate: "new", newEstimate: "2h 30m" }, "2h 30m"],
        [{ time: "1h", adjust: { mode: "manual", value: "30m" } }, { adjustEstimate: "manual", reduceBy: "30m" }, "1d 3h 30m"],
        [{ time: "1h", adjust: { mode: "new", value: "0m" } }, { adjustEstimate: "new", newEstimate: "0m" }, "0m"],
      ];
      for (const [ask, query, after] of cases) {
        fake.reset();
        J.__setJiraBase(fake.base);
        fake.requests.length = 0;
        const out = await W.logWorkStored(KEY, ask, stamp());
        expect(out.ok).toBe(true);
        expect(writes()[0]!.query).toEqual(query);
        expect(left()).toBe(after);
        expect(out.after).toBe(after);
      }
    });

    test("every refusal before the site is asked sends nothing at all", async () => {
      const cases: [string, Parameters<typeof W.logWorkStored>[1], number, RegExp][] = [
        ["no time", {}, stamp(), /Say how much time/],
        ["time of nothing", { time: "0m" }, stamp(), /more than zero/],
        ["not a time", { time: "a while" }, stamp(), /written like 1h 30m/],
        ["a day to come", { time: "1h", started: "2999-01-01" }, stamp(), /has happened/],
        ["a day that is not one", { time: "1h", started: "2026-02-30" }, stamp(), /not a day/],
        ["an edit's way on an add", { time: "1h", adjust: { mode: "everything" } }, stamp(), /can be changed by/],
        ["new with no time", { time: "1h", adjust: { mode: "new" } }, stamp(), /new remaining estimate/],
        ["a note too long", { time: "1h", note: "x".repeat(30_001) }, stamp(), /too long/],
        ["a stamp that is zero", { time: "1h" }, 0, /reload the card/],
        ["a stamp that is not a number", { time: "1h" }, Number.NaN, /reload the card/],
        ["a stamp below zero", { time: "1h" }, -5, /reload the card/],
      ];
      for (const [name, ask, at, say] of cases) {
        fake.requests.length = 0;
        const out = await W.logWorkStored(KEY, ask, at);
        expect([name, out.ok]).toEqual([name, false]);
        expect([name, out.error]).toEqual([name, expect.stringMatching(say)]);
        expect([name, fake.requests]).toEqual([name, []]);
      }
      expect((await W.logWorkStored("not a key", { time: "1h" }, stamp())).error).toBe("That is not a Jira card id");
    });

    test("with the write switch off nothing is sent, whatever else is right", async () => {
      delete process.env.AGENTGLASS_JIRA_WRITE;
      const out = await W.logWorkStored(KEY, { time: "1h" }, stamp());
      expect(out).toEqual({ ok: false, error: "Writing to Jira is switched off" });
      expect(fake.requests).toEqual([]);
    });

    test("a card that moved since it was read is a conflict, and only the stamp was read", async () => {
      const out = await W.logWorkStored(KEY, { time: "1h" }, stamp() - 5000);
      expect(out).toMatchObject({ ok: false, conflict: true });
      expect(writes()).toEqual([]);
      expect(left()).toBe("1d 4h");
    });

    test("a refusal by the site is our sentence, never its own words", async () => {
      fake.fail({ method: "POST", path: `/issue/${KEY}/worklog`, status: 403, times: 1 });
      const out = await W.logWorkStored(KEY, { time: "1h" }, stamp());
      expect(out).toMatchObject({ ok: false, error: `Your Jira account cannot log time on ${KEY}` });
      fake.requests.length = 0;
      fake.fail({ method: "POST", path: `/issue/${KEY}/worklog`, status: 400, times: 1 });
      expect((await W.logWorkStored(KEY, { time: "1h" }, stamp())).error).toBe("Jira did not accept that time");
    });

    test("a server error says the time may have been logged, and nothing is sent again", async () => {
      fake.fail({ method: "POST", path: `/issue/${KEY}/worklog`, status: 500, times: 1 });
      const out = await W.logWorkStored(KEY, { time: "1h" }, stamp());
      expect(out.ok).toBe(false);
      expect(out.error).toContain("may have been logged");
      expect(writes().filter((w) => w.method === "POST")).toHaveLength(1);
    });

    test("changing your own entry: the entry is read first, the PUT carries only what changed, the estimate follows by the difference", async () => {
      // 1h 30m becomes 2h: the estimate drops by the extra 30m.
      const out = await W.editWorkStored(KEY, mine, { time: "2h" }, stamp());
      expect(out).toMatchObject({ ok: true, entry: mine, before: "1d 4h", after: "1d 3h 30m" });
      expect(out.said).toBe("Changed the entry to 2h. The remaining estimate went from 1d 4h to 1d 3h 30m.");
      expect(wire().filter((w) => w.startsWith(`GET /issue/${KEY}/worklog/${mine}`))).toHaveLength(1);
      expect(writes()).toHaveLength(1);
      expect(writes()[0]).toMatchObject({ method: "PUT", query: { adjustEstimate: "auto" }, body: { timeSpent: "2h" } });
      expect(Object.keys(writes()[0]!.body as object)).toEqual(["timeSpent"]);
      expect(issue().worklogs!.find((w) => w.id === mine)!.timeSpentSeconds).toBe(7200);
    });

    test("an entry's note and day change too, and an edit with nothing to change is refused", async () => {
      expect((await W.editWorkStored(KEY, mine, { note: "Rewrote the retry" }, stamp())).ok).toBe(true);
      expect(issue().worklogs!.find((w) => w.id === mine)!.comment).toBe("Rewrote the retry");
      expect((await W.editWorkStored(KEY, mine, { started: "2026-10-08", adjust: { mode: "leave" } }, stamp())).ok).toBe(true);
      expect(issue().worklogs!.find((w) => w.id === mine)!.started).toMatch(/^2026-10-08T09:00:00/);
      fake.requests.length = 0;
      expect((await W.editWorkStored(KEY, mine, {}, stamp())).error).toContain("Nothing to change");
      expect(fake.requests).toEqual([]);
    });

    test("an entry that is somebody else's is refused after the read, and nothing is written", async () => {
      const out = await W.editWorkStored(KEY, theirs, { time: "2h" }, stamp());
      expect(out).toMatchObject({ ok: false, error: "That entry is somebody else's: only your own can be changed here" });
      expect(wire().some((w) => w.startsWith(`GET /issue/${KEY}/worklog/${theirs}`))).toBe(true);
      expect(writes()).toEqual([]);
      const del = await W.deleteWorkStored(KEY, theirs, {}, stamp());
      expect(del.error).toContain("somebody else's");
      expect(writes()).toEqual([]);
      expect(issue().worklogs!.some((w) => w.id === theirs)).toBe(true);
    });

    test("an entry that is not there, or an id that is not one, sends nothing", async () => {
      expect((await W.editWorkStored(KEY, "99999", { time: "2h" }, stamp())).error).toBe("That entry is gone: reload the card");
      for (const id of ["", "abc", "1/../2", "40002?x=1"]) {
        fake.requests.length = 0;
        expect((await W.deleteWorkStored(KEY, id, {}, stamp())).error).toBe("That is not an entry this card has");
        expect(fake.requests).toEqual([]);
      }
      expect(writes()).toEqual([]);
    });

    test("an edit offers no manual mode and sends nothing for it", async () => {
      fake.requests.length = 0;
      const out = await W.editWorkStored(KEY, mine, { time: "2h", adjust: { mode: "manual", value: "1h" } }, stamp());
      expect(out.ok).toBe(false);
      expect(fake.requests).toEqual([]);
    });

    test("deleting your own entry: the time goes back on the estimate unless the person says otherwise", async () => {
      const out = await W.deleteWorkStored(KEY, mine, {}, stamp());
      expect(out).toMatchObject({ ok: true, removed: true, before: "1d 4h", after: "1d 5h 30m" });
      expect(out.said).toBe("Deleted the entry of 1h 30m. The remaining estimate went from 1d 4h to 1d 5h 30m.");
      expect(writes()).toHaveLength(1);
      expect(writes()[0]).toMatchObject({ method: "DELETE", query: { adjustEstimate: "auto" } });
      expect(issue().worklogs!.some((w) => w.id === mine)).toBe(false);
      expect(out.detail!.events!.some((e) => e.entry?.id === mine)).toBe(false);
    });

    test("a delete by manual puts back the time named, by increaseBy", async () => {
      const out = await W.deleteWorkStored(KEY, mine, { adjust: { mode: "manual", value: "15m" } }, stamp());
      expect(out.ok).toBe(true);
      expect(writes()[0]!.query).toEqual({ adjustEstimate: "manual", increaseBy: "15m" });
      expect(left()).toBe("1d 4h 15m");
    });

    test("an added entry is put back by deleting it with the estimate set to what it was: the Undo", async () => {
      const added = await W.logWorkStored(KEY, { time: "3h" }, stamp());
      expect(added.after).toBe("1d 1h");
      const undone = await W.deleteWorkStored(KEY, added.entry!, { adjust: { mode: "new", value: added.before } }, stamp());
      expect(undone).toMatchObject({ ok: true, before: "1d 1h", after: "1d 4h" });
      expect(left()).toBe("1d 4h");
      expect(issue().worklogs!.some((w) => w.id === added.entry)).toBe(false);
    });

    test("an entry past the first page is read with whose it is", async () => {
      const creds = await credsOf();
      const page = await A.worklogPage(creds, "ORBIT-1050", 20, (await J.taskContext(creds)).me);
      expect(page.data!.events!.length).toBeGreaterThan(0);
      expect(page.data!.events!.some((e) => e.entry?.mine === true)).toBe(true);
      expect(page.data!.events!.every((e) => /^\d+$/.test(e.entry?.id ?? ""))).toBe(true);
    });

    async function credsOf() { const c = J.storedCreds(); if (!c) throw new Error("not connected"); return c; }

    describe("the agent door", () => {
      test("the three verbs are acting verbs, so the level and the switch are asked first", () => {
        for (const v of ["worklog", "worklog-edit", "worklog-delete"]) { expect(D.isActing(v)).toBe(true); expect(D.DOOR_VERBS as readonly string[]).toContain(v); }
      });

      test("worklog takes the mode as a word and its time as `estimate`, and answers with the estimate either side", async () => {
        const r = await D.runDoor("worklog", { key: KEY, time: "1h", adjust: "new", estimate: "6h", updated: stamp(), note: "Door entry" });
        expect(r.body).toMatchObject({ ok: true, state: { logged: true, remainingBefore: "1d 4h", remainingAfter: "6h" } });
        expect((r.body.state as { entry: string }).entry).toMatch(/^\d+$/);
        expect(writes()[0]!.query).toEqual({ adjustEstimate: "new", newEstimate: "6h" });
        // The note is somebody's words and is never echoed as state.
        expect(JSON.stringify(r.body.state)).not.toContain("Door entry");
      });

      test("worklog refuses what the screen refuses, with the same sentence, and a bad mode type sends nothing", async () => {
        fake.requests.length = 0;
        expect((await D.runDoor("worklog", { key: KEY, time: "0m", updated: stamp() })).body.error).toBe("Time must be more than zero");
        expect((await D.runDoor("worklog", { key: KEY, time: "1h", adjust: 5, updated: stamp() })).status).toBe(400);
        expect((await D.runDoor("worklog", { key: KEY, time: "1h", adjust: "auto", estimate: 5, updated: stamp() })).status).toBe(400);
        expect((await D.runDoor("worklog", { key: KEY, time: "1h" })).body.error).toContain("reload the card");
        expect((await D.runDoor("worklog", { key: KEY, time: "1h", updated: stamp() - 9000 })).status).toBe(409);
        expect(writes()).toEqual([]);
      });

      test("worklog-edit and worklog-delete work on your own entry only, and a delete needs confirm", async () => {
        const e = await D.runDoor("worklog-edit", { key: KEY, id: mine, time: "1h", updated: stamp() });
        expect(e.body).toMatchObject({ ok: true, state: { edited: true } });
        expect((await D.runDoor("worklog-edit", { key: KEY, id: theirs, time: "1h", updated: stamp() })).status).toBe(400);
        fake.requests.length = 0;
        const bare = await D.runDoor("worklog-delete", { key: KEY, id: mine, updated: stamp() });
        expect(bare.status).toBe(400);
        expect(bare.body.error).toContain("cannot be undone");
        expect(fake.requests).toEqual([]);
        const gone = await D.runDoor("worklog-delete", { key: KEY, id: mine, updated: stamp(), confirm: true });
        expect(gone.body).toMatchObject({ ok: true, state: { removed: true } });
        expect(issue().worklogs!.some((w) => w.id === mine)).toBe(false);
      });

      test("an estimate that is not shaped like a time never reaches state", async () => {
        issue().timetracking!.remainingEstimate = "<script>alert(1)</script>";
        const r = await D.runDoor("worklog", { key: KEY, time: "1h", adjust: "leave", updated: stamp() });
        expect(r.body.ok).toBe(true);
        expect((r.body.state as Record<string, unknown>).remainingBefore).toBeUndefined();
      });
    });
  });
}

suite("cloud");
suite("datacenter");
