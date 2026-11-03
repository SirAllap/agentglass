/*
 * What the OpenCode Go card's chip says about the key, and what "Last reading"
 * is allowed to claim.
 *
 * The owner's complaint was a "Reading" badge on a card with no key: the card
 * was counting this PC's worker turns and calling it the plan. The three
 * answers below are the truth the chip can tell, and the reading row names the
 * source instead of assuming one.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderUsage } from "../../shared/types.ts";
import { keyStatusChip, lastReading, readingSource } from "../src/lib/opencodeKey.ts";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const row = (o: Partial<ProviderUsage> = {}): ProviderUsage => ({
  provider: "opencode", label: "OpenCode Go", available: true, source: "this PC",
  observedAt: NOW - 3 * 60_000,
  windows: [{ label: "5h", minutes: 300, usedPercent: 1, resetsAt: null }, { label: "weekly", minutes: 10080, usedPercent: 0, resetsAt: null }],
  ...o,
});

describe("the key chip", () => {
  test("no key: this PC only", () => {
    expect(keyStatusChip(false, row())).toEqual({ tone: "off", text: "No key: this PC only" });
  });
  test("a key: the whole plan", () => {
    expect(keyStatusChip(true, row({ usageKey: true, source: "this PC" }))).toEqual({ tone: "ok", text: "Key set: whole plan" });
  });
  test("a key the console refused for Budgets: Read says exactly that", () => {
    const u = row({ usageKey: true, usageNote: "OpenCode's console refused this key: this key needs Budgets: Read." });
    expect(keyStatusChip(true, u)).toEqual({ tone: "warn", text: "Key refused (403): add Budgets = Read" });
  });
  test("a key whose console could not be reached does not claim the whole plan", () => {
    const u = row({ usageKey: true, usageNote: "Could not reach OpenCode's console." });
    expect(keyStatusChip(true, u).tone).toBe("warn");
    expect(keyStatusChip(true, u).text).not.toContain("whole plan");
  });
  test("no answer yet is checking, not off", () => {
    expect(keyStatusChip(null, null).tone).toBe("checking");
  });
});

describe("the last reading row", () => {
  test("names the value, the source and the age", () => {
    expect(lastReading(row(), NOW)).toEqual({ value: "1% in the 5h window", tone: "ok", source: "this PC", age: "3m ago" });
  });
  test("a fresh console reading is called console, a keyed one key; the local count stays this PC", () => {
    const cal = { at: NOW - 60_000, windows: [{ id: "w", label: "weekly", minutes: 10080, usedPercent: 53, resetsAt: null }] };
    const fresh = (usageKey: boolean) => lastReading(row({ usageKey, calibration: cal } as never), NOW);
    expect(fresh(false)).toMatchObject({ value: "53% in the weekly window", source: "console" });
    expect(fresh(true).source).toBe("key");
    expect(lastReading(row(), NOW).source).toBe("this PC");
  });
  test("no reading says why, with no source chip", () => {
    expect(lastReading(null, NOW)).toEqual({ value: "No reading yet", tone: "off", source: null, age: null });
    expect(lastReading(row({ available: false, note: "No worker turn on this PC yet." }), NOW).value).toBe("No worker turn on this PC yet.");
  });
  test("a dollar total is a reading too", () => {
    expect(lastReading(row({ windows: [], spend: { usd: 7.07, window: "30 days" } }), NOW).value).toBe("$7.07 over 30 days");
  });
});

test("a source the card does not know is still this machine's, never the plan's", () => {
  expect(readingSource("opencode stats")).toBe("this PC");
  expect(readingSource(undefined)).toBeNull();
});
