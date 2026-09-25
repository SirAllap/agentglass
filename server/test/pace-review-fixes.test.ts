// Regressions from the review of plan pace: each case is a measured wrong
// answer, and each was watched going red against the code before the fix.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_PACE_CONFIG, GAP_MS, alertDue, pace, type PaceConfig, type PaceSample,
} from "../../shared/pace.ts";

const TZ = "Europe/Madrid";
const cfg = (over: Partial<PaceConfig> = {}): PaceConfig => ({ ...DEFAULT_PACE_CONFIG, timeZone: TZ, ...over });
/** Madrid wall clock on 2026-09-<d> (UTC+2). */
const at = (d: number, h: number, m = 0) => Date.UTC(2026, 8, d, h - 2, m);
const RESET = at(30, 15);
const WEEK = 10080;

describe("a recent rate is measured over working time", () => {
  test("evening use after work is not divided by the sliver of the lookback that worked", () => {
    // Thu 21:00, 24 % at 18:00 and 30 % now: 2 %/h of evening use. The lookback
    // (18:00-21:00) holds no working time, so the rate must not be "recent".
    const samples: PaceSample[] = [{ t: at(24, 17), used: 20 }, { t: at(24, 18), used: 24 }, { t: at(24, 20, 30), used: 30 }];
    const p = pace({ usedPercent: 30, resetsAt: RESET, windowMinutes: WEEK, now: at(24, 21), cfg: cfg(), samples });
    if (p.state !== "ok") throw new Error("stale");
    expect(p.burn.source).toBe("week");
  });

  test("a lookback that mostly worked still reads as recent", () => {
    const samples: PaceSample[] = [{ t: at(24, 10), used: 20 }, { t: at(24, 12), used: 26 }];
    const p = pace({ usedPercent: 26, resetsAt: RESET, windowMinutes: WEEK, now: at(24, 13), cfg: cfg(), samples });
    if (p.state !== "ok") throw new Error("stale");
    expect(p.burn.source).toBe("recent");
    expect(p.burn.perWorkHour).toBeCloseTo(2, 6);
  });
});

describe("a window with no working time", () => {
  test("a one-day window resetting on a Sunday is refused, not divided by zero", () => {
    const sun = at(27, 10);
    const p = pace({ usedPercent: 10, resetsAt: sun, windowMinutes: 1440, now: sun - 3_600_000, cfg: cfg() });
    expect(p).toEqual({ state: "stale", why: "no-working-time" });
  });
});

describe("today's spend after a night with the app closed", () => {
  test("a jump seen by the first reading after midnight is not today's", () => {
    // 2 % Wed 20:00, app closed, 16 % Thu 10:05 (a gap reading).
    const samples: PaceSample[] = [{ t: at(23, 20), used: 2 }, { t: at(24, 10, 5), used: 16, gap: true }];
    const p = pace({ usedPercent: 16, resetsAt: RESET, windowMinutes: WEEK, now: at(24, 10, 10), cfg: cfg({ rollover: false }), samples });
    if (p.state !== "ok") throw new Error("stale");
    expect(p.today.spent).toBeNull();
  });

  test("the same jump seen live (no gap) is today's", () => {
    const samples: PaceSample[] = [{ t: at(23, 23, 58), used: 2 }, { t: at(24, 10, 5), used: 16 }];
    const p = pace({ usedPercent: 16, resetsAt: RESET, windowMinutes: WEEK, now: at(24, 10, 10), cfg: cfg(), samples });
    if (p.state !== "ok") throw new Error("stale");
    expect(p.today.spent).toBe(14);
  });

  test("a gap reading straight after a recent one still counts", () => {
    const samples: PaceSample[] = [{ t: at(23, 23, 58), used: 2 }, { t: at(24, 0, 1) + GAP_MS, used: 5, gap: true }];
    const p = pace({ usedPercent: 5, resetsAt: RESET, windowMinutes: WEEK, now: at(24, 10), cfg: cfg(), samples });
    if (p.state !== "ok") throw new Error("stale");
    expect(p.today.spent).toBe(3);
  });
});

describe("the caption on the day the window resets", () => {
  test("today's share ends at the reset, not at the end of work", () => {
    // Reset Wed 30 Sep 15:00, now 10:00: the share is 09-15, not 09-19.
    const p = pace({ usedPercent: 40, resetsAt: RESET, windowMinutes: WEEK, now: at(30, 10), cfg: cfg() });
    if (p.state !== "ok") throw new Error("stale");
    expect(p.today.endsAtHour).toBe(15);
  });
  test("on any other day it is the end of work", () => {
    const p = pace({ usedPercent: 40, resetsAt: RESET, windowMinutes: WEEK, now: at(29, 10), cfg: cfg() });
    if (p.state !== "ok") throw new Error("stale");
    expect(p.today.endsAtHour).toBe(19);
  });
});

