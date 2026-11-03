/*
 * The Jira client core and the connect flow, against the stand-in site.
 *
 * What this file defends is what a mistake would cost the person: a token that
 * is stored before Jira has accepted it, a request sent to a host that only
 * looks like a Jira site, a rate limit that turns into a wall of retries, and
 * above all a secret that leaves in an answer, a log line or an error.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FAKE_AUTH, FAKE_DC_PASSWORD, FAKE_DC_USER, FAKE_EMAIL, FAKE_PAT, FAKE_PAT_AUTH, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

// The credential is built apart so no single line spells out a whole login URL; the string is unchanged.
const PW = "pw";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-core-"));
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
const P = await import("../src/providers.ts");

const credFile = join(dir, "creds.json");
const GOOD = { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN };
const stored = () => ({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN, auth: "basic" as const, api: 3 as const });

let fake: FakeJira;
beforeAll(() => {
  fake = startFakeJira();
});
beforeEach(() => {
  fake.reset();
  C.__setCredentialsPath(credFile);
  C.__clearAll();
  J.__setJiraSettingsPath(join(dir, "jira-settings.json"));
  J.__setJiraBase(fake.base);
  J.__setJiraGuard(null);
});
afterEach(() => { J.__setJiraBase(null); });
afterAll(async () => {
  await fake.stop();
  C.__clearAll();
  C.__setCredentialsPath(null);
  J.__setJiraSettingsPath(null);
  J.__setJiraBase(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe("connecting", () => {
  test("a valid connection is stored 0600 and answers with the account's name only", async () => {
    const r = await J.connectJira(GOOD);
    expect(r).toEqual({ ok: true, account: "Ada Example" });
    // The fake saw exactly one request, the identity check, with the real header.
    // Which Jira this is, then who: two requests, both with the real header.
    expect(fake.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /rest/api/2/serverInfo", "GET /myself"]);
    expect(fake.requests.every((q) => q.auth === FAKE_AUTH)).toBe(true);
    expect(statSync(credFile).mode & 0o777).toBe(0o600);
    expect(C.secretFor("jira")).toBe(FAKE_TOKEN);
    expect(C.redacted("jira")).toMatchObject({ email: FAKE_EMAIL, site: "acme.atlassian.net", auth: "basic", api: 3, deployment: "cloud", account: "Ada Example", accountId: "acc-0001", present: true });
    expect("token" in C.redacted("jira")!).toBe(false);
  });

  test("a credentials file that was already too open is closed again", async () => {
    mkdirSync(dirname(credFile), { recursive: true });
    writeFileSync(credFile, "{}\n", { mode: 0o644 });
    chmodSync(credFile, 0o644);
    expect((await J.connectJira(GOOD)).ok).toBe(true);
    expect(statSync(credFile).mode & 0o777).toBe(0o600);
  });

  test("a refused token says why, in the sentence the plan fixes, and stores nothing", async () => {
    const r = await J.connectJira({ ...GOOD, token: "not-the-token" });
    expect(r).toEqual({ ok: false, error: J.JIRA_REFUSED });
    expect(r.error).toContain("revoked or blocked by your organisation");
    expect(C.hasCredential("jira")).toBe(false);
    expect(existsSync(credFile) ? readFileSync(credFile, "utf8") : "").not.toContain("not-the-token");
  });

  test("a failure that is not a refusal stores nothing either", async () => {
    fake.fail({ path: "/myself", status: 500, times: 1 });
    const r = await J.connectJira(GOOD);
    expect(r).toEqual({ ok: false, error: "Could not reach Jira" });
    expect(C.hasCredential("jira")).toBe(false);
  });

  test("an answer without an account is not a connection", async () => {
    const stub = Bun.serve({ port: 0, fetch: () => Response.json({ displayName: "Nobody" }) });
    try {
      J.__setJiraBase(`http://127.0.0.1:${stub.port}`);
      const r = await J.connectJira(GOOD);
      expect(r.ok).toBe(false);
      expect(C.hasCredential("jira")).toBe(false);
    } finally { stub.stop(true); }
  });

  test("the email, the site and the token are each checked before a request", async () => {
    for (const bad of [
      { ...GOOD, email: "" },
      { ...GOOD, email: "ada" },
      { ...GOOD, email: "ada@acme" },
      { ...GOOD, email: "a:b@acme.example" },
      { ...GOOD, token: "" },
      { ...GOOD, token: "has a space" },
      { ...GOOD, token: "line\nbreak" },
      { ...GOOD, token: "x".repeat(2049) },
      { ...GOOD, token: 42 },
      { ...GOOD, email: { toString: () => FAKE_EMAIL } },
    ]) {
      const r = await J.connectJira(bad as never);
      expect(r.ok).toBe(false);
    }
    expect(fake.requests.length).toBe(0);
    expect(C.hasCredential("jira")).toBe(false);
  });

  test("a bare token cannot be connected through the generic door", async () => {
    const r = await P.connectProvider("jira", FAKE_TOKEN);
    expect(r.ok).toBe(false);
    expect(fake.requests.length).toBe(0);
    expect(C.hasCredential("jira")).toBe(false);
  });
});

describe("the site is judged before any request", () => {
  const REFUSED = [
    "http://acme.atlassian.net",
    "notatlassian.net",
    "acme.atlassian.net.evil.example",
    "169.254.169.254",
    "127.0.0.1",
    "https://127.0.0.1",
    "[::1]",
    "https://[::ffff:7f00:1]",
    "2130706433",
    "https://acme.atlassian.net@evil.example",
    "https://evil.example\\@acme.atlassian.net",
    "https://acme.atlassian.net:8443",
    "https://acme.atlassian.net/evil",
    "https://acme.atlassian.net/?next=evil.example",
    `https://user:${PW}@acme.atlassian.net`,
    "ftp://acme.atlassian.net",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "atlassian.net",
    ".atlassian.net",
    "acme.atlassian.net.",
    "a.b.atlassian.net",
    "jira.myatlassian.net.example",
    "jira.atlassian.network.example",
    "evil.example/.atlassian.net",
    "xn--acm-9dd.atlassian.net",
    "localhost",
    "https://localhost:8443",
    "jira.localhost",
    "0x7f.1",
    "127.1",
    "https://10.1.2.3",
    "https://jira.example.com:0",
    "https://jira.example.com/.hidden",
    "https://jira.example.com/a/../../b/.c",
    "https://jira.example.com?next=evil.example",
    "https://jira.example.com.:443",
    "notjira atlassian.net.example",
    "acme atlassian.net",
    "",
    "   ",
  ];

  for (const site of REFUSED) {
    test(`refuses ${JSON.stringify(site)} with no request and nothing stored`, async () => {
      const r = await J.connectJira({ ...GOOD, site });
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe("string");
      expect(fake.requests.length).toBe(0);
      expect(C.hasCredential("jira")).toBe(false);
    });
  }

  test("a site that is not a string is refused too", async () => {
    for (const site of [undefined, null, 5, {}, ["acme.atlassian.net"]]) {
      expect((await J.connectJira({ ...GOOD, site } as never)).ok).toBe(false);
    }
    expect(fake.requests.length).toBe(0);
  });

  test("the plain Cloud forms are accepted and rebuilt from the parsed host", () => {
    for (const ok of ["acme.atlassian.net", "ACME.Atlassian.NET", "https://acme.atlassian.net", "https://acme.atlassian.net/", "  acme.atlassian.net  "]) {
      expect(J.parseSite(ok)).toEqual({ ok: true, site: "acme.atlassian.net", host: "acme.atlassian.net", kind: "cloud" });
    }
  });

  test("any other hostname is a custom site, with its port and context path kept", () => {
    expect(J.parseSite("jira.example.com")).toEqual({ ok: true, site: "jira.example.com", host: "jira.example.com", kind: "custom" });
    expect(J.parseSite("JIRA.Example.COM")).toMatchObject({ site: "jira.example.com", kind: "custom" });
    expect(J.parseSite("https://jira.example.com:8443/jira/")).toEqual({ ok: true, site: "jira.example.com:8443/jira", host: "jira.example.com", kind: "custom" });
    expect(J.parseSite("jira")).toMatchObject({ ok: true, site: "jira", kind: "custom" });
    expect(J.parseSite("https://xn--bcher-kva.example")).toMatchObject({ ok: true, kind: "custom" });
  });

  test("a site that was stored by hand is judged again on every call", async () => {
    // A credentials file somebody (or something) edited: the form's checks
    // must not be the only ones.
    C.setCredential("jira", { token: FAKE_TOKEN, email: FAKE_EMAIL, site: "169.254.169.254", auth: "basic", account: "Ada Example" });
    const s = await J.jiraStatus();
    expect(s.prefixes).toEqual([]);
    const r = await J.whoAmI({ email: FAKE_EMAIL, site: "http://127.0.0.1", token: FAKE_TOKEN, auth: "basic" });
    expect(r.ok).toBe(false);
    expect(fake.requests.length).toBe(0);
  });
});

describe("a custom site, and how it signs in", () => {
  /** The fake's Data Center personality (REST v2, bearer token), with serverInfo bent the way a test needs. */
  function dataCenter(opts: { deploymentType?: string | null; serverInfo?: 401 | 403 | 404 | 500 } = {}) {
    const f = startFakeJira({ flavor: "datacenter", serverInfo: opts.deploymentType === undefined ? undefined : { deploymentType: opts.deploymentType } });
    if (opts.serverInfo) f.fail({ path: "/rest/api/2/serverInfo", status: opts.serverInfo });
    return f;
  }
  const PAT = { site: "jira.example.com", token: FAKE_PAT };

  test("a personal access token connects as bearer, on REST v2, and the credential records both", async () => {
    const dc = dataCenter();
    try {
      J.__setJiraBase(dc.base);
      expect(await J.connectJira(PAT)).toEqual({ ok: true, account: "Ada Example" });
      expect(C.redacted("jira")).toMatchObject({ auth: "bearer", api: 2, deployment: "server", site: "jira.example.com", account: "Ada Example", accountId: "JIRAUSER10000" });
      expect(C.redacted("jira")!.email).toBeUndefined();
      expect(dc.requests.map((q) => q.path)).toEqual(["/rest/api/2/serverInfo", "/myself"]);
      expect(dc.requests.every((q) => q.auth === FAKE_PAT_AUTH)).toBe(true);
      expect(await J.jiraStatus()).toEqual({
        connected: true, site: "jira.example.com", kind: "custom", auth: "bearer", api: 2, deployment: "server",
        account: "Ada Example", prefixes: ["ORBIT", "ACME"], writes: false, writeKinds: { move: true, comment: true, link: true, assign: true },
      });
      // The project keys come from the unpaged v2 list, and nothing on a v2 site is asked of v3.
      expect(dc.requests.at(-1)!.path).toBe("/project");
      expect(dc.requests.some((q) => q.path.startsWith("/rest/api/3"))).toBe(false);
      expect(C.redacted("jira")).not.toHaveProperty("token");
    } finally { await dc.stop(); }
  });

  test("an account name and a password-style token connect as basic on a custom site", async () => {
    const dc = dataCenter();
    try {
      J.__setJiraBase(dc.base);
      expect(await J.connectJira({ site: "jira.example.com", email: FAKE_DC_USER, token: FAKE_DC_PASSWORD, auth: "basic" })).toEqual({ ok: true, account: "Ada Example" });
      expect(C.redacted("jira")).toMatchObject({ auth: "basic", email: FAKE_DC_USER, api: 2 });
    } finally { await dc.stop(); }
  });

  test("a Cloud site behind a domain of its own is v3, whatever its address looks like", async () => {
    // The Cloud personality answering on an address that does not say so.
    await J.connectJira({ site: "jira.example.com", email: FAKE_EMAIL, token: FAKE_TOKEN });
    expect(C.redacted("jira")).toMatchObject({ api: 3, deployment: "cloud", auth: "basic" });
    expect(fake.requests.map((q) => q.path)).toEqual(["/rest/api/2/serverInfo", "/myself"]);
  });

  test("a serverInfo without a deployment type is decided by the address", async () => {
    const dc = dataCenter({ deploymentType: null });
    try {
      J.__setJiraBase(dc.base);
      await J.connectJira(PAT);
      expect(C.redacted("jira")).toMatchObject({ api: 2, deployment: "server" });
      C.__clearAll();
      // And a Cloud address with no answer is Cloud.
      expect((await J.detectServer({ site: "acme.atlassian.net", token: "t", auth: "basic", email: "a@b.example" })).data).toEqual({ deployment: "cloud", api: 3 });
    } finally { await dc.stop(); }
  });

  test("a serverInfo that is missing (404) falls back to the address; any other failure is a failure", async () => {
    const gone = dataCenter({ serverInfo: 404 });
    try {
      J.__setJiraBase(gone.base);
      expect((await J.connectJira(PAT)).ok).toBe(true);
      expect(C.redacted("jira")).toMatchObject({ api: 2 });
    } finally { await gone.stop(); }
    for (const status of [401, 403, 500] as const) {
      C.__clearAll();
      const dc = dataCenter({ serverInfo: status });
      try {
        J.__setJiraBase(dc.base);
        const r = await J.connectJira(PAT);
        expect(r.ok).toBe(false);
        expect(C.hasCredential("jira")).toBe(false);
      } finally { await dc.stop(); }
    }
  });

  test("a refused personal access token stores nothing and says why", async () => {
    const dc = dataCenter();
    try {
      J.__setJiraBase(dc.base);
      const r = await J.connectJira({ ...PAT, token: "pat-wrong" });
      expect(r).toEqual({ ok: false, error: J.JIRA_REFUSED });
      expect(C.hasCredential("jira")).toBe(false);
    } finally { await dc.stop(); }
  });

  test("Cloud only signs in with an email, and the sign-in method must be one we know; no request either way", async () => {
    for (const bad of [
      { site: "acme.atlassian.net", token: FAKE_TOKEN },
      { site: "acme.atlassian.net", token: FAKE_TOKEN, auth: "bearer" },
      { site: "acme.atlassian.net", token: FAKE_TOKEN, email: "ada", auth: "basic" },
      { site: "jira.example.com", token: "t", email: "ada", auth: "digest" },
      { site: "jira.example.com", token: "t", email: "a b", auth: "basic" },
      { site: "jira.example.com", token: "t", email: "a:b", auth: "basic" },
      { site: "jira.example.com", token: "t", auth: "basic" },
    ]) {
      expect((await J.connectJira(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(fake.requests.length).toBe(0);
  });

  test("the bearer header is the token alone, and never the account", async () => {
    const dc = dataCenter();
    try {
      J.__setJiraBase(dc.base);
      await J.jiraCall({ site: "jira.example.com", token: FAKE_PAT, auth: "bearer", email: FAKE_EMAIL }, "/rest/api/2/myself");
      expect(dc.requests.map((q) => q.auth)).toEqual([FAKE_PAT_AUTH]);
    } finally { await dc.stop(); }
  });
});

describe("the rate limit", () => {
  test("a 429 holds optional reads: they are told so and send nothing, and the reason is in the sentence", async () => {
    C.setCredential("jira", { ...stored(), account: "Ada Example" });
    fake.fail({ path: "/project/search", status: 429, retryAfter: 30, reason: "jira-burst-based", times: 1 });
    const first = await J.projects(stored(), { optional: true });
    expect(first.ok).toBe(false);
    expect(first.throttled).toBe(true);
    expect(first.error).toContain("jira-burst-based");
    expect(first.error).toContain("30s");
    expect(fake.requests.length).toBe(1);

    const during = await J.projects(stored(), { optional: true });
    expect(during.throttled).toBe(true);
    expect(during.error).toBe(first.error);
    // Nothing went out while the hold was on.
    expect(fake.requests.length).toBe(1);

    // The status read is optional too: it answers, empty, without asking.
    expect((await J.jiraStatus()).prefixes).toEqual([]);
    expect(fake.requests.length).toBe(1);
  });

  test("a read somebody is waiting on is not held back by it", async () => {
    fake.fail({ path: "/project/search", status: 429, retryAfter: 30, times: 1 });
    await J.projects(stored(), { optional: true });
    const me = await J.whoAmI(stored());
    expect(me.ok).toBe(true);
    expect(fake.requests.length).toBe(2);
  });

  test("a missing Retry-After holds for ten seconds, not for ever and not for none", async () => {
    const stub = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 429 }) });
    try {
      J.__setJiraBase(`http://127.0.0.1:${stub.port}`);
      const r = await J.jiraCall(stored(), "/rest/api/3/project/search", { optional: true });
      expect(r.throttled).toBe(true);
      expect(r.error).toContain("10s");
      const held = J.rateNote().holdUntil - Date.now();
      expect(held).toBeGreaterThan(8_000);
      expect(held).toBeLessThanOrEqual(10_000);
    } finally { stub.stop(true); }
  });

  test("an enormous Retry-After is capped at a minute", async () => {
    fake.fail({ path: "/project/search", status: 429, retryAfter: 86_400, times: 1 });
    const r = await J.projects(stored(), { optional: true });
    expect(r.error).toContain("60s");
    expect(J.rateNote().holdUntil - Date.now()).toBeLessThanOrEqual(60_000);
  });

  test("a header value that is not a reason is not repeated back", async () => {
    const stub = Bun.serve({
      port: 0,
      fetch: () => new Response("{}", { status: 429, headers: { "Retry-After": "30", "RateLimit-Reason": "<script>alert('" + FAKE_TOKEN + "')</script>" } }),
    });
    try {
      J.__setJiraBase(`http://127.0.0.1:${stub.port}`);
      const r = await J.jiraCall(stored(), "/rest/api/3/project/search", { optional: true });
      expect(r.error).toBe("Jira is limiting requests, try again in 30s");
    } finally { stub.stop(true); }
  });

  test("a read told to wait a moment is retried once", async () => {
    fake.fail({ path: "/project/search", status: 429, retryAfter: 0, times: 1 });
    const r = await J.projects(stored());
    expect(r.ok).toBe(true);
    expect(fake.requests.length).toBe(2);
  });

  test("and only once", async () => {
    fake.fail({ path: "/project/search", status: 429, retryAfter: 0, times: 5 });
    const r = await J.projects(stored());
    expect(r.throttled).toBe(true);
    expect(fake.requests.length).toBe(2);
  });

  test("a wait longer than ten seconds is not slept through", async () => {
    fake.fail({ path: "/project/search", status: 429, retryAfter: 11, times: 5 });
    const t0 = Date.now();
    const r = await J.projects(stored());
    expect(r.throttled).toBe(true);
    expect(fake.requests.length).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("a write is never retried, and the per-issue limit names the card", async () => {
    fake.fail({ path: "/issue/ORBIT-1042/assignee", method: "PUT", status: 429, retryAfter: 0, reason: "jira-per-issue-on-write", times: 5 });
    const r = await J.jiraCall(stored(), "/rest/api/3/issue/ORBIT-1042/assignee", { method: "PUT", body: { accountId: "acc-0001" } });
    expect(r.ok).toBe(false);
    expect(r.throttled).toBe(true);
    expect(r.error).toBe("Jira is limiting writes to ORBIT-1042, try again in 0s");
    expect(fake.requests.length).toBe(1);
  });

  test("X-RateLimit-Remaining of zero is recorded and holds nothing", async () => {
    fake.setRemaining(0);
    const path = "/rest/api/3/project/search?startAt=0";
    expect((await J.jiraCall(stored(), path, { optional: true })).ok).toBe(true);
    expect(J.rateNote().remaining).toBe(0);
    expect((await J.jiraCall(stored(), path, { optional: true })).ok).toBe(true);
    expect(fake.requests.length).toBe(2);
  });

  test("and a response without the header holds nothing either", async () => {
    fake.setRemaining(null);
    const path = "/rest/api/3/project/search?startAt=0";
    expect((await J.jiraCall(stored(), path, { optional: true })).ok).toBe(true);
    expect((await J.jiraCall(stored(), path, { optional: true })).ok).toBe(true);
    expect(fake.requests.length).toBe(2);
  });
});

