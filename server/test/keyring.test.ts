/*
 * Keeping the stored secrets in the system keyring instead of 0600 files.
 *
 * The keyring here is a fake with the three ways the real one goes wrong: it is
 * locked, it fails on the Nth write, and it hands back something other than what
 * it was given. Nothing in this file touches a real keyring, a real config
 * directory or a real token (the value below is shaped like one and is not).
 *
 * What is asserted is the promise: with it on, no file holds the secret; with it
 * off, the keyring holds nothing; and whatever goes wrong in between leaves the
 * secret in at least one of the two places, with the files exactly as they were.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyringState, SecretBackend } from "../src/keyring.ts";

const ROOT = mkdtempSync(join(tmpdir(), "agx-keyring-"));
const REAL_XDG = process.env.XDG_CONFIG_HOME;
const REAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = "test";
process.env.XDG_CONFIG_HOME = ROOT;

const K = await import("../src/keyring.ts");
const S = await import("../src/keyringSwitch.ts");
const C = await import("../src/credentials.ts");
const P = await import("../src/plugins.ts");
const { serverSettingDefs } = await import("../src/serverSettings.ts");
const { makeDoor } = await import("../src/settingsDoor.ts");
const { keyringEnabled } = K;
const { writeSecretsKeyring } = await import("../src/config.ts");
const { agentVerdict, classOf } = await import("../../shared/settingClass.ts");

const TOKEN = "orbit-test-token-0000";
const KEY = "tk-orbit-1042-not-a-real-key";
const CRED_FILE = join(ROOT, "credentials.json");

class FakeKeyring implements SecretBackend {
  items = new Map<string, string>();
  state: KeyringState = "ready";
  /** Throw on the Nth `set` (1-based) from now. */
  failSetOn = 0;
  /** `get` answers this instead of what is stored. */
  lie: string | null = null;
  /** After the next `set`, `get` answers this instead of what was stored. */
  lieAfterSet: string | null = null;
  sets = 0;
  /** `get` fails with a plain error while the keyring still says it is ready. */
  failGet = false;
  private hold: { arrived: () => void; gate: Promise<void> } | null = null;
  /** The next `get` reads its answer, then waits: whatever the test does before
   *  `release` happens while that read is in flight. `reached` resolves on arrival. */
  holdNextGet(): { reached: Promise<void>; release: () => void } {
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { arrived = r; });
    this.hold = { arrived, gate };
    return { reached, release };
  }
  async availability() { return this.state; }
  private need() { if (this.state !== "ready") throw new K.KeyringError(this.state, `keyring ${this.state}`); }
  async get(id: string) {
    this.need();
    if (this.failGet) throw new Error("the keyring broke");
    const v = this.lie ?? this.items.get(id) ?? null;
    const h = this.hold;
    if (h) { this.hold = null; h.arrived(); await h.gate; }
    return v;
  }
  async set(id: string, v: string) {
    this.need();
    if (this.failSetOn && ++this.sets === this.failSetOn) throw new Error("the keyring refused the write");
    this.items.set(id, v);
    if (this.lieAfterSet !== null) this.lie = this.lieAfterSet;
  }
  async del(id: string) { this.need(); this.items.delete(id); }
}