describe("alertDue", () => {
  const now = at(28, 10);
  test("a window that has already reset never fires", () => {
    expect(alertDue(93, 90, at(22, 10), WEEK, now, undefined)).toBe(false);
    expect(alertDue(93, 90, now, WEEK, now, undefined)).toBe(false);
  });
  test("a reset more than a window away belongs to no window", () => {
    expect(alertDue(93, 90, now + (WEEK + 5) * 60_000, WEEK, now, undefined)).toBe(false);
  });
  test("once per window; a wobble of seconds is the same window, a week on is new", () => {
    expect(alertDue(89, 90, RESET, WEEK, now, undefined)).toBe(false);
    expect(alertDue(90, 90, RESET, WEEK, now, undefined)).toBe(true);
    expect(alertDue(97, 90, RESET + 3_000, WEEK, now, RESET)).toBe(false);
    expect(alertDue(97, 90, RESET + 7 * 86_400_000, WEEK, RESET + 86_400_000, RESET)).toBe(true);
  });
});

describe("claimPaceAlerts: one decision for every client", () => {
  let dir: string;
  let claim: typeof import("../src/paceAlert.ts");
  let prefs: typeof import("../src/notifyPrefs.ts");
  const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const now = at(28, 10);
  const rows = (used: number, resetsAt = RESET) => [{
    provider: "anthropic" as const, label: "Claude", available: true,
    windows: [
      { label: "5h", minutes: 300, usedPercent: 99, resetsAt: new Date(resetsAt).toISOString() },
      { label: "weekly", minutes: WEEK, usedPercent: used, resetsAt: new Date(resetsAt).toISOString() },
    ],
  }];
  const usageOn = () => prefs.writeNotifyPrefs({
    none: false,
    kinds: { blocked: true, idle: false, stalled: false, failures: false, autopilot: false, reminders: true, usage: true },
    channels: { desktop: true, sound: true, chip: true, bell: true },
  });
  const usageOff = () => prefs.writeNotifyPrefs({});

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-pace-claim-"));
    process.env.XDG_CONFIG_HOME = dir;
    claim = await import("../src/paceAlert.ts");
    prefs = await import("../src/notifyPrefs.ts");
    prefs.__resetNotifyPrefsCache();
  });
  afterAll(() => {
    if (saved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
    prefs.__resetNotifyPrefsCache();
    claim.__resetPaceAlerted();
    rmSync(dir, { recursive: true, force: true });
  });

  test("off by default: nothing is told and nothing is remembered", () => {
    usageOff();
    claim.__resetPaceAlerted();
    expect(claim.claimPaceAlerts(rows(96), 90, now)).toEqual([]);
    usageOn();
    expect(claim.claimPaceAlerts(rows(96), 90, now)).toHaveLength(1);
  });

  test("two clients claiming the same window: only the first wins", () => {
    usageOn();
    rmSync(claim.paceAlertedPath(), { force: true });
    claim.__resetPaceAlerted();
    const first = claim.claimPaceAlerts(rows(96), 90, now);
    const second = claim.claimPaceAlerts(rows(96), 90, now);
    expect(first.map((a) => a.label)).toEqual(["weekly"]);
    expect(second).toEqual([]);
  });

  test("a restart does not tell again", () => {
    expect(existsSync(claim.paceAlertedPath())).toBe(true);
    claim.__resetPaceAlerted();
    expect(claim.claimPaceAlerts(rows(97, RESET + 2_000), 90, now + 300_000)).toEqual([]);
  });

  test("a window that has already reset never fires, even with a fresh state", () => {
    usageOn();
    rmSync(claim.paceAlertedPath(), { force: true });
    claim.__resetPaceAlerted();
    expect(claim.claimPaceAlerts(rows(93, at(22, 10)), 90, now)).toEqual([]);
  });

  test("the next week's window is told again", () => {
    expect(claim.claimPaceAlerts(rows(95, RESET + 7 * 86_400_000), 90, RESET + 86_400_000)).toHaveLength(1);
  });

  test("coerceAlertAt keeps to the range", () => {
    expect([claim.coerceAlertAt(80), claim.coerceAlertAt(10), claim.coerceAlertAt("x"), claim.coerceAlertAt(90.5)]).toEqual([80, 90, 90, 90]);
  });
});
