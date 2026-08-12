/*
 * The quota strip, when nothing says whose quota it is.
 *
 * Reported as "the 5H / weekly figure does not update, and sometimes it does
 * not appear at all". The second half was the real one and it was never about
 * the plan: the strip picks its provider from the focused chat, and
 * `providerInContext` answers null whenever no chat is focused and the
 * dashboard filter names no provider — the dashboard itself, the terminal, a
 * browser tab. With no provider there was no lookup and nothing drawn.
 *
 * A meter that vanishes while you work reads as "you have used nothing", which
 * is the opposite of what is true.
 */
import { describe, expect, it } from "bun:test";
import { busiestOf } from "../src/lib/usageStore.ts";
import type { ProviderUsage } from "../../shared/types.ts";

const win = (label: string, usedPercent: number) => ({ label, minutes: 300, usedPercent, resetsAt: null });
const claude = (...pcts: number[]): ProviderUsage => ({
  provider: "anthropic", label: "Claude", available: true,
  windows: pcts.map((p, i) => win(i ? "Weekly" : "5h", p)),
});
const codex = (...pcts: number[]): ProviderUsage => ({
  provider: "codex", label: "Codex", available: true,
  windows: pcts.map((p, i) => win(i ? "Weekly" : "5h", p)),
});
const mute = (provider: ProviderUsage["provider"]): ProviderUsage =>
  ({ provider, label: "Muted", available: false, windows: [], note: "signed out" });

describe("which provider the strip falls back to", () => {
  it("picks the one closest to its limit", () => {
    // The same rule the Usage panel's headline uses. A board that says Claude
    // is at 80% under a strip showing Codex at 3% is a board contradicting
    // itself.
    expect(busiestOf([codex(3, 2), claude(80, 40)])?.label).toBe("Claude");
  });

  it("compares across every window, not just the first", () => {
    /* A quiet 5-hour window on top of a nearly-spent weekly one is exactly the
       case worth surfacing, and looking only at `windows[0]` would miss it. */
    expect(busiestOf([codex(50, 51), claude(10, 92)])?.label).toBe("Claude");
  });

  it("skips a provider that cannot report rather than reading it as zero", () => {
    // "Nothing used" and "nobody would say" are different answers.
    expect(busiestOf([mute("anthropic"), codex(4)])?.label).toBe("Codex");
  });

  it("gives nothing when nobody can report, so the strip stays honest", () => {
    expect(busiestOf([mute("anthropic"), mute("codex")])).toBeNull();
  });

  it("gives nothing before the first answer has landed", () => {
    // `null` is the store's pre-fetch state and must not throw here — the strip
    // renders on the very first frame.
    expect(busiestOf(null)).toBeNull();
    expect(busiestOf([])).toBeNull();
  });

  it("still answers for a provider whose windows are all at zero", () => {
    /* Zero is a reading. Returning null on a fresh 5-hour window would put the
       strip back to blank at the exact moment it is most obviously working. */
    expect(busiestOf([claude(0, 0)])?.label).toBe("Claude");
  });
});
