/*
 * What Settings says about ClickUp's per-minute allowance. It reads the last
 * response's `X-RateLimit-Remaining`, so there is nothing to ask of ClickUp,
 * and a window that has turned over is a full minute left, not the old count.
 */
import { describe, expect, test } from "bun:test";
import { budgetView } from "../src/clickup.ts";

describe("budgetView", () => {
  const now = 1_000_000;
  test("no reading yet is nothing spent, and says it is not known", () => {
    expect(budgetView(null, now)).toEqual({ limit: 100, used: 0, resetsInSec: 0, known: false });
  });
  test("a live reading is what the limit minus what is left", () => {
    expect(budgetView({ remaining: 66, resetAt: now + 21_000 }, now)).toEqual({ limit: 100, used: 34, resetsInSec: 21, known: true });
  });
  test("a window that turned over is a fresh minute", () => {
    expect(budgetView({ remaining: 2, resetAt: now - 1 }, now).used).toBe(0);
  });
  test("a plan with a bigger allowance never reads as negative or over", () => {
    expect(budgetView({ remaining: 400, resetAt: now + 1000 }, now).used).toBe(0);
    expect(budgetView({ remaining: -3, resetAt: now + 1000 }, now).used).toBe(100);
  });
});
