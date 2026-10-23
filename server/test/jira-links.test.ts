/*
 * Remote links: the pull requests a Jira card is linked to on the site, read
 * and written, as Cloud (v3) and as Data Center (v2).
 *
 * What a mistake here costs: a second link on the card every time somebody
 * presses the button (existing links on real sites carry no global id, so the
 * id alone cannot say "already there"), a write that goes out with writes off,
 * a link that is a `javascript:` address on somebody else's card, and Jira's
 * own error text turning up in an answer. Request counts are the user's action.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-links-"));
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
const { withStatedLinks } = await import("../src/clickup.ts");

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

const PR = "https://github.com/acme/orbit/pull/2196";
const KEY = "ORBIT-1042";

function suite(flavor: FakeFlavor) {
  const dc = flavor === "datacenter";
  describe(`remote links, ${dc ? "Data Center (v2)" : "Cloud (v3)"}`, () => {
    let fake: FakeJira;
    beforeAll(() => { fake = startFakeJira({ flavor }); });
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
      // The seed already links this card to a pull request; these tests start from a card with none.
      fake.state.remoteLinks[KEY] = [];
      fake.requests.length = 0;
    });
    afterEach(() => { delete process.env.AGENTGLASS_JIRA_WRITE; J.__setJiraBase(null); });

    const posts = () => fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/remotelink"));
    const stored = () => fake.state.remoteLinks[KEY] ?? [];

    test("reading: only pull request addresses, canonical, in one request", async () => {
      fake.state.remoteLinks[KEY] = [
        { id: 1, object: { url: "https://github.com/Acme/Orbit/pull/2196/files", title: "#2196 retry", status: { resolved: true } } },
        { id: 2, object: { url: "https://wiki.acme.example/runbook", title: "Runbook" } },
        { id: 3, globalId: "x", object: { url: "https://github.com/acme/orbit/issues/12" } },
        { id: 4, object: { url: "javascript:alert(1)" } },
      ];
      const r = await J.remoteLinksStored(KEY);
      expect(r).toMatchObject({ ok: true, data: [{ url: PR, number: 2196, title: "#2196 retry", resolved: true }] });
      expect(fake.requests.length).toBe(1);
    });

    test("an address only in a comment costs no request: the detail read carries it, the links read stays one", async () => {
      const D = await import("../src/jiraComments.ts");
      const issue = fake.state.issues[KEY]!;
      const text = (d: { description: string; comments: { text: string }[] }) => [d.description, ...d.comments.map((c) => c.text)].join("\n");
      // The same card read twice: once as it is, once with a comment that names a pull request. Same requests.
      await J.withStored((c) => D.readDetail(c, KEY, { fresh: true })); // warms the site's remembered field lists
      fake.requests.length = 0;
      const plain = await J.withStored((c) => D.readDetail(c, KEY, { fresh: true }));
      const before = fake.requests.length;
      issue.comments.push({ id: "9001", author: issue.reporter, created: "2026-10-01T10:00:00.000+0000", updated: "2026-10-01T10:00:00.000+0000", body: dc ? `Pull request: ${PR}` : { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `Pull request: ${PR}` }] }] } });
      fake.requests.length = 0;
      const withMention = await J.withStored((c) => D.readDetail(c, KEY, { fresh: true }));
      expect(fake.requests.length).toBe(before);
      expect(plain.ok && text(plain.data!.detail)).not.toContain(PR);
      expect(withMention.ok && text(withMention.data!.detail)).toContain(PR);
      fake.requests.length = 0;
      expect(await J.remoteLinksStored(KEY)).toEqual({ ok: true, data: [] });
      expect(fake.requests.length).toBe(1);
    });

    test("linking twice costs one write", async () => {
      expect(await J.linkPullRequestStored(KEY, PR, "Retry the export")).toEqual({ ok: true, linked: true, url: PR });
      expect(await J.linkPullRequestStored(KEY, PR, "Retry the export")).toEqual({ ok: true, linked: false, url: PR });
      expect(posts().length).toBe(1);
      expect(stored().length).toBe(1);
      expect(posts()[0]!.body).toEqual({ globalId: PR, object: { url: PR, title: "acme/orbit#2196: Retry the export" } });
    });

    test("a card whose existing link has no global id is not given a second one", async () => {
      fake.state.remoteLinks[KEY] = [{ id: 7, object: { url: "https://github.com/Acme/Orbit/pull/2196/", title: "#2196" } }];
      expect(await J.linkPullRequestStored(KEY, PR)).toEqual({ ok: true, linked: false, url: PR });
      expect(posts().length).toBe(0);
      expect(stored().length).toBe(1);
    });

    test("writes off refuses before any request", async () => {
      delete process.env.AGENTGLASS_JIRA_WRITE;
      expect(await J.linkPullRequestStored(KEY, PR)).toEqual({ ok: false, error: "Writing to Jira is switched off" });
      expect(fake.requests.length).toBe(0);
    });

    test("an address that is not an https pull request on an allowed host is refused, unsent", async () => {
      for (const bad of [
        "javascript:alert(1)", "http://github.com/acme/orbit/pull/1", "https://github.com/acme/orbit/issues/1",
        "https://github.com.evil.example/acme/orbit/pull/1", "https://github.com@evil.example/acme/orbit/pull/1",
        "https://github.com:8443/acme/orbit/pull/1", "https://evil.example/acme/orbit/pull/1", "file:///etc/passwd", "", "not a url",
      ]) {
        expect(await J.linkPullRequestStored(KEY, bad)).toEqual({ ok: false, error: "That is not a pull request address" });
      }
      expect(await J.linkPullRequestStored("nope", PR)).toEqual({ ok: false, error: "That is not a Jira card id" });
      expect(fake.requests.length).toBe(0);
    });

    test("a GitLab merge request is a pull request address", async () => {
      const mr = "https://gitlab.com/acme/orbit/-/merge_requests/41";
      expect(await J.linkPullRequestStored(KEY, mr, "")).toEqual({ ok: true, linked: true, url: mr });
      expect(posts()[0]!.body).toMatchObject({ object: { title: "acme/orbit#41" } });
    });

    test("a read that fails stops the write; the answer is ours, not Jira's", async () => {
      fake.fail({ path: `/issue/${KEY}/remotelink`, method: "GET", status: 500 });
      const r = await J.linkPullRequestStored(KEY, PR);
      expect(r.ok).toBe(false);
      expect(posts().length).toBe(0);
    });

    test("a refused write never echoes what Jira said", async () => {
      fake.fail({ path: `/issue/${KEY}/remotelink`, method: "POST", status: 400 });
      const r = await J.linkPullRequestStored(KEY, PR);
      expect(r).toEqual({ ok: false, error: "Jira did not accept that link" });
      fake.reset();
      fake.state.remoteLinks[KEY] = [];
      fake.fail({ path: `/issue/${KEY}/remotelink`, method: "POST", status: 403 });
      const r403 = await J.linkPullRequestStored(KEY, PR);
      expect(JSON.stringify(r403)).toBe(JSON.stringify({ ok: false, error: "Your Jira account cannot do that" }));
    });

    test("the title is one clean line, bounded", async () => {
      await J.linkPullRequestStored(KEY, PR, `Retry\n\tthe export ${"x".repeat(400)}`);
      const title = (posts()[0]!.body as { object: { title: string } }).object.title;
      expect(title.startsWith("acme/orbit#2196: Retry the export x")).toBe(true);
      expect(title.length).toBeLessThanOrEqual("acme/orbit#2196: ".length + 200);
      expect(title).not.toMatch(/[\n\t]/);
    });

    test("not connected is a sentence", async () => {
      C.__clearAll();
      expect(await J.linkPullRequestStored(KEY, PR)).toEqual({ ok: false, error: "Jira is not connected" });
    });
  });
}
suite("cloud");
suite("datacenter");

describe("folding links into a search", () => {
  const found = [{ number: 2196, title: "Retry", state: "MERGED", url: PR, link: "own" as const }, { number: 2210, title: "Docs", state: "OPEN", url: "https://github.com/acme/orbit/pull/2210", link: "mention" as const }];
  test("a link to a found pull request marks it stated and own; one not found is added", () => {
    const out = withStatedLinks(found, [
      { url: PR, number: 2196, title: "x" },
      { url: "https://github.com/acme/other/pull/5", number: 5, title: "acme/other#5" },
    ]);
    expect(out.map((p) => [p.number, !!p.stated, p.link])).toEqual([[2196, true, "own"], [5, true, "own"], [2210, false, "mention"]]);
    expect(out.find((p) => p.number === 2196)!.state).toBe("MERGED");
  });
  test("a link to a mention upgrades it to own", () => {
    expect(withStatedLinks(found, [{ url: "https://github.com/acme/orbit/pull/2210", number: 2210, title: "" }]).find((p) => p.number === 2210)).toMatchObject({ stated: true, link: "own", state: "OPEN" });
  });
  test("no links is the same list", () => {
    expect(withStatedLinks(found, [])).toEqual(found);
  });
});
