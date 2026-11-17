/*
 * The Login vault site list: search, "Sensitive only", the count and the
 * bulk targets. Site names are invented; no cookie value is involved.
 */
import { describe, expect, it } from "bun:test";
import { chooseShown, pickShown, vaultShown, type VaultRow, type VaultSiteRow } from "../src/lib/loginVault.ts";

const row = (site: string, sensitive = false): VaultSiteRow => ({ site, cookies: 3, session: 0, expires: null, sensitive, suggested: false, needsStorage: false, isDefault: false });
const vaults: VaultRow[] = [
  { vault: "zen/work", label: "Work", updatedAt: 0, sites: [row("app.orbit.dev", true), row("docs.orbit.dev"), row("mail.acme.test")] },
  { vault: "zen/home", label: "Home", updatedAt: 0, sites: [row("app.orbit.dev"), row("news.example")] },
  { vault: "zen/empty", label: "Empty", updatedAt: 0, sites: [] },
];

describe("login vault shown", () => {
  it("shows every row and counts all boxes with no search", () => {
    const s = vaultShown(vaults, "", false);
    expect(s.groups.map((g) => g.vault.vault)).toEqual(["zen/work", "zen/home"]);
    expect(s.count).toBe("5 of 5 sites");
  });
  it("searches across boxes, case-insensitive substring", () => {
    const s = vaultShown(vaults, "  ORBIT ", false);
    expect(s.groups.map((g) => g.sites.map((x) => x.site))).toEqual([["app.orbit.dev", "docs.orbit.dev"], ["app.orbit.dev"]]);
    expect(s.count).toBe("3 of 5 sites");
  });
  it("keeps only sensitive rows with the filter on", () => {
    const s = vaultShown(vaults, "", true);
    expect(s.shown).toBe(1);
    expect(s.toMark).toEqual([]);
    expect(s.toUnmark).toEqual(["app.orbit.dev"]);
  });
  it("bulk targets are only shown rows that change, each site once", () => {
    const s = vaultShown(vaults, "orbit", false);
    expect(s.toMark).toEqual(["docs.orbit.dev", "app.orbit.dev"]);
    expect(s.toUnmark).toEqual(["app.orbit.dev"]);
    expect(vaultShown(vaults, "nothing", false).count).toBe("0 of 5 sites");
  });
});

describe("import picker search", () => {
  const sites = [{ site: "app.orbit.dev", cookies: 4 }, { site: "docs.orbit.dev", cookies: 2 }, { site: "mail.acme.test", cookies: 9 }];
  it("filters live, case-insensitive, and counts against every site", () => {
    expect(pickShown(sites, "").count).toBe("3 of 3 sites");
    const p = pickShown(sites, " Orbit ");
    expect(p.rows.map((s) => s.site)).toEqual(["app.orbit.dev", "docs.orbit.dev"]);
    expect(p.count).toBe("2 of 3 sites");
    expect(pickShown(sites, "nothing").count).toBe("0 of 3 sites");
  });
  it("All and None act only on the shown rows", () => {
    const shown = pickShown(sites, "orbit").rows;
    expect([...chooseShown(new Set(["mail.acme.test"]), shown, true)].sort()).toEqual(["app.orbit.dev", "docs.orbit.dev", "mail.acme.test"]);
    expect([...chooseShown(new Set(["app.orbit.dev", "mail.acme.test"]), shown, false)]).toEqual(["mail.acme.test"]);
  });
});
