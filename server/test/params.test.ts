// The /stats window reaches SQL as a timestamp cutoff — a NaN there zeroes
// every total silently, so the parser must never produce one.
import { describe, expect, test } from "bun:test";
import { parseWindowMs, DEFAULT_WINDOW_MS, MAX_WINDOW_MS } from "../src/params.ts";

describe("parseWindowMs", () => {
  test("a numeric window passes through, clamped to [1 minute, cap]", () => {
    expect(parseWindowMs("3600000")).toBe(3_600_000);
    expect(parseWindowMs("1")).toBe(60_000);
    expect(parseWindowMs("-5")).toBe(60_000);
    expect(parseWindowMs(String(MAX_WINDOW_MS * 2))).toBe(MAX_WINDOW_MS);
  });

  test('"all" (any case) means the widest window, not NaN', () => {
    expect(parseWindowMs("all")).toBe(MAX_WINDOW_MS);
    expect(parseWindowMs("ALL")).toBe(MAX_WINDOW_MS);
  });

  test("absent or malformed falls back to the 24h default", () => {
    expect(parseWindowMs(null)).toBe(DEFAULT_WINDOW_MS);
    expect(parseWindowMs("")).toBe(DEFAULT_WINDOW_MS);
    expect(parseWindowMs("yesterday")).toBe(DEFAULT_WINDOW_MS);
    expect(parseWindowMs("12abc")).toBe(DEFAULT_WINDOW_MS);
  });

  test("every path returns a finite number", () => {
    for (const raw of [null, "", "all", "NaN", "Infinity", "-Infinity", "1e999", "0", "86400000"]) {
      expect(Number.isFinite(parseWindowMs(raw))).toBe(true);
    }
  });
});
