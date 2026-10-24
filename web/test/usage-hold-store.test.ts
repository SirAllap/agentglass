/*
 * The store half of the late reading after a switch: what is held, when the
 * quick asks happen and when they stop. The network is the api object's own
 * methods swapped for the test; timers are captured and run by hand.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import type { AccountsOut } from "../../shared/pluginAccounts.ts";
import type { ProviderUsage } from "../../shared/types.ts";

const stubGlobal = globalStubs();
const mem = new Map<string, string>();
stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear(), key: () => null, length: 0,
} as unknown as Storage);
const timers: { id: number; fn: () => void; ms: number }[] = [];
let timerId = 0;
stubGlobal("setTimeout", ((fn: () => void, ms: number) => { timers.push({ id: ++timerId, fn, ms }); return timerId; }) as unknown as typeof setTimeout);
stubGlobal("clearTimeout", ((id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }) as unknown as typeof clearTimeout);

let accounts: typeof import("../src/lib/accountStore.ts");
let usage: typeof import("../src/lib/usageStore.ts");
let api: typeof import("../src/lib/api.ts");
const saved: Record<string, unknown> = {};

const list = (active: string): AccountsOut => ({
  provider: "anthropic", plugin: "acme-plugin",
  accounts: ["acme-a", "acme-b"].map((id) => ({ id, label: id, plan: "max", colour: "blue", active: id === active, storage: "keyring" }) as AccountsOut["accounts"][number]),
});
const row = (pct: number): ProviderUsage => ({
  provider: "anthropic", label: "Claude", available: true, observedAt: Date.now(),
  windows: [{ label: "5h", minutes: 300, usedPercent: pct, resetsAt: null }],
});
const nothing = (): ProviderUsage => ({ provider: "anthropic", label: "Claude", available: false, windows: [] });

let served: AccountsOut[] = [];
let reply: ProviderUsage[] = [];
let asks = 0;
const flush = () => new Promise<void>((r) => setImmediate(r));

beforeAll(async () => {
  api = await import("../src/lib/api.ts");
  const a = api.api as unknown as Record<string, unknown>;
  for (const k of ["usageAccounts", "providerUsage"]) saved[k] = a[k];
  a.usageAccounts = () => Promise.resolve({ ok: true, providers: served });
  a.providerUsage = () => { asks++; return Promise.resolve(reply); };
  accounts = await import("../src/lib/accountStore.ts");
  usage = await import("../src/lib/usageStore.ts");
});
afterAll(() => { Object.assign(api.api as object, saved); usage.__resetUsageStore(); });
beforeEach(() => { timers.length = 0; asks = 0; usage.__resetUsageStore(); });

async function switchedWithNoReading(): Promise<void> {
  served = [list("acme-a")]; reply = [row(41)];
  await usage.refreshProviderUsage();
  await accounts.refreshAccounts();
  served = [list("acme-b")]; reply = [nothing()];
  await accounts.refreshAccounts();
  await flush();
}

describe("after a switch whose new reading is late", () => {
  it("keeps the previous strip as held and does not touch the snapshot", async () => {
    await switchedWithNoReading();
    expect(usage.heldRows("anthropic")[0]?.windows[0]?.usedPercent).toBe(41);
    expect(usage.providerUsage()?.[0]?.available).toBe(false);
  });

  it("asks again at 2 s, 4 s, 8 s and then stops", async () => {
    await switchedWithNoReading();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t = timers.find((x) => [2_000, 4_000, 8_000].includes(x.ms) && !delays.includes(x.ms));
      if (!t) break;
      delays.push(t.ms);
      timers.splice(timers.indexOf(t), 1);
      t.fn();
      await flush();
    }
    expect(delays).toEqual([2_000, 4_000, 8_000]);
    expect(timers.some((x) => [2_000, 4_000, 8_000].includes(x.ms))).toBe(false);
  });

  it("lets go of the held strip and stops asking when the new login's reading lands", async () => {
    await switchedWithNoReading();
    reply = [row(12)];
    const t = timers.find((x) => x.ms === 2_000)!;
    t.fn();
    await flush();
    expect(usage.heldRows()).toEqual([]);
    expect(timers.some((x) => x.ms === 4_000)).toBe(false);
  });

  it("holds nothing when no switch happened", async () => {
    served = [list("acme-a")]; reply = [nothing()];
    await usage.refreshProviderUsage();
    expect(usage.heldRows()).toEqual([]);
  });
});

describe("wiring", () => {
  it("the strip draws through stripRow, so the late reading cannot blank it", async () => {
    const src = await Bun.file(new URL("../src/components/TopBar.tsx", import.meta.url)).text();
    expect(src).toContain("stripRow(live, heldRows(");
  });
});
