/* Vault review findings: corrupt index, settings lost, key creation. Fake data only. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { siteOf } from "../src/cookieimport.ts";
import {
  __setVaultKeyStore, pullSite, vaultFileName, vaultIdOf, VaultError, writeVault, type VaultData, type VaultKeyStore,
} from "../src/loginvault.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-vaultfix-"));
const prevDir = process.env.AGX_VAULT_DIR;
process.env.AGX_VAULT_DIR = dir;
afterAll(() => {
  if (prevDir === undefined) delete process.env.AGX_VAULT_DIR; else process.env.AGX_VAULT_DIR = prevDir;
  __setVaultKeyStore(null);
  rmSync(dir, { recursive: true, force: true });
});

const slow = (ms = 5) => new Promise((r) => setTimeout(r, ms));
function store(opts: { backTruncated?: boolean } = {}) {
  const s = {
    held: null as string | null, puts: 0,
    state: async () => "ready" as const,
    get: async () => { await slow(); return s.held && opts.backTruncated ? s.held.slice(0, 8) : s.held; },
    put: async (v: string) => { await slow(); s.puts += 1; s.held = v; },
  };
  return s;
}
const mk = (n: string): VaultData => ({
  v: 1, id: vaultIdOf(`zen:${n}`, "1"), source: { profile: `zen:${n}`, container: "1", label: `Fake ${n}` }, importedAt: 1_900_000_000,
  cookies: [{ url: "https://app.acme.test/", name: "sid", value: "invented-acme", path: "/", secure: true, httpOnly: true, sameSite: "lax", domain: ".acme.test" }],
  storage: {},
});
const wipe = (): void => { for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true }); };
beforeEach(wipe);
afterEach(() => __setVaultKeyStore(null));

describe("vault review fixes", () => {
  it("a corrupt index.json throws corrupt and is never overwritten", async () => {
    __setVaultKeyStore(store() as VaultKeyStore);
    await writeVault(mk("aaaa"), siteOf);
    writeFileSync(join(dir, "index.json"), "{ torn");
    await expect(writeVault(mk("bbbb"), siteOf)).rejects.toMatchObject({ code: "corrupt" });
    expect(readFileSync(join(dir, "index.json"), "utf8")).toBe("{ torn");
  });
  it("two first imports create one key", async () => {
    const s = store();
    __setVaultKeyStore(s as VaultKeyStore);
    await Promise.all([writeVault(mk("aaaa"), siteOf), writeVault(mk("bbbb"), siteOf)]);
    expect(s.puts).toBe(1);
  });
  it("a key read back with another length is a VaultError, not a RangeError", async () => {
    __setVaultKeyStore(store({ backTruncated: true }) as VaultKeyStore);
    const err = await writeVault(mk("aaaa"), siteOf).catch((e) => e);
    expect(err).toBeInstanceOf(VaultError);
  });
  it("a user who never saved settings keeps the defaults: no forced ask", async () => {
    __setVaultKeyStore(store() as VaultKeyStore);
    await writeVault(mk("aaaa"), siteOf);
    expect(await pullSite({ site: "acme.test" }, siteOf)).toMatchObject({ ok: true, sensitive: false });
  });
  it("sensitive is unknown (so ask) when settings were saved once and the file is gone", async () => {
    __setVaultKeyStore(store() as VaultKeyStore);
    const d = mk("aaaa");
    await writeVault(d, siteOf);
    // a settings file existed and vanished
    const { writeSettings, readSettings } = await import("../src/loginvault.ts");
    await writeSettings(await readSettings());
    unlinkSync(join(dir, vaultFileName("agx:settings")));
    expect(await pullSite({ site: "acme.test" }, siteOf)).toMatchObject({ ok: true, sensitive: true });
  });
});
