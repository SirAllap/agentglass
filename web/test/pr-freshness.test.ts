/*
 * The bar's age text: when it is normal, when it turns amber, and what it says
 * when GitHub's budget is spent. Times are fixed, the clock is the module's own.
 */
import { describe, expect, it } from "bun:test";
import type { PrRate } from "../../shared/types.ts";
import { FRESH_MS, STALE_MS, budgetLine, clock, freshness, limitMessage, longAge, refreshTitle, shortAge } from "../src/lib/prFreshness.ts";

const NOW = Date.UTC(2026, 9, 16, 18, 0, 0);
const MIN = 60_000;
const rate = (o: Partial<PrRate> = {}): PrRate => ({ limit: 5000, remaining: 4210, resetAt: NOW + 40 * MIN, limited: false, seenAt: NOW, ...o });

describe("freshness thresholds", () => {
  it("is normal text under five minutes", () => {
    expect(freshness(NOW - 30_000, null, NOW)).toMatchObject({ tone: "fresh", text: "just now" });
    expect(freshness(NOW - 2 * MIN, null, NOW)).toMatchObject({ tone: "fresh", text: "2m" });
    expect(freshness(NOW - (FRESH_MS - 1), null, NOW)?.tone).toBe("fresh");
  });

  it("stays normal text, but no longer 'fresh', between five and fifteen minutes", () => {
    expect(freshness(NOW - FRESH_MS, null, NOW)).toMatchObject({ tone: "aging", text: "5m" });
    expect(freshness(NOW - (STALE_MS - 1), null, NOW)?.tone).toBe("aging");
  });

  it("turns amber and says how long ago past fifteen minutes, with the reason in the tooltip", () => {
    const f = freshness(NOW - 40 * MIN, null, NOW)!;
    expect(f.tone).toBe("stale");
    expect(f.text).toBe("updated 40 min ago");
    expect(f.title).toContain("Cached to save GitHub requests");
    expect(f.title).toContain("Press refresh");
  });

  it("counts hours and days in the long form", () => {
    expect(longAge(2 * 60 * MIN)).toBe("2 h ago");
    expect(longAge(30 * 60 * MIN)).toBe("1 d ago");
    expect(shortAge(3 * 60 * MIN)).toBe("3h");
  });

  it("says nothing before anything was read", () => {
    expect(freshness(0, null, NOW)).toBeNull();
  });
});

describe("the GitHub limit", () => {
  it("names the time it comes back", () => {
    const limited = rate({ limited: true, remaining: 0, resetAt: NOW + 100 * MIN });
    expect(limitMessage(limited, NOW)).toBe(`GitHub limit reached · retry at ${clock(NOW + 100 * MIN)}`);
  });

  it("replaces the age while it is in force, and its tooltip says nothing is being asked", () => {
    const f = freshness(NOW - 40 * MIN, rate({ limited: true, remaining: 0 }), NOW)!;
    expect(f.tone).toBe("limited");
    expect(f.text).toMatch(/^GitHub limit reached · retry at \d\d:\d\d$/);
    expect(f.title).toContain("nothing is being asked");
  });

  it("is gone the moment its reset has passed", () => {
    const old = rate({ limited: true, remaining: 0, resetAt: NOW - 1 });
    expect(limitMessage(old, NOW)).toBeNull();
    expect(freshness(NOW - MIN, old, NOW)?.tone).toBe("fresh");
  });

  it("an answer with room is not a limit", () => {
    expect(limitMessage(rate(), NOW)).toBeNull();
  });
});

describe("the refresh tooltip", () => {
  it("adds what is left of the budget", () => {
    expect(budgetLine(rate())).toBe(`4,210 of 5,000 left, resets ${clock(NOW + 40 * MIN)}`);
    expect(refreshTitle("Refresh the list", rate())).toBe(`Refresh the list\n4,210 of 5,000 left, resets ${clock(NOW + 40 * MIN)}`);
  });
  it("is just the action before GitHub has said anything", () => {
    expect(refreshTitle("Refresh the list", undefined)).toBe("Refresh the list");
    expect(budgetLine(rate({ limit: 0 }))).toBeNull();
  });
});
