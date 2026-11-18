/*
 * The login vault's store: sealed, keyed from the system key store, 0600,
 * no plain fallback. Every cookie here is invented (acme, orbit hosts).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { siteOf } from "../src/cookieimport.ts";
import {
  __setVaultKeyStore, emptyVaults, listVaults, pullLogPath, pullSite, readPullLog, readSettings, readVault, removeSite, removeVault,
  suggestSensitive, unseal, vaultFileName, vaultIdOf, VaultError, vaultSites, writeSettings, writeVault, type KeyStoreState, type VaultData, type VaultKeyStore,
} from "../src/loginvault.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-vault-"));
const prevDir = process.env.AGX_VAULT_DIR;
process.env.AGX_VAULT_DIR = dir;
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevDir === undefined) delete process.env.AGX_VAULT_DIR; else process.env.AGX_VAULT_DIR = prevDir;
  __setVaultKeyStore(null);
});

function fakeStore(state: KeyStoreState = "ready"): VaultKeyStore & { held: string | null; st: KeyStoreState } {
  const s = {
    held: null as string | null, st: state,
    state: async () => s.st,
    get: async () => s.held,
    put: async (v: string) => { s.held = v; },
  };
  return s;
}

const ID = vaultIdOf("zen:abcd1234", "1");
const data = (): VaultData => ({
  v: 1, id: ID, source: { profile: "zen:abcd1234", container: "1", label: "Zen — work" }, importedAt: 1_900_000_000,
  cookies: [
    { url: "https://app.acme.test/", name: "sid", value: "invented-acme", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 1_950_000_000, domain: ".acme.test" },
    { url: "https://orbit.test/", name: "s", value: "invented-orbit", path: "/", secure: true, httpOnly: false, sameSite: "unspecified" },
  ],
  storage: {},
});

let store: ReturnType<typeof fakeStore>;
/* A clean dir each time: Empty keeps the settings file now (finding 5), and a
   settings file sealed by the last test's key would not open with this one. */
const wipe = (): void => { for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true }); };
beforeEach(() => { store = fakeStore(); __setVaultKeyStore(store); wipe(); });
afterEach(() => __setVaultKeyStore(null));

