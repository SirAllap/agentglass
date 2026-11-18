import { describe, expect, test } from "bun:test";
import { batchFull, shouldYield } from "../src/transcriptSlice.ts";

const lim = { lines: 500, bytes: 1024 * 1024, ms: 15 };

describe("batchFull", () => {
  test("an empty batch is never full, however slow the clock", () => {
    expect(batchFull(0, 0, 999, lim)).toBe(false);
  });
  test("cut by lines, by bytes, and by time", () => {
    expect(batchFull(500, 40_000, 3, lim)).toBe(true);
    // a handful of tool_result lines carrying a pasted screenshot each
    expect(batchFull(6, 1_300_000, 3, lim)).toBe(true);
    // 40 lines that were slow to parse and insert
    expect(batchFull(40, 90_000, 15, lim)).toBe(true);
  });
  test("under every limit keeps filling", () => {
    expect(batchFull(120, 60_000, 6, lim)).toBe(false);
  });
});

describe("shouldYield", () => {
  test("yields once a file or run of files has held the loop for the budget", () => {
    expect(shouldYield(7.9, 8)).toBe(false);
    expect(shouldYield(8, 8)).toBe(true);
  });
});
