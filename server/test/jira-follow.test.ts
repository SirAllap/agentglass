/*
 * Watching a Jira card and voting for it, through the client and the agent door, against the Cloud fake (REST v3, the watcher
 * named by account id) and its Data Center personality (REST v2, named by login). The pure decisions come first, then each write:
 * what it costs in requests, what it sends, and for every refusal the proof that nothing was sent.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";
import { countSaid, followAction, followAfter, followSaid, type CardFollow } from "../../shared/jiraFollow.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-follow-"));
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
const F = await import("../src/jiraFollow.ts");
const D = await import("../src/jiraDoor.ts");
const credFile = join(dir, "creds.json");

afterAll(() => {
  C.__clearAll();
  C.__setCredentialsPath(null);
  J.__setJiraBase(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const base: CardFollow = { watching: false, watchers: 2, voted: false, votes: 1 };

describe("followAfter: the counts move by one, and only when this account's own mark did", () => {
  test("turning a mark on adds one, turning it off takes one", () => {
    expect(followAfter(base, "watch", true)).toEqual({ ...base, watching: true, watchers: 3 });
    expect(followAfter({ ...base, watching: true }, "watch", false)).toEqual({ ...base, watching: false, watchers: 1 });
    expect(followAfter(base, "vote", true)).toEqual({ ...base, voted: true, votes: 2 });
    expect(followAfter({ ...base, voted: true }, "vote", false)).toEqual({ ...base, voted: false, votes: 0 });
  });
  test("a mark that was already as asked moves nothing, and a count is never below zero", () => {
    expect(followAfter({ ...base, watching: true }, "watch", true)).toEqual({ ...base, watching: true });
    expect(followAfter(base, "watch", false)).toEqual(base);
    expect(followAfter({ ...base, watching: true, watchers: 0 }, "watch", false).watchers).toBe(0);
  });
  test("a count the site did not give stays not given", () => {
    expect(followAfter({ ...base, watchers: null }, "watch", true)).toEqual({ ...base, watching: true, watchers: null });
    expect(followAfter({ ...base, votes: null }, "vote", true).votes).toBeNull();
  });
  test("the words", () => {
    expect(followSaid("watch", true, "ORBIT-1042")).toBe("You are watching ORBIT-1042");
    expect(followSaid("watch", false, "ORBIT-1042")).toBe("You stopped watching ORBIT-1042");
    expect(followSaid("vote", true, "ORBIT-1042")).toBe("You voted for ORBIT-1042");
    expect(followSaid("vote", false, "ORBIT-1042")).toBe("You took your vote off ORBIT-1042");
    expect([followAction("watch", false), followAction("watch", true), followAction("vote", false), followAction("vote", true)]).toEqual(["Watch", "Stop watching", "Vote", "Remove vote"]);
    expect([countSaid(0, "watcher"), countSaid(1, "watcher"), countSaid(7, "vote"), countSaid(null, "vote")]).toEqual(["0 watchers", "1 watcher", "7 votes", ""]);
  });
});

function suite(flavor: FakeFlavor) {
  const dc = flavor === "datacenter";
  describe(`watch and vote, ${dc ? "Data Center (v2)" : "Cloud (v3)"}`, () => {
    let fake: FakeJira;
    beforeAll(() => { fake = startFakeJira({ flavor }); });
    afterAll(async () => { await fake.stop(); });
    beforeEach(async () => {
      fake.reset();
      F.__forgetLogin();
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
    const me = "acc-0001";
    const writes = () => fake.requests.filter((r) => r.method !== "GET");

    test("the card's own read carries the counts and this account's marks, with no request of its own", async () => {
      const r = await K.detailStored(KEY);
      expect(r.data!.detail.follow).toEqual({ watching: false, watchers: 2, voted: false, votes: 1 });
      const card = fake.requests.filter((q) => q.path === `/issue/${KEY}`);
      expect(card).toHaveLength(1);
      expect(card[0]!.query.fields).toContain("watches");
      expect(card[0]!.query.fields).toContain("votes");
      expect(fake.requests.filter((q) => /watchers|votes/.test(q.path))).toEqual([]);
    });

    test("a card the site lets nobody vote on has no votes; a count this account may not see is null", async () => {
      issue().noVoting = true;
      issue().hideWatchCount = true;
      const r = await K.detailStored(KEY);
      expect(r.data!.detail.follow).toEqual({ watching: false, watchers: null, voted: false, votes: null });
    });

    test("watching names the account as a bare string and costs one request (two the first time on Data Center)", async () => {
      const out = await F.setWatchStored(KEY, true);
      expect(out).toEqual({ ok: true, on: true });
      const sent = writes();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.method).toBe("POST");
      expect(sent[0]!.path).toBe(`/issue/${KEY}/watchers`);
      // The body is the JSON string itself, not an object: `"acc-0001"`, or the login on Data Center.
      expect(sent[0]!.body).toBe(dc ? "ada" : me);
      expect(fake.requests.length).toBe(dc ? 2 : 1);
      expect(issue().watchers).toContain(me);
      fake.requests.length = 0;
      await F.setWatchStored(KEY, true);
      expect(fake.requests.length).toBe(1);
    });

    test("stopping is a DELETE naming the account in the query, and does it once", async () => {
      issue().watchers = [me, "acc-0002"];
      fake.requests.length = 0;
      const out = await F.setWatchStored(KEY, false);
      expect(out).toEqual({ ok: true, on: false });
      const sent = writes();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.method).toBe("DELETE");
      expect(sent[0]!.path).toBe(`/issue/${KEY}/watchers`);
      expect(sent[0]!.query).toEqual(dc ? { username: "ada" } : { accountId: me });
      expect(issue().watchers).toEqual(["acc-0002"]);
    });

    test("watching twice is watching: the site is asked and the watcher is there once", async () => {
      await F.setWatchStored(KEY, true);
      expect((await F.setWatchStored(KEY, true)).ok).toBe(true);
      expect(issue().watchers!.filter((w) => w === me)).toHaveLength(1);
    });

    test("a vote names nobody, costs one request, and is taken back by a DELETE", async () => {
      expect(await F.setVoteStored(KEY, true)).toEqual({ ok: true, on: true });
      let sent = writes();
      expect(sent.map((q) => `${q.method} ${q.path}`)).toEqual([`POST /issue/${KEY}/votes`]);
      expect(sent[0]!.body).toBeUndefined();
      expect(issue().voters).toContain(me);
      fake.requests.length = 0;
      expect(await F.setVoteStored(KEY, false)).toEqual({ ok: true, on: false });
      sent = writes();
      expect(sent.map((q) => `${q.method} ${q.path}`)).toEqual([`DELETE /issue/${KEY}/votes`]);
      expect(fake.requests).toHaveLength(1);
      expect(issue().voters).toEqual(["acc-0003"]);
    });

    test("every refusal before the site is asked sends nothing at all", async () => {
      const cases: [string, () => Promise<{ ok: boolean; error?: string }>, RegExp][] = [
        ["watch on text", () => F.setWatchStored(KEY, "false"), /true or false/],
        ["watch on nothing", () => F.setWatchStored(KEY, undefined), /true or false/],
        ["vote on a number", () => F.setVoteStored(KEY, 0), /true or false/],
        ["not a key", () => F.setWatchStored("not a key", true), /not a Jira card id/],
        ["vote not a key", () => F.setVoteStored("ORBIT-1042/../x", true), /not a Jira card id/],
      ];
      for (const [name, run, say] of cases) {
        fake.requests.length = 0;
        const out = await run();
        expect([name, out.ok]).toEqual([name, false]);
        expect([name, out.error]).toEqual([name, expect.stringMatching(say)]);
        expect([name, fake.requests]).toEqual([name, []]);
      }
    });

    test("with the write switch off nothing is sent, for either", async () => {
      delete process.env.AGENTGLASS_JIRA_WRITE;
      for (const run of [() => F.setWatchStored(KEY, true), () => F.setVoteStored(KEY, true)]) {
        const out = await run();
        expect(out).toEqual({ ok: false, error: J.WRITE_OFF });
      }
      expect(fake.requests).toEqual([]);
    });

    test("not connected is a sentence and no request", async () => {
      C.__clearAll();
      fake.requests.length = 0;
      expect((await F.setWatchStored(KEY, true)).error).toBe(J.NOT_CONNECTED);
      expect(fake.requests).toEqual([]);
    });

    test("an account the site will not let watch is told so in our words, not the site's", async () => {
      issue().denyWatch = true;
      const out = await F.setWatchStored(KEY, true);
      expect(out).toEqual({ ok: false, error: `Your Jira account cannot watch ${KEY}`, denied: true });
      expect(JSON.stringify(out)).not.toContain("manage watchers");
    });

    test("a vote the site will not take offers the two reasons, and a card of your own is one", async () => {
      const own = await F.setVoteStored("ORBIT-1000", true);
      expect(own.ok).toBe(false);
      expect(own.error).toContain("voting may be off");
      expect(JSON.stringify(own)).not.toContain("you have reported");
      // A refusal that is only that card is not a refusal of the account: the pane keeps offering it.
      expect(own.denied).toBeUndefined();
      issue().denyVote = true;
      expect((await F.setVoteStored(KEY, true)).ok).toBe(false);
    });

    test("a card that is gone says so for a watch", async () => {
      const out = await F.setWatchStored("ORBIT-9999", true);
      expect(out.ok).toBe(false);
      expect(out.error).toContain("could not find ORBIT-9999");
    });

    describe("the door", () => {
      test("watch and vote are acting verbs, and say what the account's mark is now", async () => {
        for (const v of ["watch", "vote"]) { expect(D.isActing(v)).toBe(true); expect(D.DOOR_VERBS as readonly string[]).toContain(v); }
        const w = await D.runDoor("watch", { key: KEY });
        expect(w).toMatchObject({ status: 200, body: { ok: true, state: { watching: true } } });
        const off = await D.runDoor("watch", { key: KEY, off: true });
        expect(off).toMatchObject({ status: 200, body: { ok: true, state: { watching: false } } });
        expect(issue().watchers).not.toContain(me);
        const v = await D.runDoor("vote", { key: KEY });
        expect(v).toMatchObject({ status: 200, body: { ok: true, state: { voted: true } } });
        expect(issue().voters).toContain(me);
      });
      test("off is a boolean: the text false is a refusal and sends nothing", async () => {
        fake.requests.length = 0;
        for (const verb of ["watch", "vote"]) {
          const r = await D.runDoor(verb, { key: KEY, off: "false" });
          expect(r).toMatchObject({ status: 400, body: { ok: false, error: "off must be true or false" } });
        }
        expect(fake.requests).toEqual([]);
      });
      test("a refusal from the site comes back as a 400 with our sentence, with the write switch off as the screen's", async () => {
        issue().denyWatch = true;
        expect((await D.runDoor("watch", { key: KEY })).body.error).toBe(`Your Jira account cannot watch ${KEY}`);
        delete process.env.AGENTGLASS_JIRA_WRITE;
        expect((await D.runDoor("vote", { key: KEY })).body.error).toBe(J.WRITE_OFF);
      });
      test("the card read says the marks and the counts as numbers, and leaves out what the site does not give", async () => {
        const r = await D.runDoor("card", { key: KEY });
        expect(r.body.state).toMatchObject({ watching: false, watchers: 2, voted: false, votes: 1 });
        issue().noVoting = true;
        issue().hideWatchCount = true;
        const bare = await D.runDoor("card", { key: KEY });
        const st = bare.body.state as Record<string, unknown>;
        expect(st.watching).toBe(false);
        expect("votes" in st).toBe(false);
        expect("watchers" in st).toBe(false);
      });
    });
  });
}

suite("cloud");
suite("datacenter");
