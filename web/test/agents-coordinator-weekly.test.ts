/*
 * THE COORDINATOR'S THREE STATES, ITS WAKES, AND THE EIGHT-WEEK STRIP.
 *
 * Real shapes of a `/seat` answer with invented names. The state is the thing
 * most worth pinning: the first mockup drew "paused", which does not exist.
 */
import { describe, expect, test } from "bun:test";
import { coordinatorState, powersOn, levelAfterToggle, wakeTicks, nextLook, type SeatLike } from "../src/lib/coordinatorState.ts";
import { growthBars } from "../src/lib/weeklyStrip.ts";
import { isRoutineLine } from "../src/lib/agentsStale.ts";

const HOUR = 3_600_000;
const seat = (over: Partial<SeatLike> = {}): SeatLike =>
  ({ name: "orbit-lead", model: "opus", powers: "nudge", startedAt: 1_799_000_000_000, endedAt: null, adoptedPane: "%12", ...over });

describe("which of the three states", () => {
  test("no row at all: none", () => {
    expect(coordinatorState(null, false)).toBe("none");
    expect(coordinatorState(undefined, false)).toBe("none");
  });
  test("a row that only holds settings (never sat in) is still none", () => {
    expect(coordinatorState(seat({ startedAt: 0, endedAt: 0 }), false)).toBe("none");
  });
  test("a pane that is alive: on duty", () => {
    expect(coordinatorState(seat(), true)).toBe("on-duty");
  });
  test("it sat once and is not in the chair: stood down, whether it was told to or its pane went away", () => {
    expect(coordinatorState(seat({ endedAt: 1_799_500_000_000 }), false)).toBe("stood-down");
    expect(coordinatorState(seat({ endedAt: null }), false)).toBe("stood-down");
  });
  test("being live wins over a stale end stamp", () => {
    expect(coordinatorState(seat({ endedAt: 1_799_500_000_000 }), true)).toBe("on-duty");
  });
});

describe("the three powers", () => {
  test("they are cumulative", () => {
    expect(powersOn("speak").map((p) => p.on)).toEqual([true, false, false]);
    expect(powersOn("nudge").map((p) => p.on)).toEqual([true, true, false]);
    expect(powersOn("assign").map((p) => [p.label, p.on])).toEqual([["Speaks", true], ["Unsticks", true], ["Assigns", true]]);
  });
  test("a toggle moves the level by one step either way, and Speaks cannot be switched off", () => {
    expect(levelAfterToggle("speak", "nudge")).toBe("nudge");
    expect(levelAfterToggle("nudge", "nudge")).toBe("speak");
    expect(levelAfterToggle("speak", "assign")).toBe("assign");
    expect(levelAfterToggle("assign", "assign")).toBe("nudge");
    expect(levelAfterToggle("assign", "nudge")).toBe("speak");
    expect(levelAfterToggle("nudge", "speak")).toBe("nudge");
  });
});

describe("the last day, as five marks and now", () => {
  const NOW = new Date(2027, 0, 15, 13, 0).getTime();
  const at = (h: number, m = 0) => new Date(2027, 0, 15, h, m).getTime();
  const lines = [
    { at: at(9, 49), line: "two upload branches overlap, asked the person" },
    { at: at(10, 5), line: "(looked at 10:05 — nothing had changed, so nobody was woken)" },
    { at: at(12, 30), line: "(looked at 12:30 — nothing had changed, so nobody was woken)" },
    { at: NOW - 30 * HOUR, line: "older than a day" },
  ];
  test("a mark is blue when the orchestrator said something real in it, with when; the last is now", () => {
    const t = wakeTicks(lines, NOW, isRoutineLine);
    expect(t.map((x) => x.kind)).toEqual(["empty", "empty", "empty", "empty", "woke", "now"]);
    expect(t[4]!.label).toBe("9:49");
    expect(t[5]!.label).toBe("now");
  });
  test("routine rounds are not wakes, and neither is anything older than a day", () => {
    const t = wakeTicks(lines.slice(1), NOW, isRoutineLine);
    expect(t.filter((x) => x.kind === "woke")).toHaveLength(0);
  });
  test("two real lines in one window: the later one names it", () => {
    const t = wakeTicks([{ at: at(9, 49), line: "a" }, { at: at(11, 2), line: "b" }], NOW, isRoutineLine);
    expect(t[4]!.label).toBe("11:02");
  });
  test("a window five fifths back is the first mark", () => {
    const t = wakeTicks([{ at: NOW - 23 * HOUR, line: "overnight" }], NOW, isRoutineLine);
    expect(t[0]!.kind).toBe("woke");
  });
});

