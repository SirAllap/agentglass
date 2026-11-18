/*
 * Vault names an agent can use: the ambiguous answer lists them, `--vault`
 * takes them back (label, id, any case, any dash), one vault never counts
 * `.site` and `site` twice, and `vault --list` names the vaults with counts
 * only. Every value here is invented.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { siteOf } from "../src/cookieimport.ts";
import {
  __setVaultKeyStore, pullSite, resolveVaultName, vaultChoiceNames, vaultIdOf, writeVault, type KeyStoreState, type VaultData, type VaultKeyStore,
} from "../src/loginvault.ts";
import {
  askBrowser, noteBrowserManager, noteBrowserReady, parseAsk, resetBrowserDrive, setBrowserSink, settleBrowser, type BrowserAsk,
} from "../src/browserdrive.ts";
import { configureLanes, openLane } from "../src/lanes.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-vault-names-"));
const prevDir = process.env.AGX_VAULT_DIR;
process.env.AGX_VAULT_DIR = dir;
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevDir === undefined) delete process.env.AGX_VAULT_DIR; else process.env.AGX_VAULT_DIR = prevDir;
  __setVaultKeyStore(null);
});

function fakeStore(): VaultKeyStore {
  let held: string | null = null;
  return { state: async () => "ready" as KeyStoreState, get: async () => held, put: async (v: string) => { held = v; } };
}

const MAIN = vaultIdOf("zen:orbit01", "0");
const TWO = vaultIdOf("zen:orbit01", "2");
const FOUR = vaultIdOf("zen:orbit01", "4");
const vault = (id: string, container: string, label: string): VaultData => ({
  v: 1, id, source: { profile: "zen:orbit01", container, label }, importedAt: 1_900_000_000,
  cookies: [
    /* The same site twice in one vault: a host cookie and a domain cookie. */
    { url: "https://app.orbit.dev/", name: "sid", value: "invented-1", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 1_950_000_000, domain: ".app.orbit.dev" },
    { url: "https://app.orbit.dev/", name: "pref", value: "invented-2", path: "/", secure: true, httpOnly: false, sameSite: "lax", expirationDate: 1_950_000_000, domain: "app.orbit.dev" },
  ],
  storage: {},
});

const wipe = (): void => { for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true }); };

describe("vault names (loginvault)", () => {
  beforeEach(() => { __setVaultKeyStore(fakeStore()); wipe(); });
  afterEach(() => __setVaultKeyStore(null));

  it("one vault never counts .site and site as two, and is not ambiguous by itself", async () => {
    const entry = await writeVault(vault(MAIN, "0", "Zen — Ubuntu"), siteOf);
    expect(entry.sites).toBe(1);
    const got = await pullSite({ site: "orbit.dev" }, siteOf);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.cookies).toHaveLength(2);
  });

  it("--vault takes the label, the id, any case and a plain dash", async () => {
    await writeVault(vault(MAIN, "0", "Zen — Ubuntu"), siteOf);
    await writeVault(vault(TWO, "2", "Zen — Ubuntu — container 2"), siteOf);
    for (const name of ["Zen — Ubuntu — container 2", "zen - ubuntu - container 2", "ZEN – UBUNTU – CONTAINER 2", "  Zen  -  Ubuntu - container 2 ", TWO]) {
      expect(resolveVaultName(name)).toBe(TWO);
      const got = await pullSite({ site: "orbit.dev", vault: name }, siteOf);
      expect(got.ok && got.vault).toBe(TWO);
    }
    expect(resolveVaultName("Zen - Ubuntu")).toBe(MAIN);
    expect(resolveVaultName("Zen")).toBeUndefined();
  });

  it("an unknown name lists the real names", async () => {
    await writeVault(vault(MAIN, "0", "Zen — Ubuntu"), siteOf);
    await writeVault(vault(FOUR, "4", "Zen — Ubuntu — container 4"), siteOf);
    const got = await pullSite({ site: "orbit.dev", vault: "Ubuntu" }, siteOf);
    expect(got.ok ? "" : got.code).toBe("missing");
    expect(got.ok ? "" : got.error).toContain("Zen — Ubuntu — container 4");
    expect(got.ok ? "" : got.error).not.toContain("invented");
  });

  it("two vaults with one label: the label names neither, the id does", () => {
    const rows = [{ id: "zen:a/0", label: "Zen" }, { id: "zen:b/0", label: "Zen" }, { id: "zen:c/1", label: "Zen — work" }];
    expect(vaultChoiceNames(rows)).toEqual(["zen:a/0", "zen:b/0", "Zen — work"]);
    const index = Object.fromEntries(rows.map((r) => [r.id, { label: r.label }]));
    expect(resolveVaultName("zen", index)).toBeUndefined();
    expect(resolveVaultName("zen:b/0", index)).toBe("zen:b/0");
  });

  it("a label that is another vault's id names neither, and the list shows ids", async () => {
    const rows = [{ id: MAIN, label: "Zen — Ubuntu" }, { id: TWO, label: MAIN }];
    expect(vaultChoiceNames(rows)).toEqual(["Zen — Ubuntu", TWO]);
    const index = Object.fromEntries(rows.map((r) => [r.id, { label: r.label }]));
    expect(resolveVaultName(MAIN, index)).toBeUndefined();
    expect(resolveVaultName(TWO, index)).toBe(TWO);
    expect(resolveVaultName("Zen - Ubuntu", index)).toBe(MAIN);
    await writeVault(vault(MAIN, "0", "Zen — Ubuntu"), siteOf);
    await writeVault(vault(TWO, "2", MAIN), siteOf);
    const got = await pullSite({ site: "orbit.dev", vault: MAIN }, siteOf);
    expect(got.ok).toBe(false);
    expect(got.ok ? "" : got.error).toContain(`${MAIN}, ${TWO}`);
  });
});

