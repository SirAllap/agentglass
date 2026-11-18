/*
 * ClickUp reads and writes for a repo go out with that repo's account, and a
 * repo whose account is gone is "not connected", never the default account.
 * Tokens here are fakes; the stub ClickUp records which one each call carried.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-cuacc-"));
const C = await import("../src/credentials.ts");
const T = await import("../src/trackerAccounts.ts");
const A = await import("../src/clickupAccount.ts");
const K = await import("../src/clickup.ts");
const P = await import("../src/providers.ts");
const V = await import("../src/clickupviews.ts");

const seen: { path: string; auth: string }[] = [];
const spaceOf: Record<string, string> = { pk_default: "s-default", pk_work: "s-work" };
const stub = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const auth = req.headers.get("authorization") ?? "";
    seen.push({ path, auth });
    if (path === "/user") return Response.json({ user: { id: 7, username: auth === "pk_work" ? "Work Ada" : "Ada", email: "ada@example.com" } });
    if (path === "/team") return Response.json({ teams: [{ id: "9001", name: "Orbit" }] });
    if (path.startsWith("/task/")) return Response.json({ space: { id: spaceOf[auth] } });
    if (path.startsWith("/space/")) return Response.json({ tags: [{ name: `tag-of-${spaceOf[auth]}` }] });
    return Response.json({});
  },
});

beforeEach(() => {
  C.__setCredentialsPath(join(dir, "credentials.json")); C.__clearAll();
  T.__setTrackerAccountsPath(join(dir, "tracker-accounts.json"));
  rmSync(join(dir, "tracker-accounts.json"), { force: true });
  K.__setClickUpBase(`http://localhost:${stub.port}`);
  K.forgetAll();
  V.__setViewsPath(join(dir, "views.json"));
  seen.length = 0;
  C.setCredential("clickup", { token: "pk_default", workspaceId: "9001", accountId: "7" }, "primary");
  C.setCredential("clickup", { token: "pk_work", workspaceId: "9001", accountId: "8" }, "work");
});
afterAll(() => { V.__setViewsPath(null); stub.stop(true); K.__setClickUpBase(null); T.__setTrackerAccountsPath(null); C.__setCredentialsPath(null); rmSync(dir, { recursive: true, force: true }); });

describe("route edge: repo to account", () => {
  test("no entry: nothing entered, the default account is used", () => {
    expect(A.enterForRepo("acme/orbit")).toBeNull();
    expect(A.clickupAccount()).toBeUndefined();
  });
  test("an entry enters its account; a missing one answers a sentence naming it", async () => {
    T.setAccountFor("acme/orbit", "clickup", "work");
    C.clearCredential("clickup", "work");
    expect(A.enterForRepo("acme/orbit")).toEqual({ ok: false, error: 'The ClickUp account "work" chosen for acme/orbit is not connected' });
    expect(A.clickupAccount(), "never entered").toBeUndefined();
  });
  test("no repo on the request: nothing to do", () => { expect(A.enterForRepo(null)).toBeNull(); });
});

describe("clickup.ts calls carry the scoped account", () => {
  test("a read inside a scope uses that account's token, outside it the default's", async () => {
    await A.inClickupAccount("work", () => K.commentsOn("t1"));
    await K.commentsOn("t2");
    expect(seen.map((s) => [s.path, s.auth])).toEqual([["/task/t1/comment", "pk_work"], ["/task/t2/comment", "pk_default"]]);
  });
  test("an account with no token says so by name and sends nothing", async () => {
    const r = await A.inClickupAccount("ghost", () => K.commentsOn("t1"));
    expect(r).toMatchObject({ ok: false, error: 'The ClickUp account "ghost" is not connected' });
    expect(seen).toEqual([]);
  });
  test("the default account's message is unchanged", async () => {
    C.clearCredential("clickup", "work"); C.clearCredential("clickup", "primary");
    expect(await K.commentsOn("t1")).toMatchObject({ ok: false, error: "ClickUp is not connected" });
  });
  test("caches keyed by id alone are keyed by account too", async () => {
    // Same task id and space id asked as two accounts: each gets its own space's tags.
    const w = await A.inClickupAccount("work", () => K.tagsForTask("t1"));
    const d = await K.tagsForTask("t1");
    expect(w.data).toEqual(["tag-of-s-work"]);
    expect(d.data).toEqual(["tag-of-s-default"]);
  });
});

describe("connect and disconnect one account", () => {
  test("connect with accountKey stores that account and leaves the default alone", async () => {
    C.__clearAll();
    expect((await P.connectProvider("clickup", "pk_default")).ok).toBe(true);
    const r = await P.connectProvider("clickup", "pk_work", "work");
    expect(r.ok).toBe(true);
    expect(C.accountsOf("clickup")).toEqual([{ accountKey: "primary", isDefault: true }, { accountKey: "work", isDefault: false }]);
    expect(C.secretFor("clickup")).toBe("pk_default");
    expect(C.secretFor("clickup", "work")).toBe("pk_work");
  });
  test("a person-named account may not be called primary: one sentence, nothing stored", async () => {
    C.__clearAll();
    await P.connectProvider("clickup", "pk_work", "work");
    const r = await P.connectProvider("clickup", "pk_default", "primary");
    expect(r).toMatchObject({ ok: false, error: '"primary" is reserved: choose another account name' });
    expect(C.accountsOf("clickup")).toEqual([{ accountKey: "work", isDefault: true }]);
  });
  test("a bad account name is a sentence, not a 500", async () => {
    expect(await P.connectProvider("clickup", "pk_work", "Bad Name")).toMatchObject({ ok: false, error: expect.stringContaining("account name") });
  });
  test("disconnect with accountKey removes only that account", async () => {
    const r = await P.disconnectProvider("clickup", { accountKey: "work" });
    expect(r.ok).toBe(true);
    expect(C.accountsOf("clickup")).toEqual([{ accountKey: "primary", isDefault: true }]);
  });
  test("disconnecting a non-default account keeps the default's cached boards; disconnecting the default drops them", async () => {
    const view = { id: "v1", name: "Board", url: "https://app.clickup.com/1/v/l/v1", addedAt: 0 };
    V.addView(view);
    const put = () => V.putCache({ view, tasks: [{ id: "x" } as never], statuses: [], fields: [], at: Date.now() });
    put();
    await P.disconnectProvider("clickup", { accountKey: "work" });
    expect(V.cachedFor("v1")?.tasks.length, "default's board kept").toBe(1);
    C.setCredential("clickup", { token: "pk_work" }, "work");
    await P.disconnectProvider("clickup", { accountKey: "primary" });
    expect(V.cachedFor("v1"), "default's board dropped").toBeFalsy();
  });
  test("disconnect with no key, several accounts and no default: a sentence, not a throw", async () => {
    C.__clearAll();
    C.setCredential("clickup", { token: "a" }, "work"); C.setCredential("clickup", { token: "b" }, "home");
    C.clearCredential("clickup", "work"); C.setCredential("clickup", { token: "c" }, "work"); // pointer now unset with two accounts
    const st = JSON.parse(require("node:fs").readFileSync(join(dir, "credentials.json"), "utf8"));
    if (st.defaults) delete st.defaults.clickup;
    require("node:fs").writeFileSync(join(dir, "credentials.json"), JSON.stringify(st));
    C.__setCredentialsPath(join(dir, "credentials.json"));
    const r = await P.disconnectProvider("clickup");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("name the account");
  });
});
