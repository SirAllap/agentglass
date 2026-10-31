import { test, expect } from "bun:test";
import { spendSeries, sparkPath, fiveHour, untilReset, stalledCount, type StalledRow } from "../src/lib/starboardKpi.ts";
import type { ProviderUsage, TimeBucket } from "../../shared/types.ts";

const b = (cost_usd: number): TimeBucket => ({ t: 0, events: 1, errors: 0, cost_usd, tokens: 1 });
const row = (o: Partial<StalledRow> = {}): StalledRow => ({ name: "orbit-api", from: "said", state: "idle", ...o });

test("no line is drawn without two buckets or without spend", () => {
  expect(spendSeries(undefined)).toBeNull();
  expect(spendSeries([b(1)])).toBeNull();
  expect(spendSeries([b(0), b(0), b(0)])).toBeNull();
  expect(spendSeries([b(0), b(2)])).toEqual([0, 2]);
});

test("sparkline spans the box and rises with spend", () => {
  const p = sparkPath([0, 1, 2]);
  expect(p.startsWith("M0.0 37.0")).toBe(true);
  expect(p).toContain("L100.0");
});

const usage = (o: Partial<ProviderUsage> = {}): ProviderUsage => ({ provider: "anthropic", label: "Claude", available: true, windows: [{ label: "5h", minutes: 300, usedPercent: 58, resetsAt: "2026-01-01T02:00:00Z" }], ...o });

test("the 5-hour tile reads only a measured 5-hour window", () => {
  expect(fiveHour(null)).toBeNull();
  expect(fiveHour([usage({ available: false })])).toBeNull();
  expect(fiveHour([usage({ windows: [{ label: "weekly", minutes: 10080, usedPercent: 3, resetsAt: null }] })])).toBeNull();
  expect(fiveHour([usage()])?.used).toBe(58);
});

test("time to reset", () => {
  const now = Date.parse("2026-01-01T00:08:00Z");
  expect(untilReset("2026-01-01T02:00:00Z", now)).toBe("1 h 52 m");
  expect(untilReset("2026-01-01T00:30:00Z", now)).toBe("22 m");
  expect(untilReset("2025-12-31T00:00:00Z", now)).toBeNull();
  expect(untilReset(null, now)).toBeNull();
});

test("Stalled? is absent until a row carries the verdict, then counts the true ones", () => {
  expect(stalledCount([row(), row()])).toBeNull();
  expect(stalledCount([row({ stalled: false }), row({ stalled: true }), row({ stalled: true }), row()])).toBe(2);
});