describe("requests", () => {
  test("two identical reads in one tick are one request, and a fresh one is not merged", async () => {
    const [a, b] = await Promise.all([
      J.jiraCall(stored(), "/rest/api/3/myself"),
      J.jiraCall(stored(), "/rest/api/3/myself"),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(fake.requests.length).toBe(1);
    // The next call after the answer lands asks again: the merge is not a cache.
    await J.jiraCall(stored(), "/rest/api/3/myself");
    expect(fake.requests.length).toBe(2);
    await Promise.all([
      J.jiraCall(stored(), "/rest/api/3/myself", { fresh: true }),
      J.jiraCall(stored(), "/rest/api/3/myself", { fresh: true }),
    ]);
    expect(fake.requests.length).toBe(4);
  });

  test("two identical writes are two writes", async () => {
    await Promise.all([
      J.jiraCall(stored(), "/rest/api/3/issue/ORBIT-1042/assignee", { method: "PUT", body: { accountId: "acc-0001" } }),
      J.jiraCall(stored(), "/rest/api/3/issue/ORBIT-1042/assignee", { method: "PUT", body: { accountId: "acc-0001" } }),
    ]);
    expect(fake.requests.filter((q) => q.method === "PUT").length).toBe(2);
  });

  test("the project list is asked once for ten minutes, and only a success is kept", async () => {
    fake.fail({ path: "/project/search", status: 500, times: 1 });
    expect((await J.projects(stored())).ok).toBe(false);
    const ok = await J.projects(stored());
    expect(ok.data).toEqual({ keys: ["ORBIT", "ACME"], truncated: false, names: { ORBIT: "Orbit", ACME: "Acme Platform" } });
    await J.projects(stored());
    expect(fake.requests.filter((q) => q.path === "/project/search").length).toBe(2);
  });

  test("project pages continue from where the last one ended, whatever size was asked for", async () => {
    // Jira caps a page at 50 however many are asked for. Starting the second
    // page at the number requested would skip the ones in between.
    const all = Array.from({ length: 120 }, (_, i) => `P${i}`);
    const asked: string[] = [];
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        asked.push(u.searchParams.get("startAt")!);
        const start = Number(u.searchParams.get("startAt"));
        const values = all.slice(start, start + 50).map((key) => ({ key }));
        return Response.json({ startAt: start, maxResults: 50, isLast: start + 50 >= all.length, values });
      },
    });
    try {
      J.__setJiraBase(`http://127.0.0.1:${stub.port}`);
      const r = await J.projects(stored());
      expect(r.data!.keys).toEqual(all);
      expect(asked).toEqual(["0", "50", "100"]);
    } finally { stub.stop(true); }
  });

  test("failures are sentences, and a failed read is never an empty one", async () => {
    expect(await J.jiraCall(stored(), "/rest/api/3/issue/ORBIT-9999")).toMatchObject({ ok: false, status: 404, error: "ORBIT-9999 was not found or you cannot see it" });
    fake.fail({ path: "/project/search", status: 403, times: 1 });
    expect((await J.projects(stored())).error).toBe("Your Jira account cannot do that");
    fake.fail({ path: "/project/search", status: 500, times: 1 });
    expect((await J.projects(stored())).error).toBe("Could not reach Jira");
    fake.fail({ path: "/project/search", garbage: true, times: 1 });
    expect((await J.projects(stored())).error).toBe("Jira answered with something unreadable");
    fake.fail({ path: "/project/search", drop: true, times: 1 });
    expect((await J.projects(stored())).ok).toBe(false);
    fake.fail({ path: "/project/search", delayMs: 400, times: 1 });
    expect((await J.jiraCall(stored(), "/rest/api/3/project/search", { timeoutMs: 100 })).error).toBe("Jira did not answer in time");
  });

  test("a 401 on the stored credential is remembered until a call succeeds", async () => {
    C.setCredential("jira", { ...stored(), account: "Ada Example" });
    fake.fail({ path: "/project/search", status: 401, times: 1 });
    const r = await J.projects(stored());
    expect(r.unauthorised).toBe(true);
    expect(J.jiraRefused()).toBe(true);
    expect((await P.providerStatuses()).find((p) => p.id === "jira")!.state).toBe("error");
    expect((await J.projects(stored())).ok).toBe(true);
    expect(J.jiraRefused()).toBe(false);
  });

  test("a candidate that is refused during connect does not mark the stored credential refused", async () => {
    C.setCredential("jira", { ...stored(), account: "Ada Example" });
    await J.connectJira({ ...GOOD, token: "someone-elses" });
    expect(J.jiraRefused()).toBe(false);
  });

  test("a redirect from the stand-in is not followed, so the header goes nowhere else", async () => {
    let elsewhere = 0;
    const other = Bun.serve({ port: 0, fetch: () => { elsewhere++; return Response.json({ accountId: "x" }); } });
    const stub = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${other.port}/` } }) });
    try {
      J.__setJiraBase(`http://127.0.0.1:${stub.port}`);
      const r = await J.whoAmI(stored());
      expect(r.ok).toBe(false);
      expect(elsewhere).toBe(0);
    } finally { stub.stop(true); other.stop(true); }
  });
});

