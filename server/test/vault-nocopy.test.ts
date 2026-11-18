/*
 * "Never copy": sites whose login ends everywhere when a copy is used in
 * another browser. The vault keeps them out of every lane and jar, and the
 * agent gets one sentence. Invented hosts and values only.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { siteOf } from "../src/cookieimport.ts";
import {
  __setVaultKeyStore, isNoCopy, noCopyDefault, noCopyLine, pullSite, readSettings, writeSettings, writeVault,
  vaultIdOf, type KeyStoreState, type VaultData, type VaultKeyStore,
} from "../src/loginvault.ts";
import { runCookieReader } from "../src/cookieread.ts";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vp = require("../../electron/vault-pull.js");

const dir = mkdtempSync(join(tmpdir(), "agx-vault-nocopy-"));
const prevDir = process.env.AGX_VAULT_DIR;
const store: VaultKeyStore & { held: string | null } = {
  held: null, state: async (): Promise<KeyStoreState> => "ready",
  get: async () => store.held, put: async (v: string) => { store.held = v; },
};
beforeEach(() => {
  process.env.AGX_VAULT_DIR = dir;
  store.held = null;
  __setVaultKeyStore(store);
  for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true });
});
afterEach(() => __setVaultKeyStore(null));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevDir === undefined) delete process.env.AGX_VAULT_DIR; else process.env.AGX_VAULT_DIR = prevDir;
});

const ID = vaultIdOf("zen:abcd1234", "0");
const data = (): VaultData => ({
  v: 1, id: ID, source: { profile: "zen:abcd1234", container: "0", label: "Zen" }, importedAt: 1_900_000_000,
  cookies: [
    { url: "https://app.acme.test/", name: "sid", value: "invented-acme", path: "/", secure: true, httpOnly: true, sameSite: "lax", domain: ".acme.test" },
    { url: "https://www.acme-bank.test/", name: "s", value: "invented-bank", path: "/", secure: true, httpOnly: true, sameSite: "lax" },
    { url: "https://orbit.test/", name: "s", value: "invented-orbit", path: "/", secure: true, httpOnly: false, sameSite: "unspecified" },
  ],
  storage: {},
});

async function helper(argv: string[]): Promise<Record<string, unknown>> {
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string, cb?: () => void) => { out.push(String(chunk)); cb?.(); return true; };
  try { await runCookieReader(argv); } finally { (process.stdout as { write: unknown }).write = write; }
  return JSON.parse(out.join("").trim().split("\n").pop() || "{}");
}

describe("the built-in list and the person's choice", () => {
  it("defaults: the named sites, their subdomains, bank-like hosts; nothing else", () => {
    for (const s of ["linkedin.com", "www.linkedin.com", "google.com", "accounts.google.com", "acme-bank.test", "payroll.orbit.test"]) expect(noCopyDefault(s)).toBe(true);
    for (const s of ["acme.test", "orbit.test", "notlinkedin.com", "admin.acme.test"]) expect(noCopyDefault(s)).toBe(false);
    /* One Google login spans its country sites and YouTube: each carries the bound session. */
    for (const s of ["google.es", "accounts.google.es", "www.google.co.uk", "google.com.br", "youtube.com", ".youtube.com", "m.youtube.com"]) expect(noCopyDefault(s)).toBe(true);
    for (const s of ["mybank.com", "bankoforbit.com", "orbitbank.es"]) expect(noCopyDefault(s)).toBe(true);
    for (const s of ["embankment.test"]) expect(noCopyDefault(s)).toBe(false);
    for (const s of ["google.orbit.test", "notgoogle.es", "googleish.com", "youtube.orbit.test"]) expect(noCopyDefault(s)).toBe(false);
  });

  it("the person's mark wins both ways", () => {
    expect(isNoCopy("orbit.test", { noCopy: { "orbit.test": true } })).toBe(true);
    expect(isNoCopy("acme-bank.test", { noCopy: { "acme-bank.test": false } })).toBe(false);
    expect(isNoCopy("acme-bank.test", { noCopy: {} })).toBe(true);
  });

  it("the agent's sentence is the same on both sides", () => {
    expect(noCopyLine("orbit.test")).toBe("orbit.test logs you out elsewhere when its login is copied. Ask the person to sign in once inside agentglass's own browser.");
    expect(vp.noCopyLine("orbit.test")).toBe(noCopyLine("orbit.test"));
  });
});