const manifest = {
  name: "orbit-scorer", publisher: "acme", description: "Needs a key.", entrypoint: "true", scope: "read",
  contributes: { settings: [{ key: "apiKey", type: "secret", label: "Key" }] },
};
function fixture(): string {
  const dir = mkdtempSync(join(ROOT, "src-"));
  writeFileSync(join(dir, P.MANIFEST_NAME), JSON.stringify(manifest));
  writeFileSync(join(dir, "run.sh"), "#!/bin/bash\ntrue\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  return dir;
}

let fake: FakeKeyring;
const text = (p: string): string => readFileSync(p, "utf8");
const CONFIG_FILE = join(ROOT, "agentglass", "config.json");
const INDEX_SRC = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
/** The invariant of the whole feature: each secret is in a file or in the keyring. */
function everySecretKept(): void {
  const all = files();
  const kept = (id: string, v: string): boolean => fake.items.get(id) === v || all.includes(v);
  expect(kept("credentials/clickup", TOKEN), "the token is in neither place").toBe(true);
  expect(kept("plugin/orbit-scorer/apiKey", KEY), "the key is in neither place").toBe(true);
}
/** Run `during` while the next keyring read is in flight, then let the read finish. */
async function whileReading<T>(during: () => void | Promise<void>, started: () => Promise<T>): Promise<T> {
  const h = fake.holdNextGet();
  const running = started();
  await h.reached;
  try { await during(); } finally { h.release(); }
  return running;
}
const files = (): string => text(CRED_FILE) + text(P.secretsPath());
const config = (): { secretsKeyring?: boolean } => { try { return JSON.parse(text(join(ROOT, "agentglass", "config.json"))); } catch { return {}; } };

beforeEach(async () => {
  fake = new FakeKeyring();
  K.__setBackend(fake);
  C.__setCredentialsPath(CRED_FILE);
  C.__clearAll();
  await P.__resetPlugins();
  expect(writeSecretsKeyring(false).ok).toBe(true);
  expect((await P.installPlugin(fixture())).ok).toBe(true);
  C.setCredential("clickup", { token: TOKEN, account: "Ada" });
  expect(P.setPluginSettings("orbit-scorer", { apiKey: KEY }).ok).toBe(true);
});
afterEach(async () => {
  await P.__resetPlugins();
});
afterAll(() => {
  K.__setBackend(null);
  C.__setCredentialsPath(null);
  rmSync(ROOT, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG;
  if (REAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = REAL_NODE_ENV;
});

describe("turning it on and off", () => {
  test("on: both secrets move, no file holds either, and the readers still get them", async () => {
    const r = await S.setKeyringEnabled(true);
    expect(r).toEqual({ ok: true, moved: 2 });
    expect(files(), "a secret was left in a file").not.toContain(TOKEN);
    expect(files(), "a key was left in a file").not.toContain(KEY);
    expect(text(CRED_FILE)).toContain(K.KEYRING_MARK);
    expect(fake.items.get("credentials/clickup")).toBe(TOKEN);
    expect(fake.items.get("plugin/orbit-scorer/apiKey")).toBe(KEY);
    expect(C.secretFor("clickup")).toBe(TOKEN);
    expect(P.pluginOwnSettings("orbit-scorer").apiKey).toBe(KEY);
    expect(config().secretsKeyring).toBe(true);
    expect(keyringEnabled()).toBe(true);
  });

  test("the files keep their mode 0600 across the move", async () => {
    await S.setKeyringEnabled(true);
    expect(statSync(CRED_FILE).mode & 0o777).toBe(0o600);
    expect(statSync(P.secretsPath()).mode & 0o777).toBe(0o600);
  });

  test("off: the values are back in both files and the keyring holds nothing", async () => {
    await S.setKeyringEnabled(true);
    const r = await S.setKeyringEnabled(false);
    expect(r).toEqual({ ok: true, moved: 2 });
    expect(text(CRED_FILE)).toContain(TOKEN);
    expect(text(P.secretsPath())).toContain(KEY);
    expect(files()).not.toContain(K.KEYRING_MARK);
    expect(fake.items.size, "the keyring still holds a copy").toBe(0);
    expect(C.secretFor("clickup")).toBe(TOKEN);
    expect(P.pluginOwnSettings("orbit-scorer").apiKey).toBe(KEY);
    expect(config().secretsKeyring).toBe(false);
  });

  test("on twice moves nothing the second time and loses nothing", async () => {
    await S.setKeyringEnabled(true);
    expect(await S.setKeyringEnabled(true)).toEqual({ ok: true, moved: 0 });
    expect(C.secretFor("clickup")).toBe(TOKEN);
    expect(fake.items.size).toBe(2);
  });
});

describe("two things at once", () => {
  test("a token stored while the move runs is not lost, and is sealed too", async () => {
    // Without the queue the store read the files before the move and wrote them
    // back after it, with a plain token and the old marks.
    const [moved, stored] = await Promise.all([S.setKeyringEnabled(true), C.storeCredential("jira", { token: "jt-orbit-7" }).then(() => true, () => false)]);
    expect(moved.ok).toBe(true);
    expect(stored).toBe(true);
    expect(C.secretFor("jira")).toBe("jt-orbit-7");
    expect(C.secretFor("clickup")).toBe(TOKEN);
    expect(files()).not.toContain("jt-orbit-7");
    expect(files()).not.toContain(TOKEN);
  });

  test("a key saved while the move off runs is not lost", async () => {
    await S.setKeyringEnabled(true);
    const [moved, saved] = await Promise.all([S.setKeyringEnabled(false), P.savePluginSettings("orbit-scorer", { apiKey: "tk-orbit-new" })]);
    expect(moved.ok && saved.ok).toBe(true);
    expect(P.pluginOwnSettings("orbit-scorer").apiKey).toBe("tk-orbit-new");
    expect(text(P.secretsPath())).toContain("tk-orbit-new");
    expect(fake.items.size).toBe(0);
  });

  // The two tests above start both calls in the same tick, so a store that
  // skipped the queue still ran before the move had read anything. These hold
  // the move after it has read the files, which is where the queue earns it.
  test("a token stored after the move has read the files waits for it, and is sealed", async () => {
    let stored: Promise<boolean> | undefined;
    const moved = await whileReading(async () => {
      stored = C.storeCredential("jira", { token: "jt-orbit-7" }).then(() => true, () => false);
      await Bun.sleep(20);
    }, () => S.setKeyringEnabled(true));
    expect(moved.ok).toBe(true);
    expect(await stored).toBe(true);
    expect(C.secretFor("jira")).toBe("jt-orbit-7");
    expect(files(), "the token landed in a file after the move").not.toContain("jt-orbit-7");
    expect(fake.items.get("credentials/jira")).toBe("jt-orbit-7");
  });

  test("a key saved after the move off has read the files waits for it, and survives", async () => {
    await S.setKeyringEnabled(true);
    let saved: ReturnType<typeof P.savePluginSettings> | undefined;
    const moved = await whileReading(async () => {
      saved = P.savePluginSettings("orbit-scorer", { apiKey: "tk-orbit-new" });
      await Bun.sleep(20);
    }, () => S.setKeyringEnabled(false));
    expect(moved.ok && (await saved!).ok).toBe(true);
    expect(P.pluginOwnSettings("orbit-scorer").apiKey).toBe("tk-orbit-new");
    expect(text(P.secretsPath())).toContain("tk-orbit-new");
    expect(text(P.secretsPath())).not.toContain(K.KEYRING_MARK);
  });

  test("a token stored while a rehydrate is reading is not overwritten by the older value", async () => {
    await S.setKeyringEnabled(true);
    K.__setBackend(fake);          // a new process: nothing held
    await whileReading(async () => { await C.storeCredential("clickup", { token: "pk-orbit-NEW" }); }, () => S.rehydrate());
    expect(fake.items.get("credentials/clickup")).toBe("pk-orbit-NEW");
    expect(C.secretFor("clickup"), "the process went on with the token it read before the store").toBe("pk-orbit-NEW");
  });

  test("the credentials file is replaced whole: no temp file is left", async () => {
    await C.storeCredential("jira", { token: "jt-orbit-7" });
    expect(readdirSync(ROOT).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("a move that goes wrong", () => {
  test("the second write fails: files byte-for-byte as they were, keyring emptied, switch off", async () => {
    const before = [text(CRED_FILE), text(P.secretsPath())];
    fake.failSetOn = 2;
    const r = await S.setKeyringEnabled(true);
    expect(r.ok).toBe(false);
    expect([text(CRED_FILE), text(P.secretsPath())]).toEqual(before);
    expect(fake.items.size, "a half-written keyring was left behind").toBe(0);
    expect(keyringEnabled()).toBe(false);
    expect(C.secretFor("clickup")).toBe(TOKEN);
  });

  test("the keyring hands back something else: nothing moves", async () => {
    const before = [text(CRED_FILE), text(P.secretsPath())];
    fake.lie = "not what was stored";
    const r = await S.setKeyringEnabled(true);
    expect(r.ok && "it said ok over a mismatch").toBe(false);
    expect([text(CRED_FILE), text(P.secretsPath())]).toEqual(before);
    expect(keyringEnabled()).toBe(false);
  });

  test("a locked keyring refuses the switch with the reason and touches nothing", async () => {
    const before = [text(CRED_FILE), text(P.secretsPath())];
    fake.state = "locked";
    expect(await S.setKeyringEnabled(true)).toEqual({ ok: false, error: "keyring locked" });
    fake.state = "unavailable";
    expect(await S.setKeyringEnabled(true)).toEqual({ ok: false, error: "keyring unavailable" });
    expect([text(CRED_FILE), text(P.secretsPath())]).toEqual(before);
    expect(keyringEnabled()).toBe(false);
  });

  test("off with the keyring locked refuses, and the marks and the switch stay", async () => {
    await S.setKeyringEnabled(true);
    fake.state = "locked";
    expect(await S.setKeyringEnabled(false)).toEqual({ ok: false, error: "keyring locked" });
    expect(keyringEnabled()).toBe(true);
    expect(text(CRED_FILE)).toContain(K.KEYRING_MARK);
    fake.state = "ready";
    expect(fake.items.size).toBe(2);
  });

  test("off when the keyring lost an item: refuses, no mark is replaced by nothing", async () => {
    await S.setKeyringEnabled(true);
    fake.items.delete("credentials/clickup");
    const r = await S.setKeyringEnabled(false);
    expect(r.ok).toBe(false);
    expect(text(CRED_FILE)).toContain(K.KEYRING_MARK);
    expect(keyringEnabled()).toBe(true);
  });
});

describe("a file or the config that fails in the middle of the move", () => {
  const unreadable = (p: string) => chmodSync(p, 0o000);
  const readable = (p: string) => chmodSync(p, 0o600);

  test("off: a plugin file that cannot be rewritten leaves the marks and every keyring item", async () => {
    await S.setKeyringEnabled(true);
    let r: Awaited<ReturnType<typeof S.setKeyringEnabled>>;
    try { r = await whileReading(() => unreadable(P.secretsPath()), () => S.setKeyringEnabled(false)); }
    finally { readable(P.secretsPath()); }
    expect(r.ok).toBe(false);
    expect(fake.items.size, "the keyring items went before the files were rewritten").toBe(2);
    expect(text(CRED_FILE)).toContain(K.KEYRING_MARK);
    expect(keyringEnabled()).toBe(true);
    everySecretKept();
  });

  test("off: a config that cannot be saved puts the marks back and keeps the keyring", async () => {
    await S.setKeyringEnabled(true);
    const r = await whileReading(() => unreadable(CONFIG_FILE), () => S.setKeyringEnabled(false)).finally(() => readable(CONFIG_FILE));
    expect(r.ok).toBe(false);
    expect(fake.items.size).toBe(2);
    expect(text(CRED_FILE)).toContain(K.KEYRING_MARK);
    expect(text(P.secretsPath())).toContain(K.KEYRING_MARK);
    expect(keyringEnabled()).toBe(true);
    everySecretKept();
  });

  test("on: a plugin file that cannot be read afterwards is unknown, so the keyring items stay", async () => {
    let r: Awaited<ReturnType<typeof S.setKeyringEnabled>>;
    try { r = await whileReading(() => unreadable(P.secretsPath()), () => S.setKeyringEnabled(true)); }
    finally { readable(P.secretsPath()); }
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? "" : r.error).toContain("stay in the keyring");
    expect(fake.items.size, "the keyring copies were deleted while a file might point at them").toBe(2);
    expect(keyringEnabled()).toBe(false);
    everySecretKept();
  });

  test("on: a config that cannot be saved puts the values back first and then forgets the keyring's copies", async () => {
    const before = [text(CRED_FILE), text(P.secretsPath())];
    const r = await whileReading(() => unreadable(CONFIG_FILE), () => S.setKeyringEnabled(true)).finally(() => readable(CONFIG_FILE));
    expect(r.ok).toBe(false);
    expect([text(CRED_FILE), text(P.secretsPath())], "the files kept the mark with the switch off").toEqual(before);
    expect(fake.items.size).toBe(0);
    expect(keyringEnabled()).toBe(false);
    everySecretKept();
  });
});

describe("with it on", () => {
  beforeEach(async () => { expect((await S.setKeyringEnabled(true)).ok).toBe(true); });

  test("a new token goes to the keyring and the file gets the mark", async () => {
    await C.storeCredential("jira", { token: "jt-orbit-7", site: "acme.example.com" });
    expect(fake.items.get("credentials/jira")).toBe("jt-orbit-7");
    expect(files()).not.toContain("jt-orbit-7");
    expect(C.secretFor("jira")).toBe("jt-orbit-7");
  });

  test("a locked keyring refuses the write and never falls back to a plain file", async () => {
    const before = text(CRED_FILE);
    fake.state = "locked";
    await expect(C.storeCredential("jira", { token: "jt-orbit-7" })).rejects.toThrow("keyring locked");
    expect(text(CRED_FILE)).toBe(before);
    expect(files()).not.toContain("jt-orbit-7");
    expect(await P.savePluginSettings("orbit-scorer", { apiKey: "tk-orbit-new" })).toEqual({ ok: false, error: "keyring locked" });
    expect(files()).not.toContain("tk-orbit-new");
  });

  test("the plain synchronous writers refuse instead of writing a secret to a file", () => {
    expect(() => C.setCredential("jira", { token: "jt-orbit-7" })).toThrow();
    expect(P.setPluginSettings("orbit-scorer", { apiKey: "tk-orbit-new" }).ok).toBe(false);
    expect(files()).not.toContain("jt-orbit-7");
    expect(files()).not.toContain("tk-orbit-new");
  });

  test("a key changed through the route is read back and replaces the old one", async () => {
    const r = await P.savePluginSettings("orbit-scorer", { apiKey: "tk-orbit-new" });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("tk-orbit-new");
    expect(fake.items.get("plugin/orbit-scorer/apiKey")).toBe("tk-orbit-new");
    expect(P.pluginOwnSettings("orbit-scorer").apiKey).toBe("tk-orbit-new");
    expect(files()).not.toContain("tk-orbit-new");
  });

  test("a write the keyring did not keep puts the old item back and changes nothing", async () => {
    fake.lieAfterSet = "not what was stored";
    await expect(C.storeCredential("clickup", { token: "pk-orbit-2" })).rejects.toThrow();
    fake.lie = null;
    expect(fake.items.get("credentials/clickup"), "the old token was lost").toBe(TOKEN);
    expect(C.secretFor("clickup")).toBe(TOKEN);
  });

  test("a failed write restores what the keyring held even when this process never read it", async () => {
    K.__setBackend(fake);          // a start whose hydrate did not run: nothing held
    fake.lieAfterSet = "not what was stored";
    await expect(C.storeCredential("clickup", { token: "pk-orbit-2" })).rejects.toThrow();
    expect(fake.items.get("credentials/clickup"), "the item the file points at was deleted").toBe(TOKEN);
  });

  test("a key the file refuses leaves the keyring as it was", async () => {
    chmodSync(P.secretsPath(), 0o000);
    try {
      const r = await P.savePluginSettings("orbit-scorer", { apiKey: "tk-orbit-new" });
      expect(r.ok).toBe(false);
    } finally { chmodSync(P.secretsPath(), 0o600); }
    expect(fake.items.get("plugin/orbit-scorer/apiKey")).toBe(KEY);
    expect(P.pluginOwnSettings("orbit-scorer").apiKey).toBe(KEY);
  });

  test("disconnecting drops the keyring item first, and a locked keyring keeps both", async () => {
    fake.state = "locked";
    await expect(C.dropCredentialSecret("clickup")).rejects.toThrow("keyring locked");
    expect(text(CRED_FILE)).toContain(K.KEYRING_MARK);
    fake.state = "ready";
    await C.dropCredentialSecret("clickup");
    C.clearCredential("clickup");
    expect(fake.items.has("credentials/clickup")).toBe(false);
    expect(C.secretFor("clickup")).toBeNull();
  });

  test("removing a plugin while the keyring is locked removes nothing", async () => {
    fake.state = "locked";
    await expect(P.removePlugin("orbit-scorer")).rejects.toThrow();
    expect(P.listPlugins().map((p) => p.name)).toContain("orbit-scorer");
    fake.state = "ready";
    expect(await P.removePlugin("orbit-scorer")).toBe(true);
    expect(fake.items.has("plugin/orbit-scorer/apiKey"), "the key outlived the plugin").toBe(false);
  });

  test("a locked keyring: disconnecting says to unlock first, and nothing is disconnected", async () => {
    const { disconnectProvider } = await import("../src/providers.ts");
    fake.state = "locked";
    const r = await disconnectProvider("clickup");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("Unlock the system keyring first, then disconnect");
    expect(text(CRED_FILE)).toContain(K.KEYRING_MARK);
    // An unavailable keyring is not something unlocking fixes: it keeps its own reason.
    fake.state = "unavailable";
    const u = await disconnectProvider("clickup");
    expect(!u.ok && u.error).toBe("keyring unavailable");
  });

  test("a locked keyring: removing or replacing a plugin that holds a key says to unlock first", async () => {
    fake.state = "locked";
    await expect(P.removePlugin("orbit-scorer")).rejects.toThrow("Unlock the system keyring first, then remove it");
    const again = await P.installPlugin(fixture());
    expect(again).toEqual({ ok: false, error: "Unlock the system keyring first, then install it" });
    expect(P.listPlugins().map((p) => p.name)).toContain("orbit-scorer");
    expect(fake.items.get("plugin/orbit-scorer/apiKey")).toBe(KEY);
  });

  test("a token whose file write fails leaves the keyring as it was, for an old id and a new one", async () => {
    chmodSync(ROOT, 0o555);
    try {
      await expect(C.storeCredential("clickup", { token: "pk-orbit-2" })).rejects.toThrow();
      await expect(C.storeCredential("jira", { token: "jt-orbit-7" })).rejects.toThrow();
    } finally { chmodSync(ROOT, 0o700); }
    expect(fake.items.get("credentials/clickup"), "the file still points at the old token").toBe(TOKEN);
    expect(C.secretFor("clickup")).toBe(TOKEN);
    expect(fake.items.has("credentials/jira"), "an item nothing points at was left").toBe(false);
    expect(C.secretFor("jira")).toBeNull();
  });

  test("a mark left with the switch off still has its item deleted on disconnect and on plugin removal", async () => {
    // A move that stopped after the files were marked and before the switch was saved.
    expect(writeSecretsKeyring(false).ok).toBe(true);
    await C.dropCredentialSecret("clickup");
    expect(fake.items.has("credentials/clickup"), "the token stayed in the keyring for good").toBe(false);
    expect(await P.removePlugin("orbit-scorer")).toBe(true);
    expect(fake.items.has("plugin/orbit-scorer/apiKey"), "the key stayed in the keyring for good").toBe(false);
  });

  test("status says the state and a count, never a value", async () => {
    const st = await K.keyringStatus();
    expect(st).toEqual({ enabled: true, state: "ready", held: 2 });
    fake.state = "locked";
    const locked = await K.keyringStatus();
    expect(locked).toMatchObject({ enabled: true, state: "locked", why: "keyring locked" });
    expect(JSON.stringify([st, locked])).not.toContain(TOKEN);
  });
});

describe("starting with it on and the keyring not there", () => {
  test("hydrating a locked keyring does not throw, the secret reads as absent, and the feature says why", async () => {
    await S.setKeyringEnabled(true);
    const filesBefore = files();
    K.__setBackend(fake);          // a new process: nothing held
    fake.state = "locked";
    await S.rehydrate();
    expect(C.secretFor("clickup")).toBeNull();
    expect(C.hasCredential("clickup")).toBe(false);
    expect(P.pluginOwnSettings("orbit-scorer").apiKey).toBeNull();
    expect(C.notConnected("clickup", "ClickUp is not connected")).toBe("ClickUp is not connected (keyring locked)");
    expect(files(), "something was written while locked").toBe(filesBefore);
    expect(files()).not.toContain(TOKEN);
  });

  test("re-hydrating once it is unlocked brings the secrets back without a restart", async () => {
    await S.setKeyringEnabled(true);
    K.__setBackend(fake);
    fake.state = "locked";
    await S.rehydrate();
    fake.state = "ready";
    await S.rehydrate();
    expect(C.secretFor("clickup")).toBe(TOKEN);
    expect(P.pluginOwnSettings("orbit-scorer").apiKey).toBe(KEY);
    expect(C.notConnected("clickup", "ClickUp is not connected")).toBe("ClickUp is not connected");
  });

  test("a file that still carries a mark is read through the keyring even when the switch is off", async () => {
    // A move that stopped after the files were marked and before the switch was saved.
    await S.setKeyringEnabled(true);
    expect(writeSecretsKeyring(false).ok).toBe(true);
    K.__setBackend(fake);
    await S.rehydrate();
    expect(C.secretFor("clickup")).toBe(TOKEN);
  });

  test("an unavailable keyring is reported as unavailable, not locked", async () => {
    await S.setKeyringEnabled(true);
    K.__setBackend(fake);
    fake.state = "unavailable";
    await S.rehydrate();
    expect(C.notConnected("clickup", "ClickUp is not connected")).toContain("keyring unavailable");
  });

  test("a read that fails after the keyring said ready is reported as unavailable, with a reason", async () => {
    await S.setKeyringEnabled(true);
    K.__setBackend(fake);
    fake.failGet = true;
    await S.rehydrate();
    expect(C.notConnected("clickup", "ClickUp is not connected")).toBe("ClickUp is not connected (keyring unavailable)");
  });

  test("a locked keyring is still a stored credential, so the first-run check does not take it for a new machine", async () => {
    await S.setKeyringEnabled(true);
    K.__setBackend(fake);
    fake.state = "locked";
    await S.rehydrate();
    expect(C.hasCredential("clickup")).toBe(false);
    expect(C.hasStoredCredential("clickup")).toBe(true);
    expect(C.hasStoredCredential("jira")).toBe(false);
    // index.ts cannot be imported (it starts the server); the rule is read from source.
    expect(INDEX_SRC).toContain('settleFirstRun(hasStoredCredential("clickup"))');
  });

  test("the provider row says the keyring is why there is no token", async () => {
    await S.setKeyringEnabled(true);
    K.__setBackend(fake);
    fake.state = "locked";
    await S.rehydrate();
    const { providerStatuses } = await import("../src/providers.ts");
    const row = (await providerStatuses()).find((r) => r.id === "clickup")!;
    expect(row.state).toBe("needs-auth");
    expect(row.detail).toBe("No token yet (keyring locked)");
  });

  test("a keyring that never answers does not hold the start for more than the cap", async () => {
    await S.setKeyringEnabled(true);
    K.__setBackend({ ...fake, availability: () => new Promise(() => {}), get: fake.get.bind(fake), set: fake.set.bind(fake), del: fake.del.bind(fake) });
    const t = Date.now();
    await S.rehydrate();
    expect(Date.now() - t).toBeLessThan(6500);
    expect(C.secretFor("clickup")).toBeNull();
  }, 8000);
});

describe("the settings door", () => {
  const def = () => serverSettingDefs({ terminalEnabled: false, budgetWrites: false, policyChanged() {} }).find((d) => d.id === "secrets.keyring")!;
  const door = () => makeDoor({ defs: () => [def()], trusted: () => false, applyWindow: async () => ({ ok: true }), changed() {}, later: () => {} });

  test("it is an escalation an agent may read", () => {
    expect(classOf("secrets.keyring")?.class).toBe("escalation");
    expect(def().read()).toBe(false);
  });

  test("an agent's change waits for the person and moves nothing", async () => {
    const d = door();
    const a = await d.change("secrets.keyring", true, { person: false, who: "worker builder-1" });
    expect(a.ok && !a.applied).toBe(true);
    expect(keyringEnabled()).toBe(false);
    expect(fake.items.size).toBe(0);
    expect(text(CRED_FILE)).toContain(TOKEN);
    expect(JSON.stringify([a, d.pending(), d.list()])).not.toContain(TOKEN);
  });

  test("the person's approval runs the migration, and the answer carries no value", async () => {
    const d = door();
    const a = await d.change("secrets.keyring", true, { person: false, who: "worker builder-1" });
    if (!a.ok || a.applied) throw new Error("expected a request");
    const done = await d.decide(a.pending.id, true, true);
    expect(done).toMatchObject({ ok: true, applied: true });
    expect(keyringEnabled()).toBe(true);
    expect(files()).not.toContain(TOKEN);
    expect(JSON.stringify(done)).not.toContain(TOKEN);
  });

  test("an agent turning it off is refused outright, even when agents change without asking", async () => {
    expect((await S.setKeyringEnabled(true)).ok).toBe(true);
    expect(agentVerdict("secrets.keyring", true, false, true)).toBe("refuse");
    expect(agentVerdict("secrets.keyring", true, false, false)).toBe("refuse");
    for (const trusted of [true, false]) {
      const d = makeDoor({ defs: () => [def()], trusted: () => trusted, applyWindow: async () => ({ ok: true }), changed() {}, later: () => {} });
      const a = await d.change("secrets.keyring", false, { person: false, who: "worker builder-1" });
      expect(a).toMatchObject({ ok: false, status: 403 });
      expect(!a.ok && a.error).toContain("only the person does it");
      expect(d.pending()).toEqual([]);
      expect(keyringEnabled()).toBe(true);
      expect(files()).not.toContain(TOKEN);
      expect(fake.items.get("credentials/clickup")).toBe(TOKEN);
    }
  });

  test("turning it on stays a request when asked, and applies only under the person's own switch", async () => {
    expect(agentVerdict("secrets.keyring", false, true, false)).toBe("ask");
    expect(agentVerdict("secrets.keyring", false, true, true)).toBe("apply");
  });

  test("the person turns it off at once", async () => {
    expect((await S.setKeyringEnabled(true)).ok).toBe(true);
    const a = await door().change("secrets.keyring", false, { person: true, who: "person" });
    expect(a).toMatchObject({ ok: true, applied: true });
    expect(keyringEnabled()).toBe(false);
    expect(text(CRED_FILE)).toContain(TOKEN);
  });

  test("approved while the keyring is locked: the error is the reason and nothing moved", async () => {
    fake.state = "locked";
    const d = door();
    const a = await d.change("secrets.keyring", true, { person: false, who: "worker builder-1" });
    if (!a.ok || a.applied) throw new Error("expected a request");
    const done = await d.decide(a.pending.id, true, true);
    expect(done.ok).toBe(false);
    expect(JSON.stringify(done)).toContain("keyring locked");
    expect(keyringEnabled()).toBe(false);
    expect(text(CRED_FILE)).toContain(TOKEN);
  });
});

describe("the bytes sent to the Secret Service", () => {
  /** Decode CreateItem's body by the D-Bus rules, independently of the writer. */
  async function decode(label: string, id: string, value: string) {
    const { createItemBody } = await import("../src/secretservice.ts");
    const b = createItemBody(label, { application: "agentglass", id }, "/org/freedesktop/secrets/session/s1", value);
    let pos = 0;
    const align = (n: number) => { pos += (n - (pos % n)) % n; };
    const u32 = () => { align(4); const v = b.readUInt32LE(pos); pos += 4; return v; };
    const str = () => { const n = u32(); const s = b.toString("utf8", pos, pos + n); expect(b[pos + n], "string not NUL-terminated").toBe(0); pos += n + 1; return s; };
    const sig = () => { const n = b[pos++]!; const s = b.toString("ascii", pos, pos + n); pos += n + 1; return s; };

    const propsLen = u32();
    align(8);
    const propsEnd = pos + propsLen;
    const props: Record<string, unknown> = {};
    while (pos < propsEnd) {
      align(8);
      const key = str();
      const t = sig();
      if (t === "s") props[key] = str();
      else {
        expect(t).toBe("a{ss}");
        const len = u32(); align(8);
        const end = pos + len; const o: Record<string, string> = {};
        while (pos < end) { align(8); const k = str(); o[k] = str(); }
        props[key] = o;
      }
    }
    align(8);
    const session = str();
    const params = u32();
    const n = u32();
    const secret = b.toString("utf8", pos, pos + n);
    pos += n;
    const contentType = str();
    const replace = u32();
    return { props, session, params, secret, contentType, replace, left: b.length - pos };
  }

  // Id lengths 1..9 put the end of the properties at every offset mod 8, so a
  // struct or a dict entry that is not aligned to 8 lands wrong for at least one.
  test("CreateItem's body is a{sv} then (oayays) then b, aligned the way D-Bus says, whatever the lengths", async () => {
    for (let len = 1; len <= 9; len++) {
      const label = "l".repeat(len);
      const id = "i".repeat(len);
      const value = TOKEN.slice(0, 10 + len);
      expect(await decode(label, id, value)).toEqual({
        props: {
          "org.freedesktop.Secret.Item.Label": label,
          "org.freedesktop.Secret.Item.Attributes": { application: "agentglass", id },
        },
        session: "/org/freedesktop/secrets/session/s1",
        params: 0, secret: value, contentType: "text/plain", replace: 1, left: 0,
      });
    }
  });
});

describe("the 0600 files are written durably", () => {
  /** One function's source: from its signature to its own closing brace, comment lines stripped. */
  const body = (src: string, sig: string): string => {
    const at = src.indexOf(sig);
    expect(at, `${sig} not found`).toBeGreaterThanOrEqual(0);
    const end = src.indexOf("\n}\n", at);
    return src.slice(at, end + 2).split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
  };
  const CREDENTIALS_SRC = Bun.file(new URL("../src/credentials.ts", import.meta.url)).text();
  const PLUGINS_SRC = Bun.file(new URL("../src/plugins.ts", import.meta.url)).text();

  for (const [what, src, sig] of [["credentials.json", CREDENTIALS_SRC, "function save("], ["secrets.json", PLUGINS_SRC, "function writeAtomic("]] as const) {
    test(`${what}: the temp file is synced before the rename and the folder after it`, async () => {
      const fn = body(await src, sig);
      const sync = fn.indexOf("fsyncSync(fd)");
      const rename = fn.indexOf("renameSync(tmp");
      const dir = fn.indexOf("fsyncDir(dirname(p))");
      expect(sync, "the temp file is never synced").toBeGreaterThanOrEqual(0);
      expect(rename, "no rename").toBeGreaterThan(sync);
      expect(dir, "the folder is not synced after the rename").toBeGreaterThan(rename);
    });
  }

  test("the folder sync is best effort: a folder that cannot be opened is not a failed write", async () => {
    const { fsyncDir } = await import("../src/fsyncDir.ts");
    expect(() => fsyncDir(join(ROOT, "no-such-folder"))).not.toThrow();
    expect(() => fsyncDir(ROOT)).not.toThrow();
  });
});
