// What /usage/providers says once a plugin lists the logins of a provider.
// The active login is measured by the app and the others are the plugin's word;
// the answer also goes to a paired phone, so it is held to the schema's fields.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAccounts, type AccountsInput } from "../../shared/pluginAccounts.ts";
import type { AgentProbe, ProviderUsage } from "../../shared/types.ts";
import { DEFAULT_PACE_CONFIG, pace } from "../../shared/pace.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-usage-merge-"));
const creds = join(dir, "credentials.json");
const was = { creds: process.env.CLAUDE_CREDENTIALS, xdg: process.env.XDG_CONFIG_HOME };
const realFetch = globalThis.fetch;
let mod: typeof import("../src/providerusage.ts");
let usage: typeof import("../src/usage.ts");

const WEEK = 10080;
const reading = (five: number, week: number) => ({
  windows: [
    { label: "5h", minutes: 300, usedPercent: five, resetsAt: "2026-08-03T11:39:59Z" },
    { label: "weekly", minutes: WEEK, usedPercent: week, resetsAt: "2026-08-05T12:59:59Z" },
  ],
});
const acct = (id: string, active: boolean, r?: ReturnType<typeof reading>) => ({
  id, label: `Work ${id.slice(-1).toUpperCase()}`, plan: "max", colour: "neutral", active, storage: "file", ...(r ? { reading: r } : {}),
});
const listOf = (accounts: unknown[]): AccountsInput => {
  const v = validateAccounts({ provider: "anthropic", accounts });
  if (!v.ok) throw new Error(v.error);
  return v.value;
};

beforeAll(async () => {
  writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "acme-token" } }));
  process.env.CLAUDE_CREDENTIALS = creds;
  process.env.XDG_CONFIG_HOME = dir;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    five_hour: { utilization: 12, resets_at: "2026-08-03T11:39:59Z" },
    seven_day: { utilization: 30, resets_at: "2026-08-05T12:59:59Z" },
  }), { status: 200 })) as unknown as typeof fetch;
  usage = await import("../src/usage.ts");
  usage.__test_forgetEverything();
  mod = await import("../src/providerusage.ts");
});

afterAll(() => {
  usage.__test_forgetEverything();
  globalThis.fetch = realFetch;
  for (const [k, v] of [["CLAUDE_CREDENTIALS", was.creds], ["XDG_CONFIG_HOME", was.xdg]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const claudeOnly = [{ id: "claude-code", found: true }, { id: "codex", found: false }, { id: "antigravity", found: false }] as unknown as AgentProbe[];

describe("one row per login", () => {
  test("the active row is the app's reading, whatever the plugin says about it", async () => {
    usage.__test_forgetEverything();
    // The plugin claims 99 % for the active login; the app measured 12 %.
    const list = listOf([acct("acme-a", true, reading(99, 99)), acct("acme-b", false, reading(70, 80))]);
    const rows = await mod.allProviderUsage(claudeOnly, () => list);
    expect(rows.map((r) => [r.provider, r.account?.label, r.account?.active])).toEqual([
      ["anthropic", "Work A", true], ["anthropic", "Work B", false],
    ]);
    expect(rows[0].windows.map((w) => w.usedPercent)).toEqual([12, 30]);
    expect(rows[1].windows.map((w) => w.usedPercent)).toEqual([70, 80]);
    expect(rows[1].available).toBe(true);
  });

  test("a login with no reading has no row, and no list leaves the row as it was", async () => {
    usage.__test_forgetEverything();
    const rows = await mod.allProviderUsage(claudeOnly, () => listOf([acct("acme-a", true), acct("acme-b", false)]));
    expect(rows).toHaveLength(1);
    expect(rows[0].account).toEqual({ label: "Work A", plan: "max", active: true });
    const bare = await mod.allProviderUsage(claudeOnly, () => undefined);
    expect(bare).toHaveLength(1);
    expect(bare[0].account).toBeUndefined();
  });

  test("without an active login in the list nothing can be marked", () => {
    const row = { provider: "anthropic", label: "Claude", available: true, windows: [] } as ProviderUsage;
    expect(mod.withAccounts(row, listOf([acct("acme-a", false, reading(1, 2))]))).toEqual([row]);
  });

  test("the pace maths reads an inactive row exactly as it reads the active one", () => {
    const row = { provider: "anthropic", label: "Claude", available: true, windows: [] } as ProviderUsage;
    const [, other] = mod.withAccounts(row, listOf([acct("acme-a", true), acct("acme-b", false, reading(10, 40))]));
    const w = other.windows.find((x) => x.minutes === WEEK)!;
    const input = { usedPercent: w.usedPercent, resetsAt: Date.parse(w.resetsAt!), windowMinutes: w.minutes, now: Date.parse(w.resetsAt!) - 86_400_000 };
    expect(pace({ ...input, cfg: DEFAULT_PACE_CONFIG, samples: [] }).state).toBeTypeOf("string");
    expect(Object.keys(w).sort()).toEqual(["label", "minutes", "resetsAt", "usedPercent"]);
  });
});

describe("what leaves for the phone", () => {
  // The fields ProviderUsage and its account marker declare in shared/types.ts.
  const ROW = ["provider", "label", "available", "windows", "plan", "observedAt", "note", "account"];
  const ACCOUNT = ["label", "plan", "active"];
  const WINDOW = ["label", "minutes", "usedPercent", "resetsAt"];

  test("every key of every row, marker and window is in the schema, and no id or token-ish field", async () => {
    usage.__test_forgetEverything();
    const list = listOf([acct("acme-a", true), acct("acme-b", false, reading(5, 6))]);
    // A field a future plugin version might add must not travel either.
    (list.accounts[1] as unknown as Record<string, unknown>).email = "someone@example.com";
    const rows = await mod.allProviderUsage(claudeOnly, () => list);
    const wire = JSON.parse(JSON.stringify(rows)) as ProviderUsage[];
    for (const r of wire) {
      expect(Object.keys(r).filter((k) => !ROW.includes(k))).toEqual([]);
      expect(Object.keys(r.account!).filter((k) => !ACCOUNT.includes(k))).toEqual([]);
      for (const w of r.windows) expect(Object.keys(w).filter((k) => !WINDOW.includes(k))).toEqual([]);
    }
    expect(JSON.stringify(wire)).not.toMatch(/acme-a"|acme-b"|storage|colour|someone@/);
  });
});
