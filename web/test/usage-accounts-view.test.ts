import { describe, expect, it } from "bun:test";
import { accountLines, gaugeText, pickerOptions } from "../src/lib/usageAccountsView.ts";
import type { ProviderUsage } from "../../shared/types.ts";

const def: ProviderUsage = { provider: "anthropic", label: "Claude", available: true, windows: [{ label: "5h", minutes: 300, usedPercent: 12.4, resetsAt: null }, { label: "weekly", minutes: 10080, usedPercent: 40, resetsAt: null }] };
const extra: ProviderUsage = { provider: "anthropic", label: "Claude", available: false, windows: [], note: "No reading for this account yet.", ownAccount: { id: "orbit", label: "Orbit" } };
const acc = [{ provider: "anthropic" as const, id: "orbit", label: "Orbit", source: "env" }];

describe("usage accounts view", () => {
  it("gauge text", () => {
    expect(gaugeText(def)).toBe("5h 12% · weekly 40% used");
    expect(gaugeText(extra)).toBe("No reading for this account yet.");
    expect(gaugeText(undefined)).toBe("No reading.");
  });
  it("default first with its own gauge, the added account with its own", () => {
    const l = accountLines([def, extra], acc, "anthropic", "Claude");
    expect(l.map((x) => x.id)).toEqual(["default", "orbit"]);
    expect(l[0]!.gauge).toContain("weekly 40%");
    expect(l[1]).toMatchObject({ label: "Orbit", source: "env", gauge: "No reading for this account yet." });
  });
  it("picker only with a second account", () => {
    expect(pickerOptions([], "anthropic", "Claude")).toEqual([]);
    expect(pickerOptions(acc, "anthropic", "Claude").map((o) => o.value)).toEqual(["default", "orbit"]);
    expect(pickerOptions(acc, "codex", "Codex")).toEqual([]);
  });
});
