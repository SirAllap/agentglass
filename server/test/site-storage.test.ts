/*
 * Site storage for the login vault (cause 7): Firefox's per-origin
 * localStorage files, read only for the sites marked "needs storage".
 * Invented hosts and fake values only.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { siteOf } from "../src/cookieimport.ts";
import { importToVaults } from "../src/cookieread.ts";
import { __setVaultKeyStore, readVault, vaultIdOf } from "../src/loginvault.ts";
import { decodeLsValue, parseOriginDir, readFirefoxStorage, snappyDecompress } from "../src/sitestorage.ts";

const profile = mkdtempSync(join(tmpdir(), "agx-sitestorage-"));
const vaults = mkdtempSync(join(tmpdir(), "agx-sitestorage-vault-"));
const prevDir = process.env.AGX_VAULT_DIR;
process.env.AGX_VAULT_DIR = vaults;
afterAll(() => {
  rmSync(profile, { recursive: true, force: true });
  rmSync(vaults, { recursive: true, force: true });
  if (prevDir === undefined) delete process.env.AGX_VAULT_DIR; else process.env.AGX_VAULT_DIR = prevDir;
  __setVaultKeyStore(null);
});

/** "abcabcabc": a 3-byte literal, then a 6-byte copy 3 back. */
const SNAPPY = new Uint8Array([9, 0x08, 97, 98, 99, 0x09, 3]);

function lsFile(originDir: string, rows: [string, Uint8Array, number, number][]) {
  const d = join(profile, "storage", "default", originDir, "ls");
  mkdirSync(d, { recursive: true });
  const db = new Database(join(d, "data.sqlite"));
  db.run("CREATE TABLE data (key TEXT PRIMARY KEY, utf16_length INTEGER, conversion_type INTEGER, compression_type INTEGER, last_access_time INTEGER, value BLOB)");
  for (const [k, v, c, z] of rows) db.run("INSERT INTO data VALUES (?, 0, ?, ?, 0, ?)", [k, c, z, v]);
  db.close();
}

describe("site storage (cause 7)", () => {
  it("reads Firefox's origin directory names, containers included", () => {
    expect(parseOriginDir("https+++acme.test")).toEqual({ origin: "https://acme.test", container: "0" });
    expect(parseOriginDir("https+++app.acme.test+8443^userContextId=2")).toEqual({ origin: "https://app.acme.test:8443", container: "2" });
    expect(parseOriginDir("https+++acme.test^partitionKey=%28https%2Corbit.test%29")).toBeNull();
    expect(parseOriginDir("file++++home")).toBeNull();
    expect(parseOriginDir("moz-extension+++abc")).toBeNull();
  });
  it("decompresses raw snappy and refuses a broken one", () => {
    expect(new TextDecoder().decode(snappyDecompress(SNAPPY))).toBe("abcabcabc");
    expect(() => snappyDecompress(new Uint8Array([9, 0x09, 9]))).toThrow();
  });
  it("decodes UTF-16, UTF-8 and snappy values", () => {
    const u16 = new Uint8Array(Buffer.from("tok-1", "utf16le"));
    expect(decodeLsValue(u16, 0, 0)).toBe("tok-1");
    expect(decodeLsValue(new TextEncoder().encode("tok-2"), 1, 0)).toBe("tok-2");
    expect(decodeLsValue(SNAPPY, 1, 1)).toBe("abcabcabc");
    expect(decodeLsValue(SNAPPY, 1, 7)).toBeNull();
  });
  it("only marked sites, only the asked container", () => {
    lsFile("https+++app.acme.test", [["auth", new TextEncoder().encode("fake-token"), 1, 0], ["big", SNAPPY, 1, 1]]);
    lsFile("https+++acme.test^userContextId=3", [["auth", new TextEncoder().encode("other-jar"), 1, 0]]);
    lsFile("https+++orbit.test", [["auth", new TextEncoder().encode("not-marked"), 1, 0]]);
    const got = readFirefoxStorage(profile, "0", new Set(["acme.test"]), siteOf);
    expect(got).toEqual({ "acme.test": [{ origin: "https://app.acme.test", local: { auth: "fake-token", big: "abcabcabc" } }] });
    expect(readFirefoxStorage(profile, "3", new Set(["acme.test"]), siteOf)["acme.test"]?.[0]?.local).toEqual({ auth: "other-jar" });
    expect(readFirefoxStorage(profile, "0", new Set(), siteOf)).toEqual({});
  });
  it("import puts a marked site's storage into its vault, and nothing for the rest", async () => {
    let held: string | null = null;
    __setVaultKeyStore({ state: async () => "ready", get: async () => held, put: async (v: string) => { held = v; } });
    const row = (host: string) => ({ host, name: "sid", value: "fake", path: "/", expires: 2_000_000_000, secure: true, httpOnly: true, sameSite: 1 });
    const p = { id: "zen:fake01", source: "zen", label: "Zen", kind: "firefox" as const, dir: profile, db: join(profile, "cookies.sqlite") };
    await importToVaults(p, [row(".acme.test"), row(".orbit.test")], 1_900_000_000, new Set(["acme.test"]));
    const v = await readVault(vaultIdOf("zen:fake01", "0"));
    expect(Object.keys(v.storage)).toEqual(["acme.test"]);
    expect(v.storage["acme.test"]?.[0]?.local.auth).toBe("fake-token");
  });
});
