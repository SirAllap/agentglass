/*
 * `open` that ends where the tab already was. An https address that redirects
 * back to the page the tab is on arrived; only a scheme the guard refuses did
 * not. Invented hosts only.
 */
import { describe, expect, test } from "bun:test";
import { neverMoved } from "../src/lib/browserDrive.ts";
import { defaultVaultOptions, readListing, type VaultRow } from "../src/lib/loginVault.ts";

describe("neverMoved", () => {
  const login = "https://acme.test/login?return_to=%2Fsettings";
  test("an https address that redirects back to the page the tab is on is no refusal", () => {
    expect(neverMoved("https://acme.test/settings/profile", login, login)).toBeNull();
    expect(neverMoved("http://acme.test/settings", login, login)).toBeNull();
  });
  test("a scheme the guard refuses still says so, and names the scheme list", () => {
    const said = neverMoved("data:text/html,<p>x</p>", login, login);
    expect(said).toContain("still on " + login);
    expect(said).toContain("data:, file:, blob:");
    expect(neverMoved("file:///etc/hostname", login, login)).toContain("not allowed in this view");
  });
  test("arriving anywhere else, or exactly where asked, is no refusal", () => {
    expect(neverMoved("https://acme.test/a", "https://acme.test/", "https://acme.test/b")).toBeNull();
    expect(neverMoved("https://acme.test/a", "https://acme.test/a", "https://acme.test/a")).toBeNull();
  });
});

describe("the default vault choice", () => {
  const row = (vault: string, label: string, sites = 3): VaultRow => ({ vault, label, updatedAt: 0, sites: Array.from({ length: sites }, (_, i) => ({ site: `s${i}.test`, cookies: 1, session: 0, expires: null, sensitive: false, suggested: false, needsStorage: false, isDefault: false })) });
  test("starts with ask me, lists the vaults that hold a site, tells twin labels apart", () => {
    const o = defaultVaultOptions([row("zen:a/0", "Zen — main"), row("zen:a/1", "Zen — spare", 0), row("zen:b/0", "Zen — main")]);
    expect(o).toEqual([
      { value: "", label: "ask me" },
      { value: "zen:a/0", label: "Zen — main (zen:a/0)" },
      { value: "zen:b/0", label: "Zen — main (zen:b/0)" },
    ]);
  });
  test("the listing keeps the default only when main sent one", () => {
    expect(readListing({ ok: true, vaults: [], defaultVault: "zen:a/0" })?.defaultVault).toBe("zen:a/0");
    expect(readListing({ ok: true, vaults: [], defaultVault: null })?.defaultVault).toBeNull();
    expect(readListing({ ok: true, vaults: [] })?.defaultVault).toBeNull();
  });
});
