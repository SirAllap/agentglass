import { expect, test } from "bun:test";
import { windowBeyondHint } from "../src/lib/windowHint";

const DAY = 86_400_000;

test("no hint when retention is off", () => {
  expect(windowBeyondHint({ ms: 30 * DAY }, undefined)).toBeUndefined();
});

test("no hint inside retention", () => {
  expect(windowBeyondHint({ ms: 8 * DAY }, 8)).toBeUndefined();
});

test("hint beyond retention points at the daily totals export, not Statistics", () => {
  const h = windowBeyondHint({ ms: 30 * DAY }, 8)!;
  expect(h).toContain("last 8d");
  expect(h).toContain("Daily totals");
  expect(h).not.toContain("Statistics");
});
