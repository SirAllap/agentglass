/*
 * Named accounts per provider in the credentials file.
 *
 * What a mistake costs here: a migration that drops a token, a second account
 * that overwrites the first, a keyring item left behind by a cleared account,
 * or a cleared account that comes back from a flat key an old build left.
 * Its own directory and a fake keyring, always.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyringState, SecretBackend } from "../src/keyring.ts";

const ROOT = mkdtempSync(join(tmpdir(), "agx-accts-"));
const REAL_NODE_ENV = process.env.NODE_ENV;
const REAL_XDG = process.env.XDG_CONFIG_HOME;
process.env.NODE_ENV = "test";
process.env.XDG_CONFIG_HOME = ROOT;
const FILE = join(ROOT, "credentials.json");

const K = await import("../src/keyring.ts");
const C = await import("../src/credentials.ts");
const S = await import("../src/keyringSwitch.ts");
const { writeSecretsKeyring } = await import("../src/config.ts");

class Fake implements SecretBackend {
  items = new Map<string, string>();
  state: KeyringState = "ready";
  private hold: { arrived: () => void; gate: Promise<void> } | null = null;
  holdNextGet(): { reached: Promise<void>; release: () => void } {
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { arrived = r; });
    this.hold = { arrived, gate };
    return { reached, release };
  }
  async availability() { return this.state; }
  async get(id: string) {
    const v = this.items.get(id) ?? null;
    const h = this.hold;
    if (h) { this.hold = null; h.arrived(); await h.gate; }
    return v;
  }
  async set(id: string, v: string) { this.items.set(id, v); }
  async del(id: string) { this.items.delete(id); }
}
let fake: Fake;
const text = (): string => readFileSync(FILE, "utf8");
const disk = (): any => JSON.parse(text());
/** Forget the in-memory copy: the next read comes from the file. */
const reload = (): void => C.__setCredentialsPath(FILE);

