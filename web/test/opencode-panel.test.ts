/*
 * What the top-bar OpenCode panel draws, and what it calls the numbers.
 *
 * Its local windows are this PC's worker turns, which under-read the plan. The
 * panel may draw them, but never as the plan's own percentages: every bar says
 * "estimate · this PC" until a console reading (a stored key or a page read)
 * less than an hour old replaces them.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderUsage, QuotaWindow } from "../../shared/types.ts";
import { CONSOLE_FRESH_MS, CONSOLE_REREAD_MS, CONSOLE_VALID_MS, keyReadDue, needsKeyRead, openCodePanelWindows } from "../../shared/opencodePanel.ts";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const w = (minutes: number, usedPercent: number): QuotaWindow => ({ label: `${minutes}`, minutes, usedPercent, resetsAt: null });
const live = (minutes: number, usedPercent: number, inHours: number): QuotaWindow =>
  ({ label: `${minutes}`, minutes, usedPercent, resetsAt: new Date(NOW + inHours * 3_600_000).toISOString() });
const local = [w(300, 1), w(10080, 0), w(43200, 0)];
const consoleWindows = [w(300, 2), w(10080, 72), w(43200, 4)];
const consoleLive = [live(300, 2, 2), live(10080, 72, 48), live(43200, 4, 240)];

const opencode = (o: Partial<ProviderUsage> = {}): ProviderUsage => ({
  provider: "opencode", label: "OpenCode Go", available: true, source: "this PC", windows: local, observedAt: NOW - 5 * 60_000, ...o,
});

describe("the top-bar OpenCode panel", () => {
  test("no key and no console reading in the last hour: the local windows, marked as an estimate", () => {
    expect(openCodePanelWindows(opencode(), NOW)).toEqual({ windows: local, estimate: true });
  });

  test("a console reading older than an hour is still the number while its windows have not reset", () => {
    /* The old rule dropped to this PC's count at the hour mark, and that is the
       bug: a restart then painted 21 % where the plan said 54 %. A five-hour
       window moves by a fraction of a percent a minute, so a reading from three
       hours ago is a better answer than an estimate known to under-read. */
    const u = opencode({ calibration: { at: NOW - 3 * 3_600_000, windows: consoleLive } });
    expect(openCodePanelWindows(u, NOW)).toEqual({ windows: consoleLive, estimate: false });
  });

  test("a window whose reset has passed falls back to this PC, and only that window", () => {
    const reset = live(300, 2, -1 / 60);
    const cal = [reset, live(10080, 72, 48), live(43200, 4, 240)];
    const u = opencode({ calibration: { at: NOW - 3 * 3_600_000, windows: cal } });
    expect(openCodePanelWindows(u, NOW)).toEqual({
      windows: [local[0]!, cal[1]!, cal[2]!], estimate: true, estimatedMinutes: [300],
    });
  });

  test("past twelve hours it is a memory, however far off its resets are", () => {
    const u = opencode({ calibration: { at: NOW - CONSOLE_VALID_MS - 1, windows: consoleLive } });
    expect(openCodePanelWindows(u, NOW)).toEqual({ windows: local, estimate: true });
  });

  test("a fresh console reading is the plan's number, and not called an estimate", () => {
    const u = opencode({ calibration: { at: NOW - 60_000, windows: consoleWindows } });
    expect(openCodePanelWindows(u, NOW)).toEqual({ windows: consoleWindows, estimate: false });
  });

  test("a stored key changes nothing on its own: the numbers need a reading, not a credential", () => {
    expect(openCodePanelWindows(opencode({ usageKey: true }), NOW).estimate).toBe(true);
  });

  test("another provider draws exactly what it reported", () => {
    const claude: ProviderUsage = { provider: "anthropic", label: "Claude", available: true, windows: [w(300, 58)] };
    expect(openCodePanelWindows(claude, NOW)).toEqual({ windows: [w(300, 58)], estimate: false });
  });
});

describe("the key is read once when the app starts", () => {
  test("a stored key and only the local estimate in hand: read it", () => {
    expect(needsKeyRead([opencode({ usageKey: true })], NOW)).toBe(true);
  });
  test("no key, or a fresh reading already there: nothing to read", () => {
    expect(needsKeyRead([opencode()], NOW)).toBe(false);
    expect(needsKeyRead([opencode({ usageKey: true, calibration: { at: NOW - 60_000, windows: consoleWindows } })], NOW)).toBe(false);
    expect(needsKeyRead([opencode({ usageKey: true, calibration: { at: NOW - 3 * 3_600_000, windows: consoleLive } })], NOW)).toBe(false);
    expect(needsKeyRead([], NOW)).toBe(false);
  });
});

describe("when the console is read again", () => {
  const keyed = (o: Record<string, unknown> = {}) => [opencode({ usageKey: true, ...o })];
  test("no key: never", () => {
    expect(keyReadDue([opencode()], NOW)).toBe(false);
  });
  test("a key and no reading yet: now", () => {
    expect(keyReadDue(keyed(), NOW)).toBe(true);
  });
  test("a fresh reading waits; one close to the hour goes again before it turns into an estimate", () => {
    expect(keyReadDue(keyed({ calibration: { at: NOW - 2 * 60_000, windows: consoleWindows } }), NOW)).toBe(false);
    expect(keyReadDue(keyed({ calibration: { at: NOW - CONSOLE_REREAD_MS - 1, windows: consoleWindows } }), NOW)).toBe(true);
    expect(CONSOLE_REREAD_MS).toBeLessThan(CONSOLE_FRESH_MS);
  });
});

const usageStoreSrc = await Bun.file(new URL("../src/lib/usageStore.ts", import.meta.url)).text();

describe("the five-minute poll is what re-reads the console", () => {
  test("the poll's own load asks for the console read, not only the refresh button", () => {
    const at = usageStoreSrc.indexOf("export function subscribeProviderUsage(");
    const load = usageStoreSrc.slice(at, usageStoreSrc.indexOf("poller = setInterval(load, EVERY_MS)", at));
    // A reading older than four minutes was never re-read on its own because only
    // the button path called this: the poll swapped the snapshot and stopped.
    expect(load).toContain("readOpenCodeKeyOnce(next)");
  });
});
