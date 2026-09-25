// The browser-side half of plan pace: the settings that cannot break the
// arithmetic, the memory of how a window's used percent moved, and the glue
// that decides which windows get a pace at all.
import { describe, expect, test } from "bun:test";
import { sanitizePaceConfig } from "../../web/src/lib/paceConfig.ts";
import { appendSample, windowKey } from "../../web/src/lib/paceSamples.ts";
import { windowPace } from "../../web/src/lib/usagePace.ts";
import { DEFAULT_PACE_CONFIG } from "../../shared/pace.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("sanitizePaceConfig", () => {
  test("a missing or hand-mangled value falls back to the defaults", () => {
    for (const raw of [null, "x", 4, [], { workDays: [true], workStart: "9", workEnd: 99 }]) {
      const c = sanitizePaceConfig(raw, "Europe/Madrid");
      expect(c.workDays).toHaveLength(7);
      expect(c.workStart).toBe(DEFAULT_PACE_CONFIG.workStart);
      expect(c.workEnd).toBe(DEFAULT_PACE_CONFIG.workEnd);
      expect(c.timeZone).toBe("Europe/Madrid");
    }
  });

  test("an end at or before the start is refused as a pair, never left to divide by nothing", () => {
    const c = sanitizePaceConfig({ workStart: 18, workEnd: 18 }, "UTC");
    expect([c.workStart, c.workEnd]).toEqual([DEFAULT_PACE_CONFIG.workStart, DEFAULT_PACE_CONFIG.workEnd]);
  });

  test("valid values survive, and 24 is a legal end", () => {
    const c = sanitizePaceConfig({ spread: "all", workStart: 7, workEnd: 24, rollover: false, burnWindowHours: 6 }, "UTC");
    expect(c).toMatchObject({ spread: "all", workStart: 7, workEnd: 24, rollover: false, burnWindowHours: 6 });
  });
});

describe("appendSample", () => {
  const T = 1_000_000_000_000;
  test("only a change is kept", () => {
    let log = appendSample(undefined, T, 10);
    log = appendSample(log, T + 5 * MIN, 10);
    log = appendSample(log, T + 10 * MIN, 12);
    expect(log.samples.map((s) => s.used)).toEqual([10, 12]);
    expect(log.seen).toBe(T + 10 * MIN);
  });

  test("the first reading, and one after a long silence, are marked as gaps", () => {
    let log = appendSample(undefined, T, 10);
    expect(log.samples[0]!.gap).toBe(true);
    log = appendSample(log, T + 5 * MIN, 11);
    expect(log.samples[1]!.gap).toBeUndefined();
    log = appendSample(log, T + 5 * MIN + 3 * HOUR, 20);
    expect(log.samples[2]!.gap).toBe(true);
  });

  test("a drop starts a new window's log", () => {
    let log = appendSample(undefined, T, 90);
    log = appendSample(log, T + 5 * MIN, 91);
    log = appendSample(log, T + 10 * MIN, 2);
    expect(log.samples).toEqual([{ t: T + 10 * MIN, used: 2 }]);
  });

  test("readings older than eight days are dropped", () => {
    let log = appendSample(undefined, T, 10);
    log = appendSample(log, T + 9 * 24 * HOUR, 11);
    expect(log.samples.map((s) => s.used)).toEqual([11]);
  });

  test("per-model windows do not share a log with the weekly one", () => {
    expect(windowKey("anthropic", "weekly")).not.toBe(windowKey("anthropic", "Fable"));
  });
});

describe("windowPace", () => {
  const cfg = { ...DEFAULT_PACE_CONFIG, timeZone: "Europe/Madrid" };
  const now = Date.UTC(2026, 8, 24, 11, 37); // Thu 13:37 Madrid
  const reset = new Date(Date.UTC(2026, 8, 30, 13, 0)).toISOString();

  test("a five-hour window gets no pace", () => {
    const w = { label: "5h", minutes: 300, usedPercent: 40, resetsAt: new Date(now + 2 * HOUR).toISOString() };
    expect(windowPace("anthropic", w, now, cfg)).toBeNull();
  });

  test("a weekly window with a reset does, and a weekly one without does not", () => {
    const w = { label: "weekly", minutes: 10080, usedPercent: 12, resetsAt: reset };
    expect(windowPace("anthropic", w, now, cfg)?.pace.today.verdict).toBe("room");
    expect(windowPace("anthropic", { ...w, resetsAt: null }, now, cfg)).toBeNull();
    expect(windowPace("anthropic", { ...w, resetsAt: "not a date" }, now, cfg)).toBeNull();
  });
});

test("the alert level is kept inside 50..100", () => {
  expect(sanitizePaceConfig({ alertAt: 20 }, "UTC").alertAt).toBe(DEFAULT_PACE_CONFIG.alertAt);
  expect(sanitizePaceConfig({ alertAt: 80 }, "UTC").alertAt).toBe(80);
});