describe("login vault store", () => {
  it("a torn index fails the settings save before the file is written", async () => {
    writeFileSync(join(dir, "index.json"), "{ torn");
    await expect(writeSettings(await readSettings())).rejects.toMatchObject({ code: "corrupt" });
    expect(readdirSync(dir).filter((n) => n !== "index.json")).toEqual([]);
  });
  it("round-trips a vault and lists it from the index without values", async () => {
    const entry = await writeVault(data(), siteOf);
    expect(entry).toMatchObject({ sites: 2, cookies: 2, sessionCookies: 1, container: "1" });
    expect((await readVault(ID)).cookies.map((c) => c.value)).toEqual(["invented-acme", "invented-orbit"]);
    const index = readFileSync(join(dir, "index.json"), "utf8");
    expect(index).not.toContain("invented");
    expect(index).not.toContain("acme");
    expect(listVaults().map((v) => v.id)).toEqual([ID]);
  });

  it("names the file sha256(id), 0600, ciphertext only, fresh IV per write", async () => {
    await writeVault(data(), siteOf);
    const path = join(dir, vaultFileName(ID));
    expect(vaultFileName(ID)).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "index.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const first = readFileSync(path);
    expect(first.toString("latin1")).not.toContain("invented");
    await writeVault(data(), siteOf);
    const second = readFileSync(path);
    expect(second.subarray(8, 20).equals(first.subarray(8, 20))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to open a file renamed onto another vault's id", async () => {
    await writeVault(data(), siteOf);
    const other = vaultIdOf("zen:abcd1234", "2");
    writeFileSync(join(dir, vaultFileName(other)), readFileSync(join(dir, vaultFileName(ID))));
    await expect(readVault(other)).rejects.toMatchObject({ code: "corrupt" });
    const key = Buffer.from(store.held!, "base64");
    expect(() => unseal(key, other, readFileSync(join(dir, vaultFileName(ID))))).toThrow(VaultError);
  });

  it.each(["locked", "unavailable", "unsupported"] as const)("keyring %s: refuses, writes no file, no key", async (st) => {
    store.st = st;
    await expect(writeVault(data(), siteOf)).rejects.toMatchObject({ code: st });
    expect(store.held).toBeNull();
    expect(readdirSync(dir).filter((f) => f !== "index.json")).toEqual([]);
  });

  it("locked after writing: the vault says so and does not open", async () => {
    await writeVault(data(), siteOf);
    store.st = "locked";
    await expect(readVault(ID)).rejects.toMatchObject({ code: "locked" });
  });

  it("a key store that does not keep the key stores nothing", async () => {
    store.put = async () => {};
    await expect(writeVault(data(), siteOf)).rejects.toMatchObject({ code: "unavailable" });
    expect(readdirSync(dir).filter((f) => f !== "index.json")).toEqual([]);
  });

  it("remove and empty delete files and index entries", async () => {
    await writeVault(data(), siteOf);
    await writeVault({ ...data(), id: vaultIdOf("zen:abcd1234", "0"), source: { ...data().source, container: "0" } }, siteOf);
    expect(removeVault(ID)).toBe(true);
    expect(listVaults().map((v) => v.id)).toEqual([vaultIdOf("zen:abcd1234", "0")]);
    expect(emptyVaults()).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("Empty takes the logins out and keeps the sensitive marks (finding 5)", async () => {
    await writeVault(data(), siteOf);
    await writeSettings({ ...(await readSettings()), sensitive: { "acme.test": true } });
    expect(emptyVaults()).toBe(1);
    expect(listVaults()).toEqual([]);
    expect((await readSettings()).sensitive["acme.test"]).toBe(true);
    await writeVault(data(), siteOf);
    const again = await pullSite({ site: "acme.test" }, siteOf);
    expect(again.ok && again.sensitive).toBe(true);
  });

  it("pullSite carries the sign-out-at-end setting (finding 4)", async () => {
    await writeVault(data(), siteOf);
    const on = await pullSite({ site: "acme.test" }, siteOf);
    expect(on.ok && on.signOutAtEnd).toBe(true);
    await writeSettings({ ...(await readSettings()), signOutAtEnd: false });
    const off = await pullSite({ site: "acme.test" }, siteOf);
    expect(off.ok && off.signOutAtEnd).toBe(false);
  });

  it("pullSite says expired when every cookie for the site is past its date", async () => {
    await writeVault(data(), siteOf);
    expect(await pullSite({ site: "acme.test" }, siteOf, 1_960_000_000)).toMatchObject({ ok: false, code: "expired" });
    expect((await pullSite({ site: "acme.test" }, siteOf, 1_900_000_000)).ok).toBe(true);
    expect((await pullSite({ site: "orbit.test" }, siteOf, 1_960_000_000)).ok).toBe(true);
  });

  it("removeSite takes one site out and keeps the rest; the last site takes the vault", async () => {
    await writeVault({ ...data(), storage: { "acme.test": [{ origin: "https://app.acme.test", local: { k: "invented" } }] } }, siteOf);
    expect(await removeSite(ID, "acme.test", siteOf)).toBe(true);
    const left = await readVault(ID);
    expect(left.cookies.map((c) => c.name)).toEqual(["s"]);
    expect(left.storage["acme.test"]).toBeUndefined();
    expect(listVaults()[0]!.sites).toBe(1);
    expect(await removeSite(ID, "acme.test", siteOf)).toBe(false);
    expect(await removeSite(ID, "orbit.test", siteOf)).toBe(true);
    expect(listVaults()).toEqual([]);
  });

  it("pullSite gives one site of one vault, never merged (F5)", async () => {
    __setVaultKeyStore(fakeStore());
    wipe();
    await writeVault(data(), siteOf);
    const got = await pullSite({ site: "acme.test" }, siteOf);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.vault).toBe(ID);
      expect(got.cookies.map((c) => c.name)).toEqual(["sid"]);
      expect(got.storage).toEqual([]);
    }
    const none = await pullSite({ site: "nowhere.test" }, siteOf);
    expect(none.ok ? "" : none.code).toBe("none");
  });

  it("two vaults with the site and no default answer ambiguous; a default or a name picks one", async () => {
    __setVaultKeyStore(fakeStore());
    wipe();
    const other = vaultIdOf("zen:abcd1234", "2");
    await writeVault(data(), siteOf);
    await writeVault({ ...data(), id: other, source: { ...data().source, container: "2", label: "Zen — home" } }, siteOf);
    const amb = await pullSite({ site: "acme.test" }, siteOf);
    expect(amb.ok).toBe(false);
    if (!amb.ok && amb.code === "ambiguous") expect(amb.vaults.map((v) => v.label).sort()).toEqual(["Zen — home", "Zen — work"]);
    else throw new Error("expected ambiguous");
    const named = await pullSite({ site: "acme.test", vault: other }, siteOf);
    expect(named.ok && named.vault).toBe(other);
    await writeSettings({ ...(await readSettings()), defaults: { "acme.test": other } });
    const byDefault = await pullSite({ site: "acme.test" }, siteOf);
    expect(byDefault.ok && byDefault.vault).toBe(other);
    const missing = await pullSite({ site: "acme.test", vault: "zen:nope/0" }, siteOf);
    expect(missing.ok ? "" : missing.code).toBe("missing");
  });

  it("the person's default vault signs in a site that is in several; a site's own default and a name still win", async () => {
    __setVaultKeyStore(fakeStore());
    wipe();
    const other = vaultIdOf("zen:abcd1234", "2");
    const third = vaultIdOf("zen:abcd1234", "3");
    await writeVault(data(), siteOf);
    await writeVault({ ...data(), id: other, source: { ...data().source, container: "2", label: "Zen — home" } }, siteOf);
    await writeVault({ ...data(), id: third, source: { ...data().source, container: "3", label: "Zen — spare" } }, siteOf);
    expect((await pullSite({ site: "acme.test" }, siteOf)).ok).toBe(false);
    await writeSettings({ ...(await readSettings()), defaultVault: other });
    const viaDefault = await pullSite({ site: "acme.test" }, siteOf);
    expect(viaDefault.ok && viaDefault.vault).toBe(other);
    await writeSettings({ ...(await readSettings()), defaults: { "acme.test": third } });
    const perSite = await pullSite({ site: "acme.test" }, siteOf);
    expect(perSite.ok && perSite.vault).toBe(third);
    const named = await pullSite({ site: "acme.test", vault: ID }, siteOf);
    expect(named.ok && named.vault).toBe(ID);
    /* A default that holds no login for the site is no answer: still ambiguous. */
    await writeSettings({ ...(await readSettings()), defaults: {}, defaultVault: "zen:gone/9" });
    expect((await pullSite({ site: "acme.test" }, siteOf)).ok).toBe(false);
  });

  it("storage leaves only for a site marked needs storage; sensitive mark rides along", async () => {
    __setVaultKeyStore(fakeStore());
    wipe();
    await writeVault({ ...data(), storage: { "acme.test": [{ origin: "https://app.acme.test", local: { tok: "invented" } }] } }, siteOf);
    const off = await pullSite({ site: "acme.test" }, siteOf);
    expect(off.ok && off.storage).toEqual([]);
    await writeSettings({ ...(await readSettings()), storage: { "acme.test": true }, sensitive: { "acme.test": true } });
    const on = await pullSite({ site: "acme.test" }, siteOf);
    expect(on.ok && on.storage.length).toBe(1);
    expect(on.ok && on.sensitive).toBe(true);
  });

  it("settings are sealed: the file holds no site name", async () => {
    __setVaultKeyStore(fakeStore());
    wipe();
    await writeSettings({ ...(await readSettings()), sensitive: { "billing.acme.test": true } });
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), "latin1")).not.toContain("billing.acme");
  });

  it("vaultSites lists counts and expiry, never values", async () => {
    __setVaultKeyStore(fakeStore());
    wipe();
    await writeVault(data(), siteOf);
    const rows = await vaultSites(siteOf);
    expect(JSON.stringify(rows)).not.toContain("invented");
    expect(rows[0].sites.find((s) => s.site === "orbit.test")?.session).toBe(1);
    expect(rows[0].sites.find((s) => s.site === "acme.test")?.expires).toBe(1_950_000_000);
  });

  it("suggests sensitive by host words only", () => {
    expect(suggestSensitive("admin.acme.test")).toBe(true);
    expect(suggestSensitive("billing-orbit.test")).toBe(true);
    expect(suggestSensitive("acme.test")).toBe(false);
    expect(suggestSensitive("product.orbit.test")).toBe(false);
  });

  it("the pull log reads back by site and skips a torn line", () => {
    writeFileSync(pullLogPath(), '{"at":1,"event":"pull","site":"acme.test","agent":"a","lane":"l","count":2}\n{"at":2,"ev');
    expect(readPullLog("acme.test").map((e) => e.count)).toEqual([2]);
    expect(readPullLog("orbit.test")).toEqual([]);
  });
});
