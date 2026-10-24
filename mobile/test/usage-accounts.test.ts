/*
 * One provider, several logins, on the phone: read-only.
 *
 * The computer lists a row per login. What the phone must get right is that the
 * headline stays the login that would run a turn, that each login's bars carry
 * its name and the word "active", and that nothing here can switch a login.
 */
import { describe, expect, it } from "bun:test";
import { accountHeading, providerCount, tightestWindow } from "../src/model/quota.ts";
import type { ProviderUsage, QuotaWindow } from "../../shared/types.ts";

const window = (usedPercent: number): QuotaWindow => ({ label: "weekly", minutes: 10080, usedPercent, resetsAt: null });
const row = (usedPercent: number, account?: ProviderUsage["account"]): ProviderUsage => ({
  provider: "anthropic", label: "Claude", available: true, windows: [window(usedPercent)], account,
});

describe("the headline with several logins", () => {
  it("is the active login's window, even when another login is closer to its limit", () => {
    const rows = [
      row(30, { label: "Work A", plan: "max", active: true }),
      row(95, { label: "Work B", plan: "pro", active: false }),
    ];
    expect(tightestWindow(rows)?.window.usedPercent).toBe(30);
  });

  it("still reads a row that is not one of several logins", () => {
    expect(tightestWindow([row(40)])?.window.usedPercent).toBe(40);
  });
});

describe("the heading over a login's bars", () => {
  it("is its label and plan, and nothing for a plain row", () => {
    expect(accountHeading(row(1, { label: "Work A", plan: "max", active: true }))).toBe("Work A · max");
    expect(accountHeading(row(1, { label: "Work B", plan: "", active: false }))).toBe("Work B");
    expect(accountHeading(row(1))).toBeNull();
  });

  it("counts providers, not rows", () => {
    expect(providerCount([row(1), row(2)])).toBe(1);
    expect(providerCount([row(1), { ...row(2), provider: "codex" }])).toBe(2);
  });
});

const usage = await Bun.file(new URL("../src/usage/Usage.tsx", import.meta.url)).text();

describe("the sheet", () => {
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("says 'active' in words and has no control to switch a login", () => {
    const src = code(usage);
    expect(src).toContain(">active</Text>");
    expect(src).not.toMatch(/switch|\/usage\/accounts|<Btn[^>]*account/i);
    // The only Pressable is the chip's own; the only Btn is "Ask again".
    expect(src.match(/<Pressable/g)).toHaveLength(1);
    expect(src.match(/<Btn/g)).toHaveLength(1);
  });
});
