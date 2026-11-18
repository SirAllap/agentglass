import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __setUsageAccountsPath, addUsageAccount, removeUsageAccount, usageAccounts } from "../src/usageaccounts.ts";
import { ownAccountRows } from "../src/providerusage.ts";
import { validTrigger } from "../../shared/orchestration.ts";
import { heldUsage } from "../src/orchpolicy.ts";
import type { ProviderUsage } from "../../shared/types.ts";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ua-")); __setUsageAccountsPath(join(dir, "ua.json")); });
afterEach(() => { __setUsageAccountsPath(null); rmSync(dir, { recursive: true, force: true }); });

const claude: ProviderUsage = { provider: "anthropic", label: "Claude", available: true, windows: [] };

describe("usage account store", () => {
  it("round-trips, 0600, only the four fields", () => {
    const r = addUsageAccount({ provider: "anthropic", label: "Orbit team", source: "env" });
    expect(r.ok).toBe(true);
    expect(usageAccounts()).toEqual([{ provider: "anthropic", id: "orbit-team", label: "Orbit team", source: "env" }]);
    expect(statSync(join(dir, "ua.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "ua.json"), "utf8")).not.toMatch(/token|secret|key/i);
  });
  it("refuses a source the provider does not offer, and a second add of the same label", () => {
    expect(addUsageAccount({ provider: "anthropic", label: "A", source: "codex-login" }).ok).toBe(false);
    expect(addUsageAccount({ provider: "anthropic", label: "A" }).ok).toBe(true);
    expect(addUsageAccount({ provider: "anthropic", label: "A" }).ok).toBe(false);
  });
  it("remove works and the default cannot go", () => {
    addUsageAccount({ provider: "codex", label: "Acme" });
    expect(removeUsageAccount("codex", "default").ok).toBe(false);
    expect(removeUsageAccount("codex", "acme").ok).toBe(true);
    expect(usageAccounts()).toEqual([]);
  });
  it("a missing or broken file is no accounts", () => { expect(usageAccounts()).toEqual([]); });
});

describe("a gauge per account", () => {
  it("one extra row per added account, honest note, no borrowed numbers", () => {
    const rows = ownAccountRows([claude], [{ provider: "anthropic", id: "orbit", label: "Orbit", source: "env" }, { provider: "codex", id: "x", label: "X" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "anthropic", available: false, windows: [], ownAccount: { id: "orbit", label: "Orbit", source: "env" } });
    expect(rows[0]!.note).toContain("env");
  });
});

describe("rules name an account", () => {
  it("absent and default are the same rule, unchanged", () => {
    const base = { kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 10 };
    const a = validTrigger(base, "t"), b = validTrigger({ ...base, account: "default" }, "t");
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain("account");
  });
  it("a named account is kept; a bad id is refused", () => {
    const ok = validTrigger({ kind: "limit", provider: "codex", account: "orbit" }, "t");
    expect(ok.ok && (ok.value as any).account).toBe("orbit");
    expect(validTrigger({ kind: "limit", provider: "codex", account: "Bad Id" }, "t").ok).toBe(false);
  });
  it("only the default account has a held reading", async () => {
    const read = await heldUsage();
    expect(read("codex", "orbit")).toBeNull();
    expect(read("codex")).not.toBeNull();
  });
});