describe("vault names (server)", () => {
  let pullAnswer: Record<string, unknown> = {};
  beforeEach(async () => {
    __setVaultKeyStore(fakeStore());
    wipe();
    await writeVault(vault(MAIN, "0", "Zen — Ubuntu"), siteOf);
    await writeVault(vault(TWO, "2", "Zen — Ubuntu — container 2"), siteOf);
    resetBrowserDrive();
    setBrowserSink({
      send: (ask: BrowserAsk) => {
        const isPull = !!(ask.args as { vaultPull?: unknown }).vaultPull;
        queueMicrotask(() => settleBrowser(ask.id, { ok: true, value: isPull ? pullAnswer : {} }));
        return true;
      },
      listeners: () => 1,
      live: () => true,
    });
    noteBrowserReady("win-names", true);
    noteBrowserManager("win-names", true);
    configureLanes({ manage: async () => ({ ok: true }), hosted: () => true, forget: () => undefined });
  });
  afterEach(() => { resetBrowserDrive(); __setVaultKeyStore(null); });

  it("the ambiguous refusal lists the labels main sent as { id, label }", async () => {
    const r = await openLane("orbit-1", "ephemeral");
    if (!r.ok) throw new Error(r.error);
    pullAnswer = { ok: false, code: "ambiguous", error: "x", vaults: [{ id: MAIN, label: "Zen — Ubuntu" }, { id: TWO, label: "Zen — Ubuntu — container 2" }] };
    const got = await askBrowser({ id: "n-1", op: "lane", args: { action: "vault", id: r.lane.id, site: "orbit.dev", as: "orbit-1" } });
    expect(got.ok).toBe(false);
    expect(got.error).toContain(`"Zen — Ubuntu", "Zen — Ubuntu — container 2"`);
    expect(got.value).toEqual({ code: "ambiguous", vaults: ["Zen — Ubuntu", "Zen — Ubuntu — container 2"] });
  });

  it("vault --list names each vault with its site count, and nothing else", async () => {
    const parsed = parseAsk("lane", { action: "vaults" });
    if (!("ask" in parsed)) throw new Error(parsed.error);
    const got = await askBrowser({ ...parsed.ask, id: "n-2" });
    expect(got.ok).toBe(true);
    expect(got.value).toEqual({ vaults: [
      { name: "Zen — Ubuntu", id: MAIN, sites: 1 },
      { name: "Zen — Ubuntu — container 2", id: TWO, sites: 1 },
    ] });
    expect(JSON.stringify(got.value)).not.toContain("invented");
    expect(JSON.stringify(got.value)).not.toContain("orbit.dev");
  });
});
