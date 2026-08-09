/*
 * The rule is "say it only when it changes what the row means", so the tests
 * are mostly about SILENCE — the cases where this must render nothing. A
 * staleness line that appears on a healthy row is not a smaller bug than one
 * that never appears; it is four lines of noise on the screen people open when
 * something is already wrong.
 */
import { describe, expect, test } from "bun:test";
import { checkedLine, FRESH_MS } from "../src/lib/providerFreshness.ts";

// Fixed, because a clock time is asserted below and a test that reads the real
// clock passes at 14:32 and fails at midnight.
const NOW = new Date(2026, 7, 9, 14, 32, 0).getTime();

describe("checkedLine", () => {
  test("says nothing when the provider never reported a time", () => {
    expect(checkedLine(undefined, NOW)).toBe("");
    expect(checkedLine(0, NOW)).toBe("");
  });

  test("says nothing about an answer that is still fresh", () => {
    expect(checkedLine(NOW, NOW)).toBe("");
    expect(checkedLine(NOW - 1_000, NOW)).toBe("");
    expect(checkedLine(NOW - (FRESH_MS - 1), NOW)).toBe("");
  });

  test("speaks the moment the answer is past the window", () => {
    // Exactly at the boundary, so the time named is the window ago — 14:30,
    // not the 14:32 it is now. Which is the whole point of the line.
    expect(checkedLine(NOW - FRESH_MS, NOW)).toBe("Checked at 14:30");
  });

  test("gives the clock time the answer was taken, not the time now", () => {
    // Twenty minutes old: 14:12, not 14:32.
    expect(checkedLine(NOW - 20 * 60_000, NOW)).toBe("Checked at 14:12");
  });

  test("past a day it counts days, because a bare clock time reads as today's", () => {
    expect(checkedLine(NOW - 26 * 3_600_000, NOW)).toBe("Checked 1 day ago");
    expect(checkedLine(NOW - 3 * 86_400_000, NOW)).toBe("Checked 3 days ago");
  });

  test("a timestamp from the future is a clock disagreement, not news", () => {
    // Answering "checked in 5 minutes" would be worse than answering nothing.
    expect(checkedLine(NOW + 5 * 60_000, NOW)).toBe("");
  });
});