describe("how long until the next look", () => {
  const NOW = 1_800_000_000_000;
  test("hours while it is far, minutes when it is near, never zero", () => {
    expect(nextLook(NOW - 1 * HOUR, 4, NOW)).toEqual({ pct: 25, left: "3 h" });
    expect(nextLook(NOW - 3.5 * HOUR, 4, NOW).left).toBe("30 min");
    expect(nextLook(NOW - 9 * HOUR, 4, NOW)).toEqual({ pct: 100, left: "1 min" });
  });
  test("never woken: the whole floor is ahead", () => {
    expect(nextLook(null, 4, NOW)).toEqual({ pct: 0, left: "4 h" });
  });
});

describe("the eight weeks", () => {
  /* acme/orbit as the approved design draws it: 4 base + 12 learned, 16 rules at the end of the last week. */
  const ORBIT = [0, 0, 1, 2, 1, 3, 2, 3];
  test("each bar is what the project had that week: base block plus what had been learned by then, at the design's three pixels a rule", () => {
    const bars = growthBars(ORBIT, 4, 12);
    expect(bars.map((b) => b.total)).toEqual([4, 4, 5, 7, 8, 11, 13, 16]);
    expect(bars.map((b) => b.learnedPx)).toEqual([0, 0, 3, 9, 12, 21, 27, 36]);
    expect(bars.every((b) => b.basePx === 12)).toBe(true);
    expect(bars.map((b) => b.current)).toEqual([false, false, false, false, false, false, false, true]);
  });
  test("acme/ledger: 4 base + 5 learned, 9 rules, +2 this week", () => {
    expect(growthBars([0, 0, 0, 1, 1, 0, 1, 2], 4, 5).map((b) => b.total)).toEqual([4, 4, 4, 5, 6, 6, 7, 9]);
  });
  test("the scale shrinks only when the busiest bar would pass the strip", () => {
    const bars = growthBars([0, 0, 0, 0, 0, 0, 20, 20], 4, 40, 64);
    expect(bars[7]!.basePx + bars[7]!.learnedPx).toBeLessThanOrEqual(64);
    expect(bars[7]!.basePx + bars[7]!.learnedPx).toBeGreaterThanOrEqual(63);
  });
  test("a small block stays visible: one learned rule on two hundred base rules is a pixel, not none", () => {
    const big = growthBars([0, 0, 0, 0, 0, 0, 0, 1], 200, 1, 64);
    expect(big[7]!.learnedPx).toBe(1);
  });
  test("a young project is padded on the left with the base alone", () => {
    const bars = growthBars([2, 6], 4, 8);
    expect(bars.map((b) => b.total)).toEqual([4, 4, 4, 4, 4, 4, 6, 12]);
    expect(bars[7]!.current).toBe(true);
  });
  test("learned rules from before the window sit in every bar", () => {
    expect(growthBars([0, 0, 0, 0, 0, 0, 0, 1], 4, 10).map((b) => b.total)).toEqual([13, 13, 13, 13, 13, 13, 13, 14]);
  });
  test("more than eight weeks keep the latest eight; junk is zero; rules since removed never make a bar negative", () => {
    expect(growthBars([9, 9, 1, 2, 3, 4, 5, 6, 7, 8], 0, 36).map((b) => b.total)).toEqual([1, 3, 6, 10, 15, 21, 28, 36]);
    expect(growthBars([NaN, -3, 4], 4, 4).map((b) => b.total).slice(-3)).toEqual([4, 4, 8]);
    expect(growthBars([5, 5], 4, 2).every((b) => b.total >= 4 && b.learnedPx >= 0)).toBe(true);
  });
  test("an empty history is eight base-only bars, not a division by zero", () => {
    const bars = growthBars([], 0, 0);
    expect(bars).toHaveLength(8);
    expect(bars.every((b) => b.total === 0 && b.basePx === 0 && b.learnedPx === 0)).toBe(true);
  });
});
