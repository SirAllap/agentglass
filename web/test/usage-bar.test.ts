/*
 * Which chips the usage bar draws.
 *
 * Reported from an installed window: a Codex chip reading "Codex — none" took
 * room in a 30px strip for a provider this machine has never used. A provider
 * appears only once it has had a reading here, and the Settings switches can
 * take it away and bring it back.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ProviderUsage } from "../../shared/types.ts";
import { stubStorage } from "./stubStorage";

const store = new Map<string, string>();
stubStorage({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

const { __resetUsageBar, barSwitches, noteReadings, rowsInBar, setShowInBar, showInBar } =
  await import("../src/lib/usageBarPref.ts");
const settings = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");

const win = { label: "5h", minutes: 300, usedPercent: 12, resetsAt: null };
const row = (provider: ProviderUsage["provider"], available = true): ProviderUsage => ({
  provider, label: provider, available, windows: available ? [win] : [],
});

beforeEach(() => __resetUsageBar());

describe("the usage bar", () => {
  test("a provider this machine has never read takes no chip", () => {
    expect(rowsInBar([row("anthropic"), row("codex", false)])).toEqual([]);
  });

  test("a provider appears after one reading, and its switch starts on", () => {
    noteReadings([row("anthropic")]);
    expect(rowsInBar([row("anthropic"), row("codex", false)])).toHaveLength(1);
    expect(showInBar("anthropic")).toBe(true);
    expect(showInBar("codex")).toBe(false);
  });

  test("a provider whose only state is no reading keeps its empty cell", () => {
    expect(rowsInBar([row("antigravity", false)])).toHaveLength(1);
    expect(barSwitches().antigravity).toBe(true);
    setShowInBar("antigravity", false);
    expect(rowsInBar([row("antigravity", false)])).toEqual([]);
  });

  test("turning the switch off removes it, and on brings it back", () => {
    noteReadings([row("anthropic")]);
    setShowInBar("anthropic", false);
    expect(rowsInBar([row("anthropic")])).toEqual([]);
    expect(barSwitches().anthropic).toBe(false);
    setShowInBar("anthropic", true);
    expect(rowsInBar([row("anthropic")])).toHaveLength(1);
    expect(barSwitches().anthropic).toBe(true);
  });

  test("a reading with no saved choice draws its switch on; a provider never read draws off", () => {
    noteReadings([row("anthropic")]);
    expect(barSwitches()).toEqual({ anthropic: true, codex: false, opencode: false, antigravity: true });
    expect(rowsInBar([row("anthropic")]).map((r) => r.provider)).toEqual(["anthropic"]);
    expect(rowsInBar([row("codex", false)])).toEqual([]);
  });

  test("the settings card re-reads the switches when a reading lands, instead of keeping its first answer", () => {
    expect(settings).toContain("useSyncExternalStore(subscribeProviderUsage, providerUsage");
    expect(settings).toContain("setBarShown(barSwitches())");
  });
});
