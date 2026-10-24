/*
 * The account store and the rows it keeps apart from the strip. The network is the
 * api object's own methods, swapped for the test; timers are captured, never run.
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
const timers: number[] = [];
stubGlobal("setTimeout", ((_fn: () => void, ms: number) => { timers.push(ms); return 0; }) as unknown as typeof setTimeout);

let store: typeof import("../src/lib/accountStore.ts");
let usage: typeof import("../src/lib/usageStore.ts");
let api: typeof import("../src/lib/api.ts");
const saved: Record<string, unknown> = {};

const acct = (id: string, active: boolean, extra: Partial<AccountsOut["accounts"][number]> = {}) =>
  ({ id, label: id, plan: "max", colour: "blue", active, storage: "keyring", ...extra }) as AccountsOut["accounts"][number];
const list = (activeId: string, over: Partial<AccountsOut> = {}): AccountsOut =>
  ({ provider: "anthropic", plugin: "acme-plugin", accounts: [acct("acme-a", activeId === "acme-a"), acct("acme-b", activeId === "acme-b")], ...over });
const row = (o: Partial<ProviderUsage> = {}): ProviderUsage =>
  ({ provider: "anthropic", label: "Claude", available: true, windows: [{ label: "5h", minutes: 300, usedPercent: 40, resetsAt: null }], ...o });

let served: AccountsOut[] = [];
let reads = 0;

beforeAll(async () => {
  api = await import("../src/lib/api.ts");
  const a = api.api as unknown as Record<string, unknown>;
  for (const k of ["usageAccounts", "accountSwitch", "accountManage", "providerUsage"]) saved[k] = a[k];
  a.usageAccounts = () => { reads++; return Promise.resolve({ ok: true, providers: served }); };
  a.providerUsage = () => Promise.resolve([row()]);
  store = await import("../src/lib/accountStore.ts");
  usage = await import("../src/lib/usageStore.ts");
});
afterAll(() => { Object.assign(api.api as object, saved); });
beforeEach(() => { reads = 0; timers.length = 0; });

describe("refreshAccounts", () => {
  it("keeps what the server said and tells listeners", async () => {
    served = [list("acme-a")];
    let heard = 0;
    const off = store.subscribeAccounts(() => heard++);
    await store.refreshAccounts();
    off();
    expect(store.accountsOf("anthropic")?.accounts.map((x) => x.id)).toEqual(["acme-a", "acme-b"]);
    expect(heard).toBe(1);
  });

  it("keeps the last list when a read fails", async () => {
    served = [list("acme-a")];
    await store.refreshAccounts();
    (api.api as unknown as Record<string, unknown>).usageAccounts = () => Promise.reject(new Error("offline"));
    await store.refreshAccounts();
    expect(store.accountsOf("anthropic")).not.toBeNull();
    (api.api as unknown as Record<string, unknown>).usageAccounts = () => { reads++; return Promise.resolve({ ok: true, providers: served }); };
  });

  it("asks for the plan readings again when the active account changed, and not on the first read", async () => {
    let asked = 0;
    store.onActiveChanged(() => asked++);
    served = [];
    await store.refreshAccounts();
    asked = 0;
    served = [list("acme-a")];
    await store.refreshAccounts();
    expect(asked).toBe(0); // from nothing to a list is not a switch
    served = [list("acme-b")];
    await store.refreshAccounts();
    expect(asked).toBe(1);
    await store.refreshAccounts();
    expect(asked).toBe(1); // same answer, no new ask
  });
});

describe("the strip's own poll", () => {
  it("reads the accounts when the providers land", async () => {
    served = [list("acme-a")];
    await usage.refreshProviderUsage();
    expect(reads).toBeGreaterThanOrEqual(1);
  });

  it("answers the strip with the core's row, never an inactive account's", () => {
    const rows = [row({ account: { label: "acme-b", plan: "pro", active: false }, windows: [{ label: "5h", minutes: 300, usedPercent: 99, resetsAt: null }] }), row()];
    expect(usage.busiestOf(rows)?.windows[0]!.usedPercent).toBe(40);
    expect(usage.busiestOf([rows[0]!])).toBeNull();
  });
});

describe("a plugin that flips the active account back and forth", () => {
  it("costs one plan read for the burst and a single pending one, and those reads do not read the accounts again", async () => {
    usage.__resetUsageStore();
    const a = api.api as unknown as Record<string, unknown>;
    const was = a.providerUsage;
    let plan = 0;
    a.providerUsage = () => { plan++; return Promise.resolve([row()]); };
    served = [list("acme-a")];
    await store.refreshAccounts();
    plan = 0; reads = 0; timers.length = 0;
    for (let i = 0; i < 6; i++) {
      served = [list(i % 2 ? "acme-a" : "acme-b")];
      await store.refreshAccounts();
    }
    await Bun.sleep(5);
    a.providerUsage = was;
    expect(plan).toBe(1);
    expect(reads).toBe(6);
    // The throttle's single pending read; the quick re-asks after a switch are 2 s, 4 s, 8 s.
    const throttle = timers.filter((ms) => ms > 8_000);
    expect(throttle.length).toBe(1);
    expect(throttle[0]).toBeLessThanOrEqual(30_000);
  });
});

describe("readingFor", () => {
  const inactive = row({ account: { label: "acme-b", plan: "pro", active: false }, windows: [{ label: "5h", minutes: 300, usedPercent: 72, resetsAt: null }] });
  const active = row({ account: { label: "acme-a", plan: "max", active: true } });
  const rows = [inactive, active];

  it("gives the active chip the core's row", () => {
    expect(store.readingFor(rows, "anthropic", { label: "acme-a", active: true })).toBe(active);
  });
  it("gives another chip the row that carries its label", () => {
    expect(store.readingFor(rows, "anthropic", { label: "acme-b", active: false })).toBe(inactive);
  });
  it("says nothing for a chip the plugin sent no reading for", () => {
    expect(store.readingFor(rows, "anthropic", { label: "acme-c", active: false })).toBeNull();
    expect(store.readingFor(null, "anthropic", { label: "acme-b", active: false })).toBeNull();
  });
  it("does not mix providers", () => {
    expect(store.readingFor([row({ provider: "codex" })], "anthropic", { label: "x", active: true })).toBeNull();
  });
});

describe("peakOf", () => {
  it("is the busiest window", () => {
    expect(store.peakOf(row({ windows: [{ label: "5h", minutes: 300, usedPercent: 12, resetsAt: null }, { label: "7d", minutes: 10080, usedPercent: 61, resetsAt: null }] }))).toBe(61);
  });
  it("is nothing for no reading", () => {
    expect(store.peakOf(null)).toBeNull();
    expect(store.peakOf(row({ available: false }))).toBeNull();
    expect(store.peakOf(row({ windows: [] }))).toBeNull();
  });
});

describe("colourOf", () => {
  it("turns an accent word into that accent and neutral into the page's ink", () => {
    expect(store.colourOf("blue")).toBe("#3b82f6");
    expect(store.colourOf("neutral")).toBe("var(--text2)");
    expect(store.colourOf("purple")).toBe("var(--text3)");
  });
});

describe("pressAccount", () => {
  it("carries the sentence the app refused with", async () => {
    (api.api as unknown as Record<string, unknown>).accountSwitch = () => Promise.resolve({ ok: false, error: "That account is already the active one." });
    expect(await store.pressAccount("switch", "anthropic", "acme-a")).toEqual({ ok: false, error: "That account is already the active one." });
    expect(timers).toEqual([]);
  });
  it("reads the lists twice after a switch, once each, never on an interval", async () => {
    (api.api as unknown as Record<string, unknown>).accountSwitch = () => Promise.resolve({ ok: true, plugin: "acme-plugin" });
    expect(await store.pressAccount("switch", "anthropic", "acme-b")).toEqual({ ok: true, plugin: "acme-plugin" });
    expect(timers).toEqual([...store.FOLLOW_UP_MS]);
  });
  it("hands back the plugin to open for manage, with no follow-up read", async () => {
    (api.api as unknown as Record<string, unknown>).accountManage = () => Promise.resolve({ ok: true, plugin: "acme-plugin" });
    expect((await store.pressAccount("manage", "anthropic")).plugin).toBe("acme-plugin");
    expect(timers).toEqual([]);
  });
  it("says so when the app cannot be reached", async () => {
    (api.api as unknown as Record<string, unknown>).accountSwitch = () => Promise.reject(new Error("down"));
    expect((await store.pressAccount("switch", "anthropic", "acme-b")).ok).toBe(false);
  });
});

describe("the demo", () => {
  it("answers an empty list and refuses a press, with no server", async () => {
    const src = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();
    const demo = src.slice(src.indexOf("const demoApi"));
    expect(demo).toContain("usageAccounts: () => D({ ok: true, providers: [] as AccountsOut[] })");
    expect(demo).toMatch(/accountSwitch: \(\) => D\(\{ ok: false/);
    expect(demo).toMatch(/accountManage: \(\) => D\(\{ ok: false/);
  });
});
