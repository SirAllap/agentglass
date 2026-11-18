import { describe, expect, test } from "bun:test";
import { nextMinuteDelay, nextTickDelay, quantize } from "../src/lib/visibleInterval.ts";

describe("tick rules", () => {
  test("minute delay lands on the boundary, never 0", () => {
    expect(nextMinuteDelay(120_000)).toBe(60_000);
    expect(nextMinuteDelay(120_000 + 59_999)).toBe(1);
    expect(nextMinuteDelay(120_000 + 15_000)).toBe(45_000);
  });
  test("relative label ticks: 1 min, 10 min, 1 h", () => {
    expect(nextTickDelay(5 * 60_000)).toBe(60_000);
    expect(nextTickDelay(2 * 3_600_000)).toBe(600_000);
    expect(nextTickDelay(3 * 86_400_000)).toBe(3_600_000);
  });
  test("quantize: same minute is equal, next minute is not; unit 1 is identity", () => {
    expect(quantize(61_000, 60_000)).toBe(quantize(119_999, 60_000));
    expect(quantize(120_000, 60_000)).not.toBe(quantize(119_999, 60_000));
    expect(quantize(12_345, 1)).toBe(12_345);
  });
});

test("a tick armed at any instant lands exactly on a wall minute", () => {
  for (const t of [0, 1, 59_999, 60_000, 1_700_000_012_345]) expect((t + nextMinuteDelay(t)) % 60_000).toBe(0);
});
