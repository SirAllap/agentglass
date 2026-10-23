/*
 * A Jira card's words through the client: the card with its description and
 * comments in one read, a comment written in the site's own format, and the
 * people a comment may mention. Every case runs on the Cloud fake (REST v3,
 * ADF, account ids) and on its Data Center personality (REST v2, wiki markup,
 * logins), and counts the requests the action cost.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-comments-"));
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

function suite(flavor: FakeFlavor) {
  const dc = flavor === "datacenter";
  // Who a mention names: an account id on Cloud, a login on Data Center.
  const ADA = dc ? "ada" : "acc-0001";
  const GRACE = dc ? "grace" : "acc-0002";

  describe(`a card's words, ${dc ? "Data Center (v2, wiki markup)" : "Cloud (v3, ADF)"}`, () => {
    let fake: FakeJira;
    beforeAll(() => { fake = startFakeJira({ flavor, assignableScanCap: 10 }); });
    afterAll(async () => { await fake.stop(); });
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(credFile);
      C.__clearAll();
      J.__setJiraBase(fake.base);
      J.__setJiraGuard(null);
      process.env.AGENTGLASS_JIRA_WRITE = "1";
      const r = dc
        ? await J.connectJira({ site: "jira.acme.example", token: FAKE_PAT })
        : await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      // The priority list is remembered after the first card read, and the site's field ids after the first board read, as in a real session.
      expect((await J.withStored((c) => J.readIssue(c, "ORBIT-1042"))).ok).toBe(true);
      expect((await J.withStored((c) => J.siteFields(c))).ok).toBe(true);
      fake.requests.length = 0;
    });
    afterEach(() => {
      delete process.env.AGENTGLASS_JIRA_WRITE;
      J.__setJiraBase(null);
    });

    const wire = () => fake.requests.map((r) => `${r.method} ${r.path}`);
    const posted = () => fake.requests.filter((r) => r.method === "POST").map((r) => (r.body as { body: unknown }).body);

    describe("reading", () => {
      test("the card, its description and its comments come from one request, as Markdown", async () => {
        const r = await K.detailStored("ORBIT-1050");
        expect(r.ok).toBe(true);
        expect(wire()).toEqual(["GET /issue/ORBIT-1050"]);
        expect(fake.requests[0]!.query.fields!.split(",")).toEqual(expect.arrayContaining(["summary", "status", "updated", "description", "comment"]));
        const d = r.data!.detail;
        expect(d.task.customId).toBe("ORBIT-1050");
        expect(d.description).toContain("**200 cards**");
        expect(d.description).toContain("[runbook](https://docs.acme.example/runbook)");
        expect(d.description).toContain("- Reproduce with the large board");
        expect(d.description).toContain("```ts\nawait exportBoard(board, { limit: 200 });\n```");
        // Cloud names the person in the document; Data Center only by login.
        expect(d.description).toContain(dc ? "ask @grace." : "ask @Grace Sample.");
        expect(r.data!.more).toBe(0);
      });

      test("a comment is shown by its author, as Markdown, with the mention named", async () => {
        const r = await K.detailStored("ORBIT-1042");
        const [c, ...rest] = r.data!.detail.comments;
        expect(rest).toEqual([]);
        expect(c).toMatchObject({ id: "30001", who: "Grace Sample", initials: "GS", text: "@Ada Example can you take a look at the retry loop?" });
        expect(c!.at).toBe(Date.parse("2026-01-13T08:00:00.000+0000"));
        // Written by somebody else, so not the connected account's.
        expect(c!.mine).toBeUndefined();
        expect(c!.avatar).toMatch(/^https:\/\//);
      });

      test("an empty description is empty, not 'null'", async () => {
        const r = await K.detailStored("ORBIT-1001");
        expect(r.data!.detail.description).toBe("");
        expect(r.data!.detail.comments).toEqual([]);
      });

      test("a card with more comments than the read carried says how many were left out", async () => {
        const issue = { key: "ORBIT-1042", fields: { comment: { total: 7, comments: [] } } };
        const t = (await J.withStored((c) => J.readIssue(c, "ORBIT-1042"))).data!;
        expect(K.toDetail(issue, t, dc ? 2 : 3).more).toBe(7);
      });

      test("a card that is not there, or cannot be read, is a sentence", async () => {
        expect((await K.detailStored("ORBIT-9999")).error).toBe("ORBIT-9999 was not found or you cannot see it");
        expect((await K.detailStored("not a key")).error).toBe("That is not a Jira card id");
        fake.fail({ path: "/issue/ORBIT-1042", method: "GET", status: 500 });
        expect((await K.detailStored("ORBIT-1042")).error).toBe("Could not reach Jira");
      });
    });

    describe("writing", () => {
      test(`a Markdown comment reaches the site as ${dc ? "wiki markup" : "an ADF document"}, and the card is read back: two requests`, async () => {
        const before = Date.parse(fake.state.issues["ORBIT-1042"]!.updated);
        const r = await K.commentStored("ORBIT-1042", "Looked at it: **retry** is `3`\n\n- one\n- two", []);
        expect(r.ok).toBe(true);
        expect(wire()).toEqual(["POST /issue/ORBIT-1042/comment", "GET /issue/ORBIT-1042"]);
        const body = posted()[0];
        if (dc) expect(body).toBe("Looked at it: *retry* is {{3}}\n\n* one\n* two");
        else {
          expect(body).toMatchObject({ type: "doc", version: 1 });
          expect((body as { content: unknown[] }).content).toEqual([
            { type: "paragraph", content: [{ type: "text", text: "Looked at it: " }, { type: "text", text: "retry", marks: [{ type: "strong" }] }, { type: "text", text: " is " }, { type: "text", text: "3", marks: [{ type: "code" }] }] },
            { type: "bulletList", content: ["one", "two"].map((t) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] })) },
          ]);
        }
        // The site took it, and the answer is the card as it now is.
        expect(fake.state.issues["ORBIT-1042"]!.comments.length).toBe(2);
        const last = r.detail!.comments.at(-1)!;
        expect(last.text).toBe("Looked at it: **retry** is `3`\n\n- one\n- two");
        expect(last.mine).toBe(true);
        expect(r.task!.updated).toBeGreaterThan(before);
        expect(r.task!.updated).toBe(Date.parse(fake.state.issues["ORBIT-1042"]!.updated));
      });

      test("a mention keeps the person's id on the wire", async () => {
        const r = await K.commentStored("ORBIT-1042", "@Grace Sample please check", [{ id: GRACE, name: "Grace Sample" }]);
        expect(r.ok).toBe(true);
        const body = posted()[0];
        if (dc) expect(body).toBe("[~grace] please check");
        else expect((body as { content: { content: unknown[] }[] }).content[0]!.content[0]).toEqual({ type: "mention", attrs: { id: "acc-0002", text: "@Grace Sample" } });
        // Read back by the name the person is shown by (Data Center: from the comment's author).
        expect(r.detail!.comments.at(-1)!.text).toBe("@Grace Sample please check");
      });

      test("a mention with an id that is not one is dropped and stays text", async () => {
        await K.commentStored("ORBIT-1042", "@Lin hi", [{ id: "lin tester]", name: "Lin" }, { id: ADA, name: "" }, "junk", null]);
        expect(posted()[0]).toEqual(dc ? "@Lin hi" : { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "@Lin hi" }] }] });
      });

      test("with writes switched off, nothing is sent", async () => {
        delete process.env.AGENTGLASS_JIRA_WRITE;
        const r = await K.commentStored("ORBIT-1042", "hello", []);
        expect(r).toEqual({ ok: false, error: "Writing to Jira is switched off" });
        expect(fake.requests).toEqual([]);
      });

      test("an empty, overlong or misaddressed comment is refused with no request", async () => {
        expect((await K.commentStored("ORBIT-1042", "  \n ", [])).error).toBe("Write something first");
        expect((await K.commentStored("ORBIT-1042", "x".repeat(30_001), [])).error).toBe("That comment is too long for Jira");
        expect((await K.commentStored("ORBIT 1042", "hi", [])).error).toBe("That is not a Jira card id");
        expect(fake.requests).toEqual([]);
      });

      test("a refusal is our sentence, never the site's words, and nothing is retried", async () => {
        fake.state.deny.comment.push("ORBIT-1042");
        expect((await K.commentStored("ORBIT-1042", "hi", [])).error).toBe("Your Jira account cannot comment on ORBIT-1042");
        fake.reset(); fake.requests.length = 0;
        fake.fail({ path: "/issue/ORBIT-1042/comment", method: "POST", status: 400, times: 1 });
        expect((await K.commentStored("ORBIT-1042", "hi", [])).error).toBe("Jira did not accept that comment");
        fake.requests.length = 0;
        fake.fail({ path: "/issue/ORBIT-1042/comment", method: "POST", status: 429, retryAfter: 1 });
        const r = await K.commentStored("ORBIT-1042", "hi", []);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/try again in 1s/);
        // One POST: a second one would be a second comment.
        expect(wire()).toEqual(["POST /issue/ORBIT-1042/comment"]);
      });

      test("a comment that landed but could not be read back says so, and is not a failure", async () => {
        fake.fail({ path: "/issue/ORBIT-1042", method: "GET", status: 500 });
        const r = await K.commentStored("ORBIT-1042", "hi", []);
        expect(r.ok).toBe(true);
        expect(r.partial).toBe("The comment was posted, but the card could not be read back. Reload it.");
        expect(fake.state.issues["ORBIT-1042"]!.comments.length).toBe(2);
      });

      test("a write with no answer may have landed, and says so rather than inviting a second one", async () => {
        fake.fail({ path: "/issue/ORBIT-1042/comment", method: "POST", status: 500 });
        const r = await K.commentStored("ORBIT-1042", "hi", []);
        expect(r.ok).toBe(false);
        expect(r.error).toBe("Could not reach Jira. The comment may have been posted: reload the card before sending it again");
        expect(wire()).toEqual(["POST /issue/ORBIT-1042/comment"]);
      });

      test("a revoked token is the reconnect sentence", async () => {
        fake.fail({ path: "/issue/ORBIT-1042/comment", method: "POST", status: 401 });
        const r = await K.commentStored("ORBIT-1042", "hi", []);
        expect(r.unauthorised).toBe(true);
      });
    });

    describe("who can be mentioned", () => {
      test(`asked by what was typed (${dc ? "username" : "query"}), on this card`, async () => {
        const r = await K.mentionableStored("ORBIT-1042", "a");
        expect(r.ok).toBe(true);
        expect(wire()).toEqual(["GET /user/assignable/search"]);
        const q = fake.requests[0]!.query;
        expect(q.issueKey).toBe("ORBIT-1042");
        expect(q[dc ? "username" : "query"]).toBe("a");
        expect(q[dc ? "query" : "username"]).toBeUndefined();
        const names = r.data!.map((p) => p.name);
        expect(names).toContain("Ada Example");
        expect(r.data!.find((p) => p.name === "Ada Example")).toMatchObject({ key: ADA, initials: "AE" });
      });

      test("the same query is asked once; another one is asked again", async () => {
        await K.mentionableStored("ORBIT-1042", "gr");
        await K.mentionableStored("ORBIT-1042", "GR");
        expect(fake.requests.length).toBe(1);
        await K.mentionableStored("ORBIT-1042", "lin");
        expect(fake.requests.length).toBe(2);
      });

      test("a person the search returns can be mentioned by the id it returned", async () => {
        const p = (await K.mentionableStored("ORBIT-1042", "lin")).data!.find((x) => x.name === "Lin Tester")!;
        fake.requests.length = 0;
        await K.commentStored("ORBIT-1042", "@Lin Tester over to you", [{ id: p.key, name: p.name }]);
        const body = posted()[0];
        if (dc) expect(body).toBe("[~lin] over to you");
        else expect(JSON.stringify(body)).toContain(`"id":"acc-0003"`);
      });

      test("a failed search is a sentence, not an empty list", async () => {
        fake.fail({ path: "/user/assignable/search", status: 500 });
        const r = await K.mentionableStored("ORBIT-1042", "zz");
        expect(r.ok).toBe(false);
        expect(r.error).toBe("Could not reach Jira");
      });
    });
  });
}

suite("cloud");
suite("datacenter");

describe("not connected", () => {
  test("every call says so and asks nothing", async () => {
    C.__setCredentialsPath(credFile);
    C.__clearAll();
    expect((await K.detailStored("ORBIT-1042")).error).toBe("Jira is not connected");
    expect((await K.mentionableStored("ORBIT-1042", "a")).error).toBe("Jira is not connected");
    expect((await K.commentStored("ORBIT-1042", "hi", [])).error).toBe("Jira is not connected");
  });
});
