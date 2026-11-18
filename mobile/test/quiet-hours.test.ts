/*
 * Quiet hours: the window, across midnight, and the one exception.
 *
 * The arithmetic is the whole risk: 22:00-07:00 is the window people choose
 * and `from <= t && t < to` is a window that never fires. The gate in policy.ts
 * is checked through `shouldNotify`, so the exception (a stopped agent) is held
 * to the same rule the phone uses.
 */
import { describe, expect, test } from "bun:test";
import {
  FROM_CHOICES, QUIET_DEFAULT, TO_CHOICES, clockText, cycle, heldByQuiet, inQuietWindow, quietText, sanitizeQuiet,
  type QuietPref,
} from "../src/model/quietHours.ts";
import { shouldNotify } from "../src/notifications/policy.ts";

const at = (h: number, m = 0): Date => new Date(2026, 10, 3, h, m, 0, 0);
const pref = (patch: Partial<QuietPref> = {}): QuietPref => ({ ...QUIET_DEFAULT, ...patch });

describe("the window", () => {
  test("a window that crosses midnight is the one that has to work", () => {
    const p = pref(); // 22:00 - 07:00
    expect(inQuietWindow(p, at(22, 0))).toBe(true);
    expect(inQuietWindow(p, at(23, 30))).toBe(true);
    expect(inQuietWindow(p, at(0, 5))).toBe(true);
    expect(inQuietWindow(p, at(6, 59))).toBe(true);
    // The end is exclusive: 07:00 is when it rings again.
    expect(inQuietWindow(p, at(7, 0))).toBe(false);
    expect(inQuietWindow(p, at(12, 0))).toBe(false);
    expect(inQuietWindow(p, at(21, 59))).toBe(false);
  });

  test("a same-day window is not a window of zero", () => {
    const p = pref({ from: 9 * 60, to: 17 * 60 });
    expect(inQuietWindow(p, at(9, 0))).toBe(true);
    expect(inQuietWindow(p, at(16, 59))).toBe(true);
    expect(inQuietWindow(p, at(17, 0))).toBe(false);
    expect(inQuietWindow(p, at(8, 59))).toBe(false);
  });

  test("off never holds anything, whatever the hour", () => {
    expect(heldByQuiet(pref({ on: false }), 1, at(2, 0))).toBe(false);
  });
});

describe("the stopped-agent exception", () => {
  test("urgency 2 passes when the switch says so, and only urgency 2", () => {
    expect(heldByQuiet(pref({ on: true, agents: true }), 2, at(3, 0))).toBe(false);
    expect(heldByQuiet(pref({ on: true, agents: true }), 1, at(3, 0))).toBe(true);
    expect(heldByQuiet(pref({ on: true, agents: true }), 0, at(3, 0))).toBe(true);
    expect(heldByQuiet(pref({ on: true, agents: false }), 2, at(3, 0))).toBe(true);
  });

  test("shouldNotify reports quiet, and lets a stopped agent through", () => {
    const ctx = (agents: boolean) => ({
      foreground: false, lastSeen: new Map(), now: at(23, 0).getTime(), quiet: pref({ on: true, agents }),
    });
    const alert = { title: "api-tests stopped", body: "waiting on you", urgency: 1 as const };
    expect(shouldNotify(alert, ctx(false))).toEqual({ notify: false, because: "quiet" });
    expect(shouldNotify({ ...alert, urgency: 2 }, ctx(true))).toEqual({ notify: true });
    // Out of the window, the same alert rings.
    expect(shouldNotify(alert, { ...ctx(false), now: at(12, 0).getTime() })).toEqual({ notify: true });
  });

  test("low urgency is refused for its own reason, not for the hour", () => {
    const verdict = shouldNotify(
      { title: "noted", body: "nothing to do", urgency: 0 },
      { foreground: false, lastSeen: new Map(), now: at(23, 0).getTime(), quiet: pref() },
    );
    expect(verdict).toEqual({ notify: false, because: "low" });
  });
});

describe("reading what was stored", () => {
  test("nonsense is the default, field by field", () => {
    expect(sanitizeQuiet(null)).toEqual(QUIET_DEFAULT);
    expect(sanitizeQuiet({ on: "yes", from: 5000, to: -1, agents: 3 })).toEqual(QUIET_DEFAULT);
    expect(sanitizeQuiet({ on: false })).toEqual({ ...QUIET_DEFAULT, on: false });
  });

  test("the row's value and the clock are the same words", () => {
    expect(clockText(22 * 60)).toBe("22:00");
    expect(clockText(0)).toBe("00:00");
    expect(quietText(pref({ on: true }))).toBe("22:00 – 07:00");
    expect(quietText(pref())).toBe("Off");
  });

  test("a tap on a time always changes it", () => {
    let t = FROM_CHOICES[0]!;
    const seen = new Set([t]);
    for (let i = 0; i < FROM_CHOICES.length; i += 1) { t = cycle(t, FROM_CHOICES); seen.add(t); }
    expect(seen.size).toBe(FROM_CHOICES.length);
    expect(TO_CHOICES.length).toBeGreaterThan(1);
  });
});
