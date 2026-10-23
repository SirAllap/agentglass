/*
 * What happened on a Jira card, for the pane's Activity: the change history on
 * demand and 100 entries at a time, the work log, and the comments the card
 * read did not carry.
 *
 * What a mistake costs: a card open that quietly pulls 24 KB of history it
 * never shows, a "changed Rank" row for every drag on a board, 45 minutes
 * written as "2700", a label list diffed wrong so a removed label reads as
 * added, or a history that stops at its first hundred without saying so.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-activity-"));
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

describe("one changed field, as a sentence", () => {
  const d = (field: string, fromString = "", toString = "", extra: Record<string, string> = {}) =>
    A.describeItem({ field, from: "", to: "", fromString, toString, ...extra });
  test("status, priority and assignee say from what to what, and who", () => {
    expect(d("status", "To Do", "In Progress")).toBe('changed the Status from "To Do" to "In Progress"');
    expect(d("priority", "Medium", "High")).toBe('changed the Priority from "Medium" to "High"');
    expect(d("assignee", "", "Grace Sample")).toBe("assigned this to Grace Sample");
    expect(d("assignee", "Grace Sample", "Ada Example")).toBe("reassigned this from Grace Sample to Ada Example");
    expect(d("assignee", "Ada Example", "")).toBe("took the assignee off");
  });
  test("labels are the whole list at both ends: what is new and what is gone are the sentence", () => {
    expect(d("labels", "sync", "sync bug")).toBe("added the label bug");
    expect(d("labels", "sync bug", "sync")).toBe("removed the label bug");
    expect(d("labels", "a b", "b c")).toBe("added the label c and removed the label a");
    expect(d("labels", "a", "a")).toBeNull();
  });
  test("dates, links, web links and files", () => {
    expect(d("duedate", "", "2026-10-20 00:00:00.0")).toBe("set the Due date to 2026-10-20");
    expect(d("duedate", "2026-10-20", "2026-10-22")).toBe("changed the Due date from 2026-10-20 to 2026-10-22");
    expect(d("Start date", "2026-10-05", "")).toBe("cleared the Start date");
    expect(d("Link", "", "This issue blocks ORBIT-1043")).toBe("linked this: This issue blocks ORBIT-1043");
    expect(d("Link", "This issue blocks ORBIT-1043", "")).toBe("removed a link: This issue blocks ORBIT-1043");
    expect(d("RemoteWorkItemLink", "", 'This issue links to "Design note"')).toBe('added a web link: This issue links to "Design note"');
    expect(d("Attachment", "", "trace.png")).toBe("attached trace.png");
    expect(d("Attachment", "trace.png", "")).toBe("removed the attachment trace.png");
  });
  test("a flag, and a clear of a date nobody had set", () => {
    expect(d("Flagged", "", "Impediment")).toBe("flagged this");
    expect(d("Flagged", "Impediment", "")).toBe("removed the flag");
    expect(d("Start date", "", "")).toBeNull();
    expect(d("duedate", "", "")).toBeNull();
  });
  test("estimates are seconds written as text and read as time", () => {
    expect(d("timeestimate", "28800", "3600")).toBe("changed the Remaining estimate from 8h to 1h");
    expect(d("timeoriginalestimate", "", "57600")).toBe("set the Original estimate to 16h");
    expect(d("timeestimate", "2700", "")).toBe("cleared the Remaining estimate");
    expect(A.humanSeconds("2700")).toBe("45m");
    expect(A.humanSeconds("5400")).toBe("1h 30m");
    expect(A.humanSeconds("soon")).toBe("soon");
  });
  test("what the site records for itself is no row, and a field nobody told us about is named and nothing more", () => {
    for (const f of ["WorklogId", "WorklogTimeSpent", "Comment", "Rank", "Sprint", "WorkRatio"]) expect(d(f, "1", "2")).toBeNull();
    expect(d("customfield_12345", "old secret", "new secret")).toBe("updated customfield_12345");
    expect(d("description", "a", "b")).toBe("updated the description");
    expect(d("summary", "Old", "New title")).toBe('renamed this to "New title"');
  });
  test("a very long value is cut, not passed on whole", () => {
    expect(d("Link", "", "x".repeat(2000))!.length).toBeLessThan(300);
  });
});

for (const flavor of ["cloud", "datacenter"] as FakeFlavor[]) {
  const dc = flavor === "datacenter";
  describe(`a card's activity, ${dc ? "Data Center" : "Cloud"}`, () => {
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
      await K.detailStored("ORBIT-1001");
      fake.requests.length = 0;
    });
    afterEach(() => { J.__setJiraBase(null); });
    const wire = () => fake.requests.map((r) => `${r.method} ${r.path}`);
    const history = (key: string, at = 0) => J.withStored((c) => A.historyPage(c, key, at));

    test("opening a card asks for no history, and carries the first work log from the same read", async () => {
      const r = await K.detailStored("ORBIT-1042");
      // The issue read, and on Cloud the comment list once for who answers whom (the comments inside an issue read carry no parentId).
      expect(wire().filter((w) => !w.endsWith("/comment"))).toEqual(["GET /issue/ORBIT-1042"]);
      const q = fake.requests[0]!.query;
      expect(q.fields!.split(",")).toContain("worklog");
      expect(q.fields).not.toContain("changelog");
      expect(q.expand).toBe("editmeta");
      expect(wire().join()).not.toContain("changelog");
      expect(r.data!.detail.events!.map((e) => [e.kind, e.who, e.text])).toEqual([
        ["worklog", "Grace Sample", "logged 45m: Reproduced the timeout with a large board"],
        ["worklog", "Ada Example", "logged 1h 30m"],
      ]);
      expect(r.data!.detail.worklogMore).toBeUndefined();
    });

    test("a card with a long work log says how many are not in the read, and the rest is one request", async () => {
      const d = (await K.detailStored("ORBIT-1050")).data!.detail;
      expect(d.events!.length).toBe(20);
      expect(d.worklogMore).toBe(5);
      fake.requests.length = 0;
      const rest = await J.withStored((c) => A.worklogPage(c, "ORBIT-1050", 20));
      expect(wire()).toEqual(["GET /issue/ORBIT-1050/worklog"]);
      expect(fake.requests[0]!.query).toMatchObject({ startAt: "20", maxResults: "100" });
      expect(rest.data!.events!.length).toBe(5);
      expect(rest.data!.next).toBeUndefined();
    });

    test("the history is one request when it is asked for, and its items read as sentences, oldest first", async () => {
      const r = await history("ORBIT-1042");
      expect(wire()).toEqual(dc ? ["GET /issue/ORBIT-1042"] : ["GET /issue/ORBIT-1042/changelog"]);
      const q = fake.requests[0]!.query;
      if (dc) expect(q).toMatchObject({ expand: "changelog", fields: "summary" });
      else expect(q).toMatchObject({ startAt: "0", maxResults: "100" });
      expect(r.data!.events!.map((e) => `${e.who}: ${e.text}`)).toEqual([
        'Grace Sample: changed the Status from "To Do" to "In Progress"',
        "Grace Sample: assigned this to Grace Sample",
        'Ada Example: changed the Priority from "Medium" to "High"',
        "Ada Example: added the label bug",
        "Ada Example: set the Due date to 2026-10-20",
        "Ada Example: set the Start date to 2026-10-05",
        "Grace Sample: linked this: This issue blocks ORBIT-1043",
        'Grace Sample: added a web link: This issue links to "#2196 Fix the timeout"',
        "Grace Sample: attached timeout-trace.png",
        "Grace Sample: changed the Remaining estimate from 8h to 1h",
        "Grace Sample: set the Original estimate to 16h",
        "Grace Sample: updated customfield_12345",
      ]);
      const ats = r.data!.events!.map((e) => e.at);
      expect(ats).toEqual([...ats].sort((a, b) => a - b));
      expect(r.data!.total).toBe(5);
      expect(r.data!.next).toBeUndefined();
    });

    test("a long history comes 100 at a time on Cloud, and its first 100 on Data Center, said by the total", async () => {
      const first = await history("ORBIT-1050");
      expect(first.data!.events!.length).toBe(100);
      expect(first.data!.total).toBe(230);
      if (dc) {
        expect(first.data!.next).toBeUndefined();
        return;
      }
      expect(first.data!.next).toBe(100);
      const second = await history("ORBIT-1050", 100);
      expect(second.data!.next).toBe(200);
      const third = await history("ORBIT-1050", 200);
      expect(third.data!.events!.length).toBe(30);
      expect(third.data!.next).toBeUndefined();
      expect(wire().map((w) => w.replace("/ORBIT-1050", ""))).toEqual(["GET /issue/changelog", "GET /issue/changelog", "GET /issue/changelog"]);
    });

    test("comments past the card read come in pages of 50, with where the next one starts", async () => {
      const base = fake.state.issues["ORBIT-1043"]!;
      for (let n = 0; n < 130; n++) base.comments.push({ id: String(70000 + n), author: "acc-0001", created: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(), updated: "", body: dc ? `note ${n}` : { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `note ${n}` }] }] } });
      fake.state.commentCap = 50;
      const d = await K.detailStored("ORBIT-1043");
      expect(d.data!.detail.comments.length).toBe(50);
      expect(d.data!.more).toBe(80);
      fake.requests.length = 0;
      const p1 = await J.withStored((c) => A.commentsPage(c, "ORBIT-1043", 50));
      expect(p1.data!.comments!.length).toBe(50);
      expect(p1.data!.comments![0]!.text).toBe("note 50");
      expect(p1.data!.next).toBe(100);
      const p2 = await J.withStored((c) => A.commentsPage(c, "ORBIT-1043", 100));
      expect(p2.data!.comments!.length).toBe(30);
      expect(p2.data!.next).toBeUndefined();
      expect(fake.requests.map((r) => r.query.startAt)).toEqual(["50", "100"]);
    });

    test("a card id that is not one is a sentence and nothing is sent", async () => {
      expect((await history("nope; DROP")).error).toBe("That is not a Jira card id");
      expect((await J.withStored((c) => A.worklogPage(c, "nope"))).error).toBe("That is not a Jira card id");
      expect((await J.withStored((c) => A.commentsPage(c, "nope", 0))).error).toBe("That is not a Jira card id");
      expect(fake.requests.length).toBe(0);
    });

    test("a site that cannot answer is an error, never an empty history", async () => {
      fake.fail({ path: dc ? "/issue/ORBIT-1042" : "/issue/ORBIT-1042/changelog", method: "GET", status: 500 });
      const r = await history("ORBIT-1042");
      expect(r.ok).toBe(false);
      expect(r.data).toBeUndefined();
    });
  });
}