describe("the pull", () => {
  it("a default site never leaves the vault; unmarking lets it", async () => {
    await writeVault(data(), siteOf);
    const no = await pullSite({ site: "acme-bank.test" }, siteOf);
    expect(no).toEqual({ ok: false, code: "no-copy", error: noCopyLine("acme-bank.test") });
    expect(JSON.stringify(no)).not.toContain("invented");
    expect((await helper(["vault-settings", "--set", JSON.stringify({ site: "acme-bank.test", noCopy: false })])).ok).toBe(true);
    expect((await readSettings()).noCopy).toEqual({ "acme-bank.test": false });
    expect((await pullSite({ site: "acme-bank.test" }, siteOf)).ok).toBe(true);
    /* Back to the default: the key goes, the default applies again. */
    await helper(["vault-settings", "--set", JSON.stringify({ site: "acme-bank.test", noCopy: true })]);
    expect((await readSettings()).noCopy).toEqual({});
    expect((await pullSite({ site: "acme-bank.test" }, siteOf)).ok).toBe(false);
  });

  it("a site the person marks is refused, by name, even named with --vault", async () => {
    await writeVault(data(), siteOf);
    await helper(["vault-settings", "--set", JSON.stringify({ site: "orbit.test", noCopy: true })]);
    expect(await pullSite({ site: "orbit.test", vault: ID }, siteOf)).toMatchObject({ ok: false, code: "no-copy" });
    expect((await pullSite({ site: "acme.test" }, siteOf)).ok).toBe(true);
  });

  it("an old settings file with no key: defaults apply", async () => {
    await writeVault(data(), siteOf);
    const old = await readSettings();
    delete (old as { noCopy?: unknown }).noCopy;
    await writeSettings(old);
    expect((await readSettings()).noCopy).toEqual({});
    expect((await pullSite({ site: "acme-bank.test" }, siteOf)).ok).toBe(false);
  });

  it("vault-list carries the mark; Use in my browser leaves the site out and names it", async () => {
    await writeVault(data(), siteOf);
    const list = await helper(["vault-list"]) as { vaults: { sites: { site: string; noCopy: boolean }[] }[] };
    expect(Object.fromEntries(list.vaults[0]!.sites.map((s) => [s.site, s.noCopy]))).toEqual({ "acme.test": false, "acme-bank.test": true, "orbit.test": false });
    const read = await helper(["vault-read", "--vault", ID]) as { cookies: { value: string }[]; noCopy: string[] };
    expect(read.noCopy).toEqual(["acme-bank.test"]);
    expect(read.cookies.map((c) => c.value).sort()).toEqual(["invented-acme", "invented-orbit"]);
  });
});

describe("main side", () => {
  const index = (rows: { site: string; sensitive?: boolean; noCopy?: boolean }[]) =>
    vp.visitIndexFrom({ ok: true, signInOnVisit: true, vaults: [{ vault: "zen:abc/0", sites: rows }] });

  it("a visit to a never-copy site is refused before any spawn, with the sentence", () => {
    const idx = index([{ site: "orbit.test", noCopy: true }, { site: "acme.test" }]);
    expect(vp.onVisitDecision({ marker: true, index: idx }, "orbit.test")).toEqual({ ok: false, code: "no-copy", error: noCopyLine("orbit.test") });
    expect(vp.onVisitDecision({ marker: true, index: idx }, "acme.test")).toBeNull();
    expect(vp.visitSiteCount({ ok: true, vaults: [{ vault: "v", sites: [{ site: "orbit.test", noCopy: true }, { site: "acme.test" }] }] })).toBe(1);
  });

  it("taking the mark off asks main's own dialog; putting it on is free", () => {
    const d = vp.settingsConfirmDialogs({ site: "orbit.test", noCopy: false });
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain("orbit.test");
    expect(d[0].defaultId).toBe(0);
    expect(vp.settingsConfirmDialogs({ site: "orbit.test", noCopy: true })).toEqual([]);
  });

  it("the Use in my browser confirm names what was left out", () => {
    expect(vp.useInBrowserDialog([], [], ["acme-bank.test"]).detail).toContain("Not copied: acme-bank.test");
    expect(vp.useInBrowserDialog([], []).detail).not.toContain("Not copied");
  });
});