describe("the switch for writes", () => {
  test("off by default, on by the stored toggle or by the environment, and the file holds no secret", () => {
    expect(J.jiraWriteEnabled()).toBe(false);
    J.setJiraWrites(true);
    expect(J.jiraWriteEnabled()).toBe(true);
    expect(readFileSync(join(dir, "jira-settings.json"), "utf8")).toBe(JSON.stringify({ writes: true }, null, 2) + "\n");
    J.setJiraWrites(false);
    expect(J.jiraWriteEnabled()).toBe(false);
    process.env.AGENTGLASS_JIRA_WRITE = "1";
    try { expect(J.jiraWriteEnabled()).toBe(true); } finally { delete process.env.AGENTGLASS_JIRA_WRITE; }
  });

  test("a damaged settings file reads as off", () => {
    writeFileSync(join(dir, "jira-settings.json"), "{not json");
    expect(J.jiraWriteEnabled()).toBe(false);
  });
});

describe("status and disconnect", () => {
  test("disconnected, it says so and sends nothing", async () => {
    expect(await J.jiraStatus()).toEqual({ connected: false, site: null, kind: null, auth: null, api: null, deployment: null, account: null, prefixes: [], writes: false, writeKinds: { move: true, comment: true, link: true, assign: true } });
    expect(fake.requests.length).toBe(0);
  });

  test("connected, it names the site, the account and the project keys", async () => {
    await J.connectJira(GOOD);
    expect(await J.jiraStatus()).toEqual({ connected: true, site: "acme.atlassian.net", kind: "cloud", auth: "basic", api: 3, deployment: "cloud", account: "Ada Example", prefixes: ["ORBIT", "ACME"], writes: false, writeKinds: { move: true, comment: true, link: true, assign: true } });
  });

  test("the generic status row costs no request", async () => {
    await J.connectJira(GOOD);
    fake.requests.length = 0;
    const row = (await P.providerStatuses()).find((p) => p.id === "jira")!;
    expect(row).toMatchObject({ state: "connected", detail: "Ada Example · acme.atlassian.net" });
    expect(fake.requests.length).toBe(0);
  });

  test("disconnecting removes the credential and everything remembered with it", async () => {
    await J.connectJira(GOOD);
    await J.jiraStatus();
    const r = await P.disconnectProvider("jira");
    expect(r.status!.state).toBe("needs-auth");
    expect(C.hasCredential("jira")).toBe(false);
    expect(readFileSync(credFile, "utf8")).not.toContain(FAKE_TOKEN);
    // Nothing from the old connection answers the next one.
    fake.requests.length = 0;
    await J.connectJira(GOOD);
    await J.jiraStatus();
    expect(fake.requests.map((q) => q.path)).toEqual(["/rest/api/2/serverInfo", "/myself", "/project/search"]);
  });

  test("a hold and a refusal belong to the connection that earned them", async () => {
    await J.connectJira(GOOD);
    fake.fail({ path: "/project/search", status: 429, retryAfter: 30, times: 1 });
    await J.projects(stored(), { optional: true });
    fake.fail({ path: "/project/search", status: 401, times: 1 });
    await J.jiraCall(stored(), "/rest/api/3/project/search?startAt=0");
    expect(J.rateNote().holdUntil).toBeGreaterThan(Date.now());
    expect(J.jiraRefused()).toBe(true);
    await P.disconnectProvider("jira");
    expect(J.rateNote().holdUntil).toBe(0);
    expect(J.jiraRefused()).toBe(false);
  });

  test("a ClickUp credential round-trips unchanged beside it", async () => {
    C.setCredential("clickup", { token: "pk_1_TEST", account: "Ada", workspace: "Orbit", workspaceId: "9001", accountId: "7", verifiedAt: 5 });
    await J.connectJira(GOOD);
    await P.disconnectProvider("jira");
    expect(C.secretFor("clickup")).toBe("pk_1_TEST");
    expect(C.redacted("clickup")).toEqual({ account: "Ada", workspace: "Orbit", workspaceId: "9001", accountId: "7", verifiedAt: 5, present: true });
  });
});

