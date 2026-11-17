/*
 * What a settings page reads and does about accounts: the list (identity, never
 * a token), the default pointer, and the repo map. Tokens here are fakes.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-pacc-"));
const C = await import("../src/credentials.ts");
const T = await import("../src/trackerAccounts.ts");
const P = await import("../src/providers.ts");

beforeEach(() => {
  C.__setCredentialsPath(join(dir, "credentials.json")); C.__clearAll();
  T.__setTrackerAccountsPath(join(dir, "tracker-accounts.json"));
  rmSync(join(dir, "tracker-accounts.json"), { force: true });
  C.setCredential("clickup", { token: "pk_fake_default", account: "Ada", workspace: "Orbit" }, "primary");
  C.setCredential("clickup", { token: "pk_fake_work", account: "Ada Work", workspace: "Orbit Two" }, "work");
});
afterAll(() => { T.__setTrackerAccountsPath(null); C.__setCredentialsPath(null); rmSync(dir, { recursive: true, force: true }); });

describe("accountRows", () => {
  test("lists identity, default first, and no token anywhere", () => {
    const rows = P.accountRows("clickup");
    expect(rows.map((r) => [r.accountKey, r.isDefault, r.account])).toEqual([["primary", true, "Ada"], ["work", false, "Ada Work"]]);
    expect(JSON.stringify(rows)).not.toContain("pk_fake");
  });
  test("a provider with nothing stored lists nothing", () => expect(P.accountRows("jira")).toEqual([]));
});

describe("makeDefaultAccount", () => {
  test("moves the default and the list follows", () => {
    const r = P.makeDefaultAccount("clickup", "work");
    expect(r.ok).toBe(true);
    expect(P.accountRows("clickup")[0]!.accountKey).toBe("work");
  });
  test("an unknown account is a sentence and changes nothing", () => {
    expect(P.makeDefaultAccount("clickup", "nope")).toEqual({ ok: false, error: "No account called nope" });
    expect(P.accountRows("clickup")[0]!.accountKey).toBe("primary");
  });
});

describe("repo map as the page writes it", () => {
  test("set, read back, and clear with null", () => {
    expect(T.setAccountFor("acme/orbit", "clickup", "work").ok).toBe(true);
    expect(T.trackerAccounts()["acme/orbit"]).toEqual({ clickup: "work" });
    expect(T.setAccountFor("acme/orbit", "clickup", null).ok).toBe(true);
    expect(T.trackerAccounts()).toEqual({});
  });
  test("an account that is not stored is refused", () => {
    const r = T.setAccountFor("acme/orbit", "clickup", "ghost");
    expect(r).toEqual({ ok: false, error: "no account called ghost" });
  });
});
