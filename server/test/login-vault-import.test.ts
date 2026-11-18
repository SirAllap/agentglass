/*
 * The import writes into the vault: one vault per container, session and
 * partitioned cookies kept, nothing but counts out. Invented hosts only.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importToVaults } from "../src/cookieread.ts";
import { __setVaultKeyStore, readVault, vaultIdOf } from "../src/loginvault.ts";
import type { CookieRow } from "../src/cookieimport.ts";

const NOW = 1_900_000_000;
const dir = mkdtempSync(join(tmpdir(), "agx-vault-import-"));
const prev = process.env.AGX_VAULT_DIR;
process.env.AGX_VAULT_DIR = dir;
let held: string | null = null;
let state: "ready" | "locked" = "ready";
__setVaultKeyStore({ state: async () => state, get: async () => held, put: async (v) => { held = v; } });
afterAll(() => {
  __setVaultKeyStore(null);
  rmSync(dir, { recursive: true, force: true });
  if (prev === undefined) delete process.env.AGX_VAULT_DIR; else process.env.AGX_VAULT_DIR = prev;
});

const row = (o: Partial<CookieRow>): CookieRow => ({
  host: ".acme.test", name: "sid", value: "invented", path: "/", expires: NOW + 999, secure: true, httpOnly: true, sameSite: 1, ...o,
});
const profile = { id: "zen:abcd1234", source: "zen", label: "Zen — default", kind: "firefox" as const, dir: "/nowhere", db: "/nowhere/cookies.sqlite" };

describe("import into the vault", () => {
  it("one vault per container, with session and partitioned cookies", async () => {
    const out = await importToVaults(profile, [
      row({ name: "home" }),
      row({ name: "sess", expires: 0 }),
      row({ name: "emb", host: "widget.orbit.test", partitionKey: { topLevelSite: "https://acme.test", hasCrossSiteAncestor: false } }),
      row({ name: "work", container: "1" }),
    ], NOW);
    expect(out.vaults.map((v) => [v.id, v.cookies, v.sessionCookies])).toEqual([
      [vaultIdOf("zen:abcd1234", "0"), 3, 1],
      [vaultIdOf("zen:abcd1234", "1"), 1, 0],
    ]);
    expect(JSON.stringify(out)).not.toContain("invented");
    const home = await readVault(vaultIdOf("zen:abcd1234", "0"));
    expect(home.cookies.map((c) => c.name).sort()).toEqual(["emb", "home", "sess"]);
    expect((await readVault(vaultIdOf("zen:abcd1234", "1"))).source.label).toBe("Zen — default — container 1");
  });

  it("a locked keyring stores nothing and says so", async () => {
    state = "locked";
    await expect(importToVaults({ ...profile, id: "zen:other" }, [row({})], NOW)).rejects.toMatchObject({ code: "locked" });
    state = "ready";
  });
});
