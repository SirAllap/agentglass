/*
 * The floor under the refresh ping.
 *
 * Without it, "also on page load" means every ⌘R spawns a process and spends a
 * request. The floor is what turns a trigger into a budget.
 */
import { describe, expect, test } from "bun:test";
import { shouldRefresh } from "../src/lib/usageRefreshPref.ts";

const NOW = Date.parse("2026-07-31T12:00:00Z");

describe("shouldRefresh", () => {
  test("a reading younger than the floor is left alone", () => {
    expect(shouldRefresh(NOW - 60_000, NOW)).toBe(false);
    expect(shouldRefresh(NOW - 14 * 60_000, NOW)).toBe(false);
  });

  test("an older reading is worth a ping", () => {
    expect(shouldRefresh(NOW - 16 * 60_000, NOW)).toBe(true);
    expect(shouldRefresh(NOW - 3 * 3_600_000, NOW)).toBe(true);
  });

  test("no reading at all is worth a ping", () => {
    expect(shouldRefresh(undefined, NOW)).toBe(true);
  });

  test("the floor is inclusive: exactly 15 minutes old is worth a ping", () => {
    // A boundary the earlier two cases straddle but never land on. Flipping
    // `>=` to `>` in the implementation would only break this one.
    expect(shouldRefresh(NOW - 15 * 60_000, NOW)).toBe(true);
  });

  test("a reading from the future (clock skew) is left alone, not treated as ancient", () => {
    // A naive `Math.abs(now - observedAt)` would call a reading that is
    // somehow ahead of `now` "old" too. The real quantity is elapsed time
    // since the observation, which cannot be negative.
    expect(shouldRefresh(NOW + 60_000, NOW)).toBe(false);
  });
});
