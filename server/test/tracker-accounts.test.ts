/*
 * The repo-to-account map. A choice that names an account nobody stored must
 * read as missing, never as the default: a repository that asked for the work
 * account must not quietly use the personal one.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-tracc-"));
const C = await import("../src/credentials.ts");
const T = await import("../src/trackerAccounts.ts");
const MAP = join(dir, "tracker-accounts.json");

beforeEach(() => {
  C.__setCredentialsPath(join(dir, "credentials.json")); C.__clearAll();
  T.__setTrackerAccountsPath(MAP);
  rmSync(MAP, { force: true });
  C.setCredential("jira", { token: "a" }, "work");
  C.setCredential("jira", { token: "b" }, "home");
});
afterAll(() => { T.__setTrackerAccountsPath(null); C.__setCredentialsPath(null); rmSync(dir, { recursive: true, force: true }); });

describe("accountFor", () => {
  // The five outcomes a caller can meet. Each asserts what the caller ends up using.
  test("no map entry: key null, the caller uses the default account", () => {
    expect(T.accountFor("acme/orbit", "jira")).toEqual({ key: null });
    expect(C.secretFor("jira")).toBe("a");
  });

  test("dangling entry: the named account is gone, reads as missing, never the default", () => {
    T.setAccountFor("acme/orbit", "jira", "home");
    C.clearCredential("jira", "home");
    expect(T.accountFor("acme/orbit", "jira"), "never the default").toEqual({ key: "home", missing: true });
  });

  test("one account: a stored entry resolves to it, and the file holds the lowercased repo", () => {
    C.clearCredential("jira", "home");
    expect(T.setAccountFor("Acme/Orbit", "jira", "work")).toMatchObject({ ok: true });
    expect(T.accountFor("acme/orbit", "jira")).toEqual({ key: "work" });
    expect(JSON.parse(readFileSync(MAP, "utf8"))).toEqual({ "acme/orbit": { jira: "work" } });
  });

  test("two accounts with a default: an entry for the other one wins over the default", () => {
    expect(C.accountsOf("jira")).toEqual([{ accountKey: "work", isDefault: true }, { accountKey: "home", isDefault: false }]);
    T.setAccountFor("acme/orbit", "jira", "home");
    expect(T.accountFor("acme/orbit", "jira")).toEqual({ key: "home" });
    expect(C.secretFor("jira", "home")).toBe("b");
  });

  test("two accounts without a default: no entry resolves to nothing, an entry still resolves", () => {
    const f = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
    delete f.defaults; writeFileSync(join(dir, "credentials.json"), JSON.stringify(f));
    C.__setCredentialsPath(join(dir, "credentials.json"));
    expect(T.accountFor("acme/orbit", "jira")).toEqual({ key: null });
    expect(C.secretFor("jira"), "nothing to choose").toBeNull();
    expect(T.setAccountFor("acme/orbit", "jira", "home")).toMatchObject({ ok: true });
    expect(T.accountFor("acme/orbit", "jira")).toEqual({ key: "home" });
  });

  test("null removes, and an emptied repo leaves no entry", () => {
    T.setAccountFor("acme/orbit", "jira", "work");
    expect(T.setAccountFor("acme/orbit", "jira", null)).toEqual({ ok: true, accounts: {} });
    expect(JSON.parse(readFileSync(MAP, "utf8"))).toEqual({});
  });

  test("primary is storable when it exists; an unstored key is refused", () => {
    expect(T.setAccountFor("acme/orbit", "jira", "primary")).toMatchObject({ ok: false });
    expect(T.setAccountFor("acme/orbit", "jira", "nope")).toMatchObject({ ok: false });
    C.setCredential("clickup", { token: "t" });
    expect(T.setAccountFor("acme/orbit", "clickup", "primary")).toMatchObject({ ok: true });
  });

  test("bad repo, provider and value are refused; bad values in a hand-edited file are dropped", () => {
    expect(T.setAccountFor("orbit", "jira", "work")).toMatchObject({ ok: false });
    expect(T.setAccountFor("acme/orbit", "trello", "work")).toMatchObject({ ok: false });
    expect(T.setAccountFor("acme/orbit", "jira", "Bad Key")).toMatchObject({ ok: false });
    writeFileSync(MAP, JSON.stringify({ "acme/orbit": { jira: "Bad Key", clickup: 7, trello: "x" }, "nope": { jira: "work" }, "acme/ok": { jira: "work" } }));
    expect(T.trackerAccounts()).toEqual({ "acme/ok": { jira: "work" } });
  });

  test("a broken file is an empty map", () => {
    writeFileSync(MAP, "{not json");
    expect(T.accountFor("acme/orbit", "jira")).toEqual({ key: null });
  });

  test("the cache follows the file when it changes under it", () => {
    T.setAccountFor("acme/orbit", "jira", "work");
    expect(T.accountFor("acme/orbit", "jira").key).toBe("work");
    writeFileSync(MAP, JSON.stringify({ "acme/orbit": { jira: "home" }, "acme/pad": { jira: "home" } }));
    expect(T.accountFor("acme/orbit", "jira").key).toBe("home");
  });
});

describe("the seam guard", () => {
  test("with the seam unset under NODE_ENV=test, a call throws instead of touching ~/.config", () => {
    T.__setTrackerAccountsPath(null);
    expect(process.env.NODE_ENV).toBe("test");
    expect(() => T.accountFor("acme/orbit", "jira")).toThrow(/no test path/);
    expect(() => T.setAccountFor("acme/orbit", "jira", "work")).toThrow(/no test path/);
  });
});

describe("one repo pattern, one ceiling", () => {
  test("trackerAccounts imports them from trackerProjects and keeps no copy", async () => {
    const P = await import("../src/trackerProjects.ts");
    expect(P.REPO.test("acme/orbit")).toBe(true);
    expect(P.MAX_ENTRIES).toBe(500);
    const src = await Bun.file(new URL("../src/trackerAccounts.ts", import.meta.url)).text();
    expect(src).toMatch(/import \{[^}]*\bREPO\b[^}]*\} from "\.\/trackerProjects\.ts"/);
    expect(src).not.toMatch(/^const (REPO|MAX_ENTRIES)\b/m);
  });
});
