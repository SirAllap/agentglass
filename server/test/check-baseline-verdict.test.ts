// The thresholds, on their own. Measured: a 15-minute eval suite was amber on
// every pull request under an absolute 5-minute rule.
import { describe, expect, test } from "bun:test";
import { baselineStats, durationVerdict, aggregateRuns, percentile, median } from "../../shared/checkBaseline.ts";

const M = 60_000;
const usual = (med: number, p90 = med, n = 20) => ({ median: med * M, p90: p90 * M, n });

describe("baseline statistics", () => {
  test("median, nearest-rank p90, sample size, newest 20 only", () => {
    expect(median([1, 2, 3, 4])).toBe(3); // 2.5 rounds up to a whole ms
    expect(median([5, 1, 3])).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    const s = baselineStats([...Array.from({ length: 20 }, () => 100), ...Array.from({ length: 5 }, () => 9999)])!;
    expect(s).toEqual({ median: 100, p90: 100, n: 20 });
    expect(baselineStats([])).toBeNull();
  });
});

describe("the verdict", () => {
  test("a job that always takes 15m is usual at 15m, not slow", () => {
    expect(durationVerdict(15 * M, usual(14, 16))).toBe("usual");
  });
  test("slower than usual beyond max(p90, 1.5x median), much slower beyond 2.5x", () => {
    expect(durationVerdict(21 * M, usual(14, 16))).toBe("usual");   // 1.5x = 21m is not beyond it
    expect(durationVerdict(22 * M, usual(14, 16))).toBe("slower");
    expect(durationVerdict(30 * M, usual(14, 25))).toBe("slower");  // beyond max(p90 25, 1.5x 21)
    expect(durationVerdict(24 * M, usual(14, 25))).toBe("usual");   // within p90
    expect(durationVerdict(36 * M, usual(14, 16))).toBe("much-slower");
  });
  test("faster below half the median", () => {
    expect(durationVerdict(6 * M, usual(14))).toBe("faster");
    expect(durationVerdict(8 * M, usual(14))).toBe("usual");
  });
  test("under 5 samples there is no verdict", () => {
    expect(durationVerdict(90 * M, usual(14, 16, 4))).toBe("unknown");
    expect(durationVerdict(90 * M, undefined)).toBe("unknown");
  });
  test("a running job can only be slower, never faster", () => {
    expect(durationVerdict(2 * M, usual(14), true)).toBe("usual");
    expect(durationVerdict(25 * M, usual(14, 16), true)).toBe("slower");
  });
  test("seconds of difference on a short job are noise", () => {
    expect(durationVerdict(9_000, { median: 2000, p90: 3000, n: 20 })).toBe("usual");
  });
});

describe("aggregates", () => {
  test("failure rate ignores cancellations; trend has 14 daily buckets", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    const a = aggregateRuns([
      { conclusion: "success", ms: 10, completedAt: now - 1000 }, { conclusion: "failure", ms: 3, completedAt: now - 2000 },
      { conclusion: "cancelled", ms: 1, completedAt: now - 3000 }, { conclusion: "success", ms: 30, completedAt: now - 3 * 86_400_000 },
    ], now);
    expect(a.failureRate).toBeCloseTo(1 / 3);
    expect(a.trend).toHaveLength(14);
    expect(a.trend[13]).toMatchObject({ day: "2026-09-30", runs: 3, median: 10 });
    expect(a.trend[10].median).toBe(30);
  });
});
