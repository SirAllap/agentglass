/*
 * A recorded outcome is read by nobody. `verdict()` already hoists the
 * `N pass, M fail` line above the tail so it survives truncation, but the
 * tail is the SAME text the count came from — so a clean run said "40 pass,
 * 0 fail" once on its own line, then again at the end of 900-2000 more
 * characters that end in that same line. A failing run is a different
 * claim: which test and why is only IN the tail, so it has to stay.
 */
import { describe, expect, test } from "bun:test";
import { verdict } from "../src/understudy-loop.ts";

describe("verdict", () => {
  test("drops the tail on an all-pass run", () => {
    const out = [
      "bun test v1.3.9",
      "✓ one thing",
      "✓ another thing",
      "40 pass, 0 fail, 12 expect() calls",
    ].join("\n");
    expect(verdict(out, 900)).toBe("40 pass, 0 fail, 12 expect() calls");
  });

  test("keeps the tail when something failed", () => {
    const out = [
      "✗ the thing that broke",
      "  expected 1 to be 2",
      "38 pass, 2 fail, 12 expect() calls",
    ].join("\n");
    const got = verdict(out, 900);
    expect(got).toContain("38 pass, 2 fail");
    expect(got).toContain("expected 1 to be 2");
  });

  test("still truncates a long tail when it is not clean", () => {
    const noise = "x".repeat(2000);
    const out = `${noise}\n5 pass, 1 fail`;
    const got = verdict(out, 50);
    expect(got.length).toBeLessThan(200);
    expect(got).toContain("5 pass, 1 fail");
  });

  test("output with no count line is unaffected", () => {
    const out = "just some agent prose with no test counts in it";
    expect(verdict(out, 900)).toBe(out);
  });
});