beforeEach(() => {
  fake = new Fake();
  K.__setBackend(fake);
  C.__setCredentialsPath(FILE);
  C.__clearAll();
  expect(writeSecretsKeyring(false).ok).toBe(true);
});
afterAll(() => {
  K.__setBackend(null);
  C.__setCredentialsPath(null);
  rmSync(ROOT, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG;
  if (REAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = REAL_NODE_ENV;
});

const FLAT = { clickup: { token: "pk_1_AAA", account: "Ada" }, jira: { token: "jira-tok", site: "acme.atlassian.net" } };

describe("legacy flat file", () => {
  test("reads as primary, default primary, and does not write on load", () => {
    writeFileSync(FILE, JSON.stringify(FLAT));
    reload();
    expect(C.secretFor("clickup")).toBe("pk_1_AAA");
    expect(C.secretFor("jira", "primary")).toBe("jira-tok");
    expect(C.redacted("clickup")?.account).toBe("Ada");
    expect(JSON.parse(text()).accounts).toBeUndefined();
  });

  test("the v2 file appears on the next save, with both tokens kept", () => {
    writeFileSync(FILE, JSON.stringify(FLAT));
    reload();
    C.annotate("clickup", { workspace: "Orbit" });
    const d = disk();
    expect(d.version).toBe(2);
    expect(d.accounts.clickup.primary).toEqual({ token: "pk_1_AAA", account: "Ada", workspace: "Orbit" });
    expect(d.accounts.jira.primary.token).toBe("jira-tok");
    expect(d.defaults).toEqual({ clickup: "primary", jira: "primary" });
    expect(d.clickup, "no flat key survives a save").toBeUndefined();
  });

  test("a keyring-sealed legacy file migrates under the old keyring id and reads back", async () => {
    writeFileSync(FILE, JSON.stringify({ clickup: { token: K.KEYRING_MARK } }));
    fake.items.set("credentials/clickup", "pk_sealed");
    reload();
    await K.hydrateKeyring([K.credentialId("clickup", "primary")]);
    expect(K.credentialId("clickup", "primary")).toBe("credentials/clickup");
    expect(C.secretFor("clickup")).toBe("pk_sealed");
    C.annotate("clickup", { workspace: "Orbit" });
    reload();
    expect(C.secretFor("clickup")).toBe("pk_sealed");
  });

  test("a flat key in a v2 file with no accounts for it migrates; with accounts it is ignored and removed", () => {
    writeFileSync(FILE, JSON.stringify({ version: 2, accounts: { jira: { work: { token: "w" } } }, defaults: { jira: "work" }, jira: { token: "stale" }, clickup: { token: "pk_2" } }));
    reload();
    expect(C.secretFor("jira")).toBe("w");
    expect(C.secretFor("clickup")).toBe("pk_2");
    C.annotate("jira", { site: "x" });
    expect(disk().jira).toBeUndefined();
    expect(Object.keys(disk().accounts.jira)).toEqual(["work"]);
  });

  test("a v2 file is recognised by `accounts` even when version was turned into {}", () => {
    writeFileSync(FILE, JSON.stringify({ version: {}, accounts: { clickup: { work: { token: "t" } } }, defaults: { clickup: "work" } }));
    reload();
    expect(C.secretFor("clickup")).toBe("t");
    C.annotate("clickup", { account: "A" });
    expect(disk().version).toBe(2);
  });

  test("a stale flat jira then clearCredential: not connected after reload, no flat token on disk, fake keyring on", async () => {
    writeFileSync(FILE, JSON.stringify({ version: 2, accounts: { jira: { primary: { token: K.KEYRING_MARK } } }, defaults: { jira: "primary" }, jira: { token: "stale-plain" } }));
    fake.items.set("credentials/jira", "kr-jira");
    reload();
    await K.hydrateKeyring(["credentials/jira"]);
    expect(await writeSecretsKeyring(true)).toBeDefined();
    await C.dropCredentialSecret("jira");
    C.clearCredential("jira");
    reload();
    expect(C.hasAnyCredential("jira")).toBe(false);
    expect(text()).not.toContain("stale-plain");
    expect(fake.items.has("credentials/jira")).toBe(false);
  });
});

describe("two accounts", () => {
  test("a second account leaves the first untouched; files stay 0600", () => {
    C.setCredential("jira", { token: "a", site: "one" }, "work");
    C.setCredential("jira", { token: "b", site: "two" }, "home");
    expect(C.secretFor("jira", "work")).toBe("a");
    expect(C.secretFor("jira", "home")).toBe("b");
    expect(C.secretFor("jira"), "the first connect keeps the pointer").toBe("a");
    expect(statSync(FILE).mode & 0o777).toBe(0o600);
    expect(C.accountsOf("jira")).toEqual([{ accountKey: "work", isDefault: true }, { accountKey: "home", isDefault: false }]);
  });

  test("redacted keeps today's exact shape; redactedAccount adds the key; neither carries the token", () => {
    C.setCredential("clickup", { token: "pk_SECRET", account: "Ada", workspace: "Orbit", verifiedAt: 5 });
    expect(C.redacted("clickup")).toEqual({ account: "Ada", workspace: "Orbit", verifiedAt: 5, present: true });
    expect(C.redactedAccount("clickup")).toEqual({ account: "Ada", workspace: "Orbit", verifiedAt: 5, present: true, accountKey: "primary" });
    expect(JSON.stringify([C.redacted("clickup"), C.redactedAccount("clickup", "primary")])).not.toContain("pk_SECRET");
    expect(C.redacted("jira")).toBeNull();
  });

  test("clear one of two removes only its keyring item and moves the pointer", async () => {
    expect(await writeSecretsKeyring(true)).toBeDefined();
    await C.storeCredential("jira", { token: "a" }, "primary");
    await C.storeCredential("jira", { token: "b" }, "work");
    expect([...fake.items.keys()].sort()).toEqual(["credentials/jira", "credentials/jira/work"]);
    await C.dropCredentialSecret("jira", "primary");
    C.clearCredential("jira", "primary");
    expect([...fake.items.keys()]).toEqual(["credentials/jira/work"]);
    expect(C.secretFor("jira")).toBe("b");
    expect(disk().defaults.jira).toBe("work");
  });

  test("omitted-account cases: none, only one, pointer, several without a pointer", () => {
    expect(C.secretFor("jira")).toBeNull();
    C.setCredential("jira", { token: "a" });
    expect(C.accountsOf("jira")[0]!.accountKey).toBe("primary");
    C.setCredential("jira", { token: "b" }, "work");
    C.setDefaultAccount("jira", "work");
    expect(C.secretFor("jira")).toBe("b");
    expect(() => C.setDefaultAccount("jira", "nope")).toThrow();
    // Break the pointer on disk: several accounts, nothing to choose.
    const d = disk(); delete d.defaults; writeFileSync(FILE, JSON.stringify(d)); reload();
    expect(C.secretFor("jira")).toBeNull();
    expect(C.redacted("jira")).toBeNull();
    expect(() => C.setCredential("jira", { token: "c" })).toThrow(/name the account/);
    expect(() => C.clearCredential("jira")).toThrow(/name the account/);
    expect(C.hasAnyCredential("jira")).toBe(true);
  });

  test("with nothing stored, drop and clear are quiet no-ops as before", async () => {
    await C.dropCredentialSecret("jira");
    C.clearCredential("jira");
    expect(C.hasAnyCredential("jira")).toBe(false);
  });

  test("a bad account name is refused; credentialId with no key throws", () => {
    expect(() => C.setCredential("jira", { token: "a" }, "Bad Name")).toThrow();
    expect(() => (K.credentialId as (p: string, k?: string) => string)("jira")).toThrow();
  });

  test("hasAnyCredential reads false under a locked keyring, like hasCredential", () => {
    writeFileSync(FILE, JSON.stringify({ clickup: { token: K.KEYRING_MARK } }));
    reload();
    K.__setBackend(fake);
    expect(C.hasCredential("clickup")).toBe(false);
    expect(C.hasAnyCredential("clickup")).toBe(false);
    expect(C.hasStoredCredential("clickup")).toBe(true);
  });
});

describe("the lock", () => {
  test("store B while A is being annotated: both end in the file", async () => {
    C.setCredential("jira", { token: "a" }, "work");
    const h = fake.holdNextGet();
    expect(await writeSecretsKeyring(true)).toBeDefined();
    const storing = C.storeCredential("jira", { token: "b" }, "home");
    await h.reached;
    C.annotate("jira", { account: "Ada" }, "work");
    h.release();
    await storing;
    expect(disk().accounts.jira.work.account).toBe("Ada");
    expect(Object.keys(disk().accounts.jira).sort()).toEqual(["home", "work"]);
  });

  test("clear B while B is being saved: throws and puts the keyring back", async () => {
    expect(await writeSecretsKeyring(true)).toBeDefined();
    await C.storeCredential("jira", { token: "old" }, "work");
    const h = fake.holdNextGet();
    const storing = C.storeCredential("jira", { token: "new" }, "work");
    const caught = storing.then(() => null, (e: Error) => e);
    await h.reached;
    C.clearCredential("jira", "work");
    h.release();
    expect((await caught)?.message).toMatch(/account removed while saving/);
    expect(C.accountsOf("jira")).toEqual([]);
    expect(fake.items.get("credentials/jira/work"), "restored to what it was").toBe("old");
  });

  test("pointer race: an omitted store that resolved to primary does not take the pointer from an explicit one that saved first", async () => {
    // Keyring off: the omitted call resolves `primary` before its first await,
    // then a synchronous explicit write saves and takes the pointer.
    const omitted = C.storeCredential("jira", { token: "p" });
    C.setCredential("jira", { token: "w" }, "work");
    await omitted;
    expect(disk().defaults.jira).toBe("work");
    expect(Object.keys(disk().accounts.jira).sort()).toEqual(["primary", "work"]);
  });
});

describe("rewriteSecrets and the keyring switch", () => {
  test("round trip with two accounts: on then off keeps both tokens", async () => {
    C.setCredential("jira", { token: "a" });
    C.setCredential("jira", { token: "b" }, "work");
    expect(await S.setKeyringEnabled(true)).toEqual({ ok: true, moved: 2 });
    expect(text()).not.toContain('"a"');
    expect(fake.items.get("credentials/jira")).toBe("a");
    expect(fake.items.get("credentials/jira/work")).toBe("b");
    expect(C.secretFor("jira", "work")).toBe("b");
    expect(await S.setKeyringEnabled(false)).toEqual({ ok: true, moved: 2 });
    expect(fake.items.size).toBe(0);
    reload();
    expect(C.secretFor("jira")).toBe("a");
    expect(C.secretFor("jira", "work")).toBe("b");
  });

  test("a failing write leaves the nested file as it was", () => {
    C.setCredential("jira", { token: "a" });
    C.setCredential("jira", { token: "b" }, "work");
    const before = text();
    C.__setCredentialsPath(join(ROOT, "no", "such", "\0bad"));
    expect(C.rewriteSecrets(new Map([["credentials/jira", "X"]]))).toBe(false);
    C.__setCredentialsPath(FILE);
    expect(text()).toBe(before);
  });
});

describe("callers of the writers turn a throw into a message", () => {
  const src = (f: string): Promise<string> => Bun.file(new URL(`../src/${f}`, import.meta.url)).text();
  // The text between `try {` and its `catch` that holds the call, per caller.
  const guarded = (code: string, call: string): boolean => {
    const i = code.indexOf(call);
    const t = code.lastIndexOf("try {", i);
    return i > 0 && t > 0 && code.indexOf("catch", i) > i && code.indexOf("catch", i) - i < 400;
  };
  test("connect (providers.ts) and Jira connect keep storeCredential inside try/catch", async () => {
    expect(guarded(await src("providers.ts"), "await storeCredential(id,")).toBe(true);
    expect(guarded(await src("jira.ts"), 'await storeCredential("jira"')).toBe(true);
  });
  test("disconnect keeps dropCredentialSecret inside try/catch", async () => {
    expect(guarded(await src("providers.ts"), "await dropCredentialSecret(id, o.accountKey)")).toBe(true);
  });
});

describe("review fixes on the named-accounts store", () => {
  test("`primary` is reserved: refused beside other accounts, fine alone or when it exists", async () => {
    C.setCredential("jira", { token: "a" }, "work");
    const before = text();
    expect(() => C.setCredential("jira", { token: "b" }, "primary")).toThrow(/reserved/);
    await expect((async () => C.storeCredential("jira", { token: "b" }, "primary"))()).rejects.toThrow(/reserved/);
    expect(text()).toBe(before);
    C.setCredential("clickup", { token: "c" }, "primary");
    C.setCredential("clickup", { token: "d" }, "primary");
    expect(C.secretFor("clickup", "primary")).toBe("d");
  });

  test("a failed rewrite puts the old flat file back byte for byte", () => {
    const flat = '{"jira":   {"token":"jira-tok"},\n "clickup":{"token":"pk_1_AAA"}}';
    writeFileSync(FILE, flat);
    reload();
    // A token that is not a string is written, then does not read back: the write landed and must be undone.
    expect(C.rewriteSecrets(new Map([["credentials/jira", 5 as unknown as string]]))).toBe(false);
    expect(text()).toBe(flat);
    reload();
    expect(C.secretFor("jira")).toBe("jira-tok");
  });

  test("an unreadable entry survives a save, and its token is not logged", () => {
    const seen: string[] = [];
    const warn = console.warn; console.warn = (m: string) => { seen.push(String(m)); };
    try {
      writeFileSync(FILE, JSON.stringify({ version: 2, accounts: { jira: { Work: { token: "tok-upper" }, odd: { token: 5 }, ok: { token: "t2" } } }, defaults: { jira: "ok" }, clickup: { token: 7 } }));
      reload();
      expect(C.secretFor("jira")).toBe("t2");
    } finally { console.warn = warn; }
    expect(seen.join("\n")).not.toContain("tok-upper");
    C.setCredential("jira", { token: "t3" }, "home");
    const d = disk();
    expect(d.accounts.jira.Work).toEqual({ token: "tok-upper" });
    expect(d.accounts.jira.odd).toEqual({ token: 5 });
    expect(d.clickup).toEqual({ token: 7 });
    expect(Object.keys(d.accounts.jira).sort()).toEqual(["Work", "home", "odd", "ok"]);
  });

  test("disconnect clears the account it dropped, even if the pointer moved", async () => {
    C.setCredential("jira", { token: "a" }, "work");
    C.setCredential("jira", { token: "b" }, "home");
    const dropped = await C.dropCredentialSecret("jira");
    expect(dropped).toBe("work");
    C.setDefaultAccount("jira", "home");
    C.clearCredential("jira", dropped ?? undefined);
    expect(C.accountsOf("jira").map((a) => a.accountKey)).toEqual(["home"]);
    expect(C.secretFor("jira")).toBe("b");
  });
});
