/*
 * Jira calls for a repo go out with that repo's account, and a repo whose account
 * is gone is "not connected", never the default account. Tokens are fakes; the
 * stand-in site only accepts the fake login, so which account a call used shows
 * as accepted or refused.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jiraacc-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");

const C = await import("../src/credentials.ts");
const T = await import("../src/trackerAccounts.ts");
const A = await import("../src/jiraAccount.ts");
const J = await import("../src/jira.ts");
const P = await import("../src/providers.ts");
const V = await import("../src/jiraviews.ts");

const good = { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN, auth: "basic" as const, api: 3 as const };
const bad = { ...good, token: "stale-token" };
let fake: FakeJira;
beforeAll(() => { fake = startFakeJira(); });
beforeEach(() => {
  fake.reset();
  C.__setCredentialsPath(join(dir, "creds.json")); C.__clearAll();
  T.__setTrackerAccountsPath(join(dir, "tracker-accounts.json"));
  rmSync(join(dir, "tracker-accounts.json"), { force: true });
  J.__setJiraSettingsPath(join(dir, "jira-settings.json"));
  J.__setJiraBase(fake.base);
  J.forgetJira();
  // The default account holds a token the site refuses; "work" holds the one it accepts.
  C.setCredential("jira", bad, "primary");
  C.setCredential("jira", good, "work");
});
afterAll(async () => {
  await fake.stop();
  C.__clearAll(); C.__setCredentialsPath(null); T.__setTrackerAccountsPath(null); J.__setJiraSettingsPath(null); J.__setJiraBase(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe("route edge: repo to account", () => {
  test("no entry: nothing entered, the default account is used", () => {
    expect(A.enterJiraForRepo("acme/orbit")).toBeNull();
    expect(A.jiraAccount()).toBeUndefined();
  });
  test("an entry whose account is gone answers a sentence naming it and enters nothing", () => {
    T.setAccountFor("acme/orbit", "jira", "work");
    C.clearCredential("jira", "work");
    expect(A.enterJiraForRepo("acme/orbit")).toEqual({ ok: false, error: 'The Jira account "work" chosen for acme/orbit is not connected' });
    expect(A.jiraAccount()).toBeUndefined();
  });
  test("an entry enters its account for the rest of the request", async () => {
    T.setAccountFor("acme/orbit", "jira", "work");
    // enterWith binds the async context it runs in; a continuation keeps it out of the other tests.
    const seen = await Promise.resolve().then(() => ({ refused: A.enterJiraForRepo("acme/orbit"), key: A.jiraAccount() }));
    expect(seen).toEqual({ refused: null, key: "work" });
    expect(A.jiraAccount(), "the caller's own context is untouched").toBeUndefined();
  });
  test("no repo on the request: nothing to do", () => { expect(A.enterJiraForRepo(null)).toBeNull(); });
});

describe("jira.ts calls carry the scoped account", () => {
  test("a stored read inside a scope signs in as that account; outside it as the default", async () => {
    const inside = await A.inJiraAccount("work", () => J.withStored((c) => J.whoAmI(c)));
    const outside = await J.withStored((c) => J.whoAmI(c));
    expect(inside.ok).toBe(true);
    expect(outside.ok).toBe(false);
  });
  test("an account with no token says so by name and sends nothing", async () => {
    const r = await A.inJiraAccount("ghost", () => J.withStored((c) => J.whoAmI(c)));
    expect(r).toMatchObject({ ok: false, error: 'The Jira account "ghost" is not connected' });
    expect(fake.requests).toEqual([]);
  });
  test("the default account's sentence is unchanged", async () => {
    C.clearCredential("jira", "work"); C.clearCredential("jira", "primary");
    expect(await J.withStored((c) => J.whoAmI(c))).toMatchObject({ ok: false, error: "Jira is not connected" });
  });
  test("a cached answer for one account is not served to another", async () => {
    // Same path, same site: the default's refusal must not answer for "work", nor the reverse.
    const a = await J.withStored((c) => J.projects(c));
    const b = await A.inJiraAccount("work", () => J.withStored((c) => J.projects(c)));
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(true);
  });
});

describe("what a token found out stays with its account", () => {
  test("a refusal on the default does not mark the named account, and the reverse", async () => {
    // beforeEach: the default's token is refused, "work" is accepted.
    expect((await J.withStored((c) => J.whoAmI(c))).ok).toBe(false);
    expect(J.jiraRefused(), "the default is refused").toBe(true);
    expect(A.inJiraAccount("work", () => J.jiraRefused()), "work is not").toBe(false);
    C.setCredential("jira", good, "primary"); C.setCredential("jira", bad, "work");
    J.forgetJira();
    expect((await A.inJiraAccount("work", () => J.withStored((c) => J.whoAmI(c)))).ok).toBe(false);
    expect(A.inJiraAccount("work", () => J.jiraRefused()), "work is refused").toBe(true);
    expect(J.jiraRefused(), "the default is not").toBe(false);
  });
  test("a 429 on the named account holds that account only", async () => {
    fake.fail({ path: "/project/search", status: 429, retryAfter: 30, times: 1 });
    const hit = await A.inJiraAccount("work", () => J.withStored((c) => J.projects(c, { optional: true })));
    expect(hit).toMatchObject({ ok: false, throttled: true });
    expect(A.inJiraAccount("work", () => J.rateNote().holdUntil)).toBeGreaterThan(Date.now());
    expect(J.rateNote().holdUntil, "the default is not held").toBe(0);
  });
  test("disconnecting one account forgets its state and keeps the other's", async () => {
    await J.withStored((c) => J.whoAmI(c));
    expect(J.jiraRefused()).toBe(true);
    await P.disconnectProvider("jira", { accountKey: "work" });
    expect(J.jiraRefused(), "the default's refusal kept").toBe(true);
  });
});

describe("cached board rows are kept per account", () => {
  const row = (customId: string) => ({ view: { id: "b1", name: "Board", url: "u", addedAt: 0 }, tasks: [{ id: "1", customId, title: "t" } as never], columns: [], at: Date.now() } as never);
  test("two accounts on one site do not read each other's rows", () => {
    V.__setJiraViewsPath(join(dir, "jira-views.json")); V.__clear();
    V.putCache("acme.atlassian.net", "b1", row("ORBIT-1"));
    A.inJiraAccount("work", () => V.putCache("acme.atlassian.net", "b1", row("ZETA-9")));
    expect(V.cachedFor("acme.atlassian.net", "b1")?.tasks[0]?.customId).toBe("ORBIT-1");
    expect(A.inJiraAccount("work", () => V.cachedFor("acme.atlassian.net", "b1")?.tasks[0]?.customId)).toBe("ZETA-9");
    expect(A.inJiraAccount("other", () => V.cachedFor("acme.atlassian.net", "b1"))).toBeUndefined();
    expect(V.knownKeys("acme.atlassian.net")).toEqual(["ORBIT"]);
    expect(A.inJiraAccount("work", () => V.knownKeys("acme.atlassian.net"))).toEqual(["ZETA"]);
    expect(V.boardHolding("acme.atlassian.net", "ZETA-9")).toBeNull();
    expect(A.inJiraAccount("work", () => V.boardHolding("acme.atlassian.net", "ZETA-9")?.viewId)).toBe("b1");
    V.__setJiraViewsPath(null);
  });
  test("removing a view drops it from every account's cache", () => {
    V.__setJiraViewsPath(join(dir, "jira-views.json")); V.__clear();
    V.addView("acme.atlassian.net", { id: "b1", name: "Board", url: "u", addedAt: 0 } as never);
    V.putCache("acme.atlassian.net", "b1", row("ORBIT-1"));
    A.inJiraAccount("work", () => V.putCache("acme.atlassian.net", "b1", row("ZETA-9")));
    V.removeView("acme.atlassian.net", "b1");
    expect(V.cachedFor("acme.atlassian.net", "b1")).toBeUndefined();
    expect(A.inJiraAccount("work", () => V.cachedFor("acme.atlassian.net", "b1"))).toBeUndefined();
    V.__setJiraViewsPath(null);
  });
  test("a board read held for one account is not served to another", async () => {
    V.__setJiraViewsPath(join(dir, "jira-views.json")); V.__clear();
    const B = await import("../src/jiraboards.ts");
    const asWork = await A.inJiraAccount("work", () => B.viewRead());
    const asDefault = await B.viewRead();
    expect(asWork.ok, "work's token is accepted").toBe(true);
    expect(asDefault.ok, "the default's is refused, whatever work was just told").toBe(false);
    V.__setJiraViewsPath(null);
  });
});

describe("connect and disconnect one account", () => {
  test("connect with an account key stores that account and leaves the default alone", async () => {
    C.__clearAll();
    expect((await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).ok).toBe(true);
    expect((await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN }, "work")).ok).toBe(true);
    expect(C.accountsOf("jira")).toEqual([{ accountKey: "primary", isDefault: true }, { accountKey: "work", isDefault: false }]);
    expect(C.redactedAccount("jira", "work")).toMatchObject({ site: "acme.atlassian.net", deployment: "cloud", account: "Ada Example" });
  });
  test("a second account's connect and disconnect leave the default's cached boards; the default's own drop them", async () => {
    V.__setJiraViewsPath(join(dir, "jira-views.json"));
    const held = () => { V.putCache("acme.atlassian.net", "b1", { tasks: [{ id: "x" } as never], at: Date.now() } as never); };
    held();
    expect((await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN }, "work")).ok).toBe(true);
    expect(V.cachedFor("acme.atlassian.net", "b1"), "connect kept the default's board").toBeTruthy();
    await P.disconnectProvider("jira", { accountKey: "work" });
    expect(V.cachedFor("acme.atlassian.net", "b1"), "default's board kept").toBeTruthy();
    C.setCredential("jira", good, "work");
    C.__setCredentialsPath(join(dir, "creds.json"));
    await P.disconnectProvider("jira", { accountKey: "primary" });
    expect(V.cachedFor("acme.atlassian.net", "b1"), "default's board dropped").toBeFalsy();
    V.__setJiraViewsPath(null);
  });
  test("a second account's disconnect keeps the card watch's last-seen map; the default's drops it", async () => {
    const W = await import("../src/jirawatch.ts");
    const file = join(dir, "jira-watch.json");
    W.__setJiraWatchPath(file);
    W.rememberOwnMove({ id: "10042", customId: "ORBIT-1042", title: "A thing", status: "Open", updated: 1 } as never, "Done");
    expect(JSON.parse(readFileSync(file, "utf8")).seen["10042"], "seeded").toBeTruthy();
    await P.disconnectProvider("jira", { accountKey: "work" });
    expect(JSON.parse(readFileSync(file, "utf8")).seen["10042"], "the default's last-seen map kept").toBeTruthy();
    C.setCredential("jira", good, "work");
    C.__setCredentialsPath(join(dir, "creds.json"));
    await P.disconnectProvider("jira", { accountKey: "primary" });
    expect(() => readFileSync(file, "utf8"), "the default's own disconnect drops it").toThrow();
    W.__setJiraWatchPath(null);
  });
  test("a bad account name is a sentence, nothing stored", async () => {
    C.__clearAll();
    const r = await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN }, "Bad Name");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("account name") });
    expect(C.accountsOf("jira")).toEqual([]);
  });
  test("disconnecting a second account keeps the default's; the pair rows are the stored identities", async () => {
    const r = await P.disconnectProvider("jira", { accountKey: "work" });
    expect(r.ok).toBe(true);
    expect(P.accountRows("jira")).toEqual([{ accountKey: "primary", isDefault: true, site: "acme.atlassian.net", email: FAKE_EMAIL }]);
  });
});

describe("the edge in index.ts is ahead of every Jira route", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
  test("enterJiraForRepo runs before the first /jira/ route reads a card", () => {
    const edge = src.indexOf("enterJiraForRepo(jiraRepo)");
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(src.indexOf('pathname === "/jira/prs"'));
    expect(edge).toBeLessThan(src.indexOf('pathname === "/jira/status"'));
  });
  test("naming an account on /jira/connect is the person's: mayPublishReview is asked before connectJira", () => {
    const at = src.indexOf('if (pathname === "/jira/connect"');
    const b = src.slice(at, src.indexOf("connectJira({", at) + 40);
    expect(b).toContain("mayPublishReview(req, caller)");
  });
});
