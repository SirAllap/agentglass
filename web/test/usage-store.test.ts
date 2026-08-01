/*
 * The labels the gauges put on screen.
 *
 * Only the pure functions are tested here — the poll itself is a timer and a
 * fetch, and the interesting decisions are all in how a reading is DESCRIBED.
 * `ageLabel` carries the most weight: it is the whole reason a Codex reading is
 * honest rather than merely present.
 */
import { describe, expect, test, beforeAll } from "bun:test";

let usageStore: typeof import("../src/lib/usageStore.ts");

beforeAll(async () => {
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  usageStore = await import("../src/lib/usageStore.ts");
});

const NOW = Date.parse("2026-07-31T12:00:00Z");

describe("usedColor", () => {
  test("escalates with consumption", () => {
    expect(usageStore.usedColor(10)).toBe("var(--success)");
    expect(usageStore.usedColor(70)).toBe("var(--warning)");
    expect(usageStore.usedColor(90)).toBe("var(--error)");
  });

  test("changes exactly at the thresholds", () => {
    expect(usageStore.usedColor(59)).toBe("var(--success)");
    expect(usageStore.usedColor(60)).toBe("var(--warning)");
    expect(usageStore.usedColor(84)).toBe("var(--warning)");
    expect(usageStore.usedColor(85)).toBe("var(--error)");
  });
});

describe("ageLabel", () => {
  test("a reading from moments ago does not nag", () => {
    expect(usageStore.ageLabel(NOW - 30_000, NOW)).toBe("just now");
  });

  test("says how old a stale reading is", () => {
    expect(usageStore.ageLabel(NOW - 45 * 60_000, NOW)).toBe("45m ago");
    expect(usageStore.ageLabel(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(usageStore.ageLabel(NOW - 50 * 3_600_000, NOW)).toBe("2d ago");
  });

  test("no reading is not an age", () => {
    expect(usageStore.ageLabel(undefined, NOW)).toBe("");
  });
});

describe("resetLabel", () => {
  test("counts down when the reset is near", () => {
    expect(usageStore.resetLabel(new Date(NOW + 104 * 60_000).toISOString(), NOW)).toBe("in 1h 44m");
    expect(usageStore.resetLabel(new Date(NOW + 20 * 60_000).toISOString(), NOW)).toBe("in 20m");
  });

  test("a reset in the past is now, not a negative countdown", () => {
    expect(usageStore.resetLabel(new Date(NOW - 60_000).toISOString(), NOW)).toBe("now");
  });

  test("nothing to say about a null reset", () => {
    expect(usageStore.resetLabel(null, NOW)).toBe("");
  });
});