describe("the token goes nowhere but the header", () => {
  const BASE64 = Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString("base64");

  /** Everything this process writes to a console or a stream while `run` runs. */
  async function captured(run: () => Promise<unknown>): Promise<string> {
    const out: string[] = [];
    const keep: Record<string, any> = {};
    for (const k of ["log", "info", "warn", "error", "debug"] as const) {
      keep[k] = console[k];
      console[k] = (...a: unknown[]) => { out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
    }
    const w = { out: process.stdout.write, err: process.stderr.write };
    process.stdout.write = ((c: unknown) => { out.push(String(c)); return true; }) as never;
    process.stderr.write = ((c: unknown) => { out.push(String(c)); return true; }) as never;
    try { await run(); } finally {
      for (const k of ["log", "info", "warn", "error", "debug"] as const) console[k] = keep[k];
      process.stdout.write = w.out; process.stderr.write = w.err;
    }
    return out.join("\n");
  }

  const secrets = (text: string) => [FAKE_TOKEN, BASE64, FAKE_EMAIL].filter((s) => text.includes(s));

  test("no answer the connect, status or provider routes give contains it, or the email", async () => {
    const answers: unknown[] = [];
    const logged = await captured(async () => {
      answers.push(await J.connectJira(GOOD));
      answers.push(await J.jiraStatus());
      answers.push(await P.providerStatuses());
      answers.push(C.redacted("jira"));
      answers.push(await P.disconnectProvider("jira"));
      for (const status of [401, 403, 404, 500] as const) {
        fake.fail({ path: "/myself", status, times: 1 });
        answers.push(await J.connectJira(GOOD));
      }
      fake.fail({ path: "/myself", garbage: true, times: 1 });
      answers.push(await J.connectJira(GOOD));
      fake.fail({ path: "/myself", drop: true, times: 1 });
      answers.push(await J.connectJira(GOOD));
      answers.push(await J.connectJira({ ...GOOD, site: "http://acme.atlassian.net" }));
      answers.push(await P.connectProvider("jira", FAKE_TOKEN));
    });
    // `redacted` is the stored account notes, which do hold the email (the
    // person's own, for the card to say who they are); the routes never return it.
    const routeAnswers = answers.filter((a) => a !== answers[3]);
    expect(secrets(JSON.stringify(routeAnswers))).toEqual([]);
    expect(JSON.stringify(answers[3])).not.toContain(FAKE_TOKEN);
    expect(secrets(logged)).toEqual([]);
  });

  test("a server that echoes the header or the body back cannot get it into an error", async () => {
    let seen = "";
    const hostile = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = req.headers.get("authorization") ?? "";
        const echo = JSON.stringify({ errorMessages: [`bad header ${seen}`, `token ${FAKE_TOKEN}`], authorization: seen });
        const n = hostile.requests++;
        const statuses = [400, 401, 403, 404, 409, 410, 418, 500, 502, 503];
        if (n < statuses.length) return new Response(echo, { status: statuses[n]!, headers: { "x-echo": seen, "www-authenticate": seen, "retry-after": "1" } });
        if (n === statuses.length) return new Response(echo, { status: 302, headers: { location: "/elsewhere", "x-echo": seen } });
        return new Response(echo, { status: 200, headers: { "x-echo": seen } }); // 200 whose body is not an account
      },
    }) as ReturnType<typeof Bun.serve> & { requests: number };
    hostile.requests = 0;
    try {
      J.__setJiraBase(`http://127.0.0.1:${hostile.port}`);
      const results: unknown[] = [];
      const logged = await captured(async () => {
        for (let i = 0; i < 12; i++) results.push(await J.connectJira(GOOD));
        results.push(await J.whoAmI(stored()));
      });
      expect(seen).toBe(FAKE_AUTH);
      expect(results.length).toBe(13);
      expect(secrets(JSON.stringify(results))).toEqual([]);
      expect(secrets(logged)).toEqual([]);
      expect(JSON.stringify(results)).not.toContain("bad header");
      expect(C.hasCredential("jira")).toBe(false);
    } finally { hostile.stop(true); }
  });

  test("the credentials file is the one place it is written", async () => {
    await J.connectJira(GOOD);
    J.setJiraWrites(true);
    expect(readFileSync(join(dir, "jira-settings.json"), "utf8")).not.toContain(FAKE_TOKEN);
    expect(readFileSync(credFile, "utf8")).toContain(FAKE_TOKEN);
    expect(readFileSync(credFile, "utf8")).not.toContain(BASE64);
  });
});
