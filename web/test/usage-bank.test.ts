/*
 * The decisions behind the bank, tested away from the renderer.
 *
 * The numbers are the mockup's: a week 58% gone with 71% used is 13 points
 * over, and that pace empties the week two days before it resets. Every guard
 * here was broken on purpose and watched go red before it was trusted.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
import { stubStorage } from "./stubStorage";
import type { ProviderUsage, QuotaWindow } from "../../shared/types.ts";
import type * as Bank from "../src/lib/usageBank.ts";

// `resetLabel` lives in usageStore, which reads `location` and storage at
// module load; the same stub every store test uses.
stubStorage();
const stubGlobal = globalStubs();

let windowTitle: typeof Bank.windowTitle;
let windowTag: typeof Bank.windowTag;
let spanPhrase: typeof Bank.spanPhrase;
let sheetSentence: typeof Bank.sheetSentence;
let sheetTail: typeof Bank.sheetTail;
let resetWhen: typeof Bank.resetWhen;
let paceBudget: typeof Bank.paceBudget;
let paceVerdict: typeof Bank.paceVerdict;
let runsOut: typeof Bank.runsOut;
let groupWindows: typeof Bank.groupWindows;
let bankTip: typeof Bank.bankTip;
let foldCells: typeof Bank.foldCells;
let BANK_CELL_PX: number;
let BANK_PLUS_PX: number;

beforeAll(async () => {
  stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
  ({
    windowTitle, windowTag, spanPhrase, sheetSentence, sheetTail, paceBudget, paceVerdict,
    runsOut, groupWindows, bankTip, foldCells, BANK_CELL_PX, BANK_PLUS_PX, resetWhen,
  } = await import("../src/lib/usageBank.ts"));
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-31T12:00:00Z");

/** A window whose reset is `leftMinutes` away, ending `minutes` after it started. */
const win = (minutes: number, usedPercent: number, leftMinutes: number | null, label = ""): QuotaWindow => ({
  label: label || (minutes === 300 ? "5h" : minutes === 10080 ? "weekly" : minutes === 43200 ? "monthly" : "x"),
  minutes,
  usedPercent,
  resetsAt: leftMinutes === null ? null : new Date(NOW + leftMinutes * 60_000).toISOString(),
});

describe("what a window is called", () => {
  test("the three plan windows get their own names, a model bucket keeps its own", () => {
    expect(windowTitle(win(300, 4, 221))).toBe("5-hour window");
    expect(windowTitle(win(10080, 71, 5740))).toBe("weekly window");
    expect(windowTitle(win(43200, 1, 43080))).toBe("monthly window");
    expect(windowTitle(win(10080, 4, 5740, "Orbit"))).toBe("Orbit weekly");
  });

  test("the tag names the window the number belongs to", () => {
    expect(windowTag(win(300, 4, 10))).toBe("5h");
    expect(windowTag(win(10080, 4, 10))).toBe("wk");
    expect(windowTag(win(43200, 4, 10))).toBe("mo");
    expect(windowTag(win(10080, 4, 10, "Orbit"))).toBe("models");
  });

  test("the sheet's sentence carries the window and the reset", () => {
    const s = sheetSentence(win(10080, 71, 3 * DAY), NOW);
    expect(s).toContain("71% of the week is used");
    expect(s).toContain("resets");
    // A provider that does not say when the window ends gets no invented reset.
    expect(sheetSentence(win(10080, 71, null), NOW)).toBe("71% of the week is used");
  });

  test("a reset already behind the sheet's clock says nothing, rather than 'resets now'", () => {
    // The sheet freezes `now` at open. A 5-hour window 40s from its reset, left
    // open a minute, used to read "resets now" over a row that still said
    // "Resets in 1m" and drew its pace marker.
    const w = win(300, 4, 40 / 60);
    expect(sheetTail(w, NOW)).toContain("resets in");
    expect(sheetSentence(w, NOW + 60_000)).toBe("4% of the 5-hour window is used");
  });

  test("the one reset helper every printer asks: empty once the window is over", () => {
    // The headline, the hover and the row said two different things about the
    // same ended window: "38% of the week is used" above, "Resets now" below.
    expect(resetWhen(win(300, 4, 221), NOW)).toBe("in 3h 41m");
    expect(resetWhen(win(10080, 38, -2 * 24 * 60), NOW)).toBe("");
    expect(resetWhen(win(10080, 38, null), NOW)).toBe("");
    expect(resetWhen({ ...win(300, 4, 10), resetsAt: "not a date" }, NOW)).toBe("");
  });

  test("measures the reset on the clock it was handed, not the wall clock", () => {
    const w = win(300, 4, 40);
    expect(sheetTail(w, NOW)).toContain("resets in 40m");
    expect(sheetTail(w, NOW + 39 * 60_000)).toContain("resets in 1m");
    expect(sheetTail(w, NOW + 41 * 60_000)).not.toContain("resets");
  });

  test("a per-model bucket is the Opus week, not the Opus weekly", () => {
    expect(spanPhrase(win(10080, 4, 5740, "Orbit"))).toBe("Orbit week");
    expect(sheetSentence(win(10080, 100, 5740, "Orbit"), NOW)).toContain("of the Orbit week is used");
    expect(spanPhrase(win(10080, 71, 5740))).toBe("week");
  });

  test("a reset under a day keeps its preposition: resets in 3h 41m", () => {
    const soon = { ...win(300, 4, 221), resetsAt: new Date(Date.now() + 3.7 * HOUR).toISOString() };
    expect(sheetTail(soon)).toContain("resets in 3h");
  });
});

describe("the pace budget", () => {
  test("is the share of the window that has gone by", () => {
    // A week with 3 days left: 4/7 gone.
    expect(paceBudget(win(10080, 71, 3 * 24 * 60), NOW)).toBe(57);
    expect(paceBudget(win(300, 4, 221), NOW)).toBe(26);
  });

  test("is unknown, not zero, when there is no reset to measure against", () => {
    expect(paceBudget(win(10080, 71, null), NOW)).toBeNull();
    expect(paceBudget({ label: "x", minutes: 0, usedPercent: 1, resetsAt: "2026-11-01T00:00:00Z" }, NOW)).toBeNull();
    expect(paceBudget({ label: "x", minutes: 300, usedPercent: 1, resetsAt: "not a date" }, NOW)).toBeNull();
  });

  test("a window whose reset has passed has no budget at all", () => {
    // A row written three days ago still carries that day's reset. Clamping to
    // 100% would print "80 points under" in green under a reset that is over.
    expect(paceBudget(win(300, 4, -600), NOW)).toBeNull();
    expect(paceBudget(win(300, 4, 0), NOW)).toBeNull();
    expect(paceBudget(win(300, 4, 900), NOW)).toBe(0);
  });

  test("points over and under are the distance to the budget", () => {
    expect(paceVerdict(71, 58)).toEqual({ points: 13, tone: "over", text: "13 points over" });
    expect(paceVerdict(4, 18)).toEqual({ points: 14, tone: "under", text: "14 points under" });
    expect(paceVerdict(58, 58).tone).toBe("level");
    expect(paceVerdict(59, 58).text).toBe("1 point over");
  });
});

describe("the runs-out sentence", () => {
  test("says when the week empties and how long before the reset", () => {
    // 71% used of a week 4/7 gone: the rate empties it in 4d * 29/71 ≈ 1d 15h,
    // while the reset is 3 days off.
    const s = runsOut(win(10080, 71, 3 * 24 * 60), 57, NOW);
    expect(s).toContain("runs out");
    expect(s).toContain("before it resets");
    expect(s).toMatch(/one day|two days/);
  });

  test("is silent when the window resets first", () => {
    // 10% used, half the week gone: no danger at this pace.
    expect(runsOut(win(10080, 10, 3 * 24 * 60), 50, NOW)).toBeNull();
  });

  test("is silent with no budget, no reset, or a window just started", () => {
    expect(runsOut(win(10080, 71, null), 57, NOW)).toBeNull();
    expect(runsOut(win(10080, 71, 3 * 24 * 60), null, NOW)).toBeNull();
    expect(runsOut(win(10080, 71, 3 * 24 * 60), 0, NOW)).toBeNull();
    expect(runsOut(win(10080, 71, 3 * 24 * 60), 100, NOW)).toBeNull();
  });

  test("a per-model bucket is named as a week, not as an adjective", () => {
    const s = runsOut(win(10080, 71, 3 * 24 * 60, "Orbit"), 57, NOW);
    expect(s).toContain("the Orbit week runs out");
  });

  test("a window already spent says nothing rather than dividing by zero", () => {
    expect(runsOut(win(300, 0, 100), 50, NOW)).toBeNull();
    expect(runsOut(win(300, 100, 100), 50, NOW)).toBeNull();
  });
});

describe("the sheet's rows", () => {
  test("shortest window first, per-model buckets folded into one row", () => {
    const g = groupWindows([
      win(10080, 4, 100, "Orbit"), win(300, 0, 10), win(10080, 71, 100), win(10080, 2, 100, "Acme"),
    ]);
    expect(g.map((x) => x.title)).toEqual(["5-hour window", "Weekly window", "Per-model weekly"]);
    expect(g[2]!.windows.map((w) => w.label)).toEqual(["Orbit", "Acme"]);
  });

  test("a window the provider does not report is absent, not zero", () => {
    const g = groupWindows([win(300, 4, 100)]);
    expect(g).toHaveLength(1);
    expect(g[0]!.title).toBe("5-hour window");
    expect(groupWindows([])).toEqual([]);
  });
});

describe("the bar's tooltip", () => {
  const row = (extra: Partial<ProviderUsage> = {}): ProviderUsage => ({
    provider: "opencode", label: "OpenCode Go", available: true, windows: [], ...extra,
  });

  test("carries the full sentence and the reset", () => {
    const t = bankTip(row(), win(300, 4, 221), NOW);
    expect(t).toBe("OpenCode Go — 5-hour window 4% used · resets in 3h 41m. Open details.");
  });

  test("a provider with no reading gets its own note and no percent", () => {
    const t = bankTip(row({ available: false, note: "Quota not reported." }), null, NOW);
    expect(t).toContain("no reading");
    expect(t).toContain("Quota not reported.");
    expect(t).not.toMatch(/\d+%/);
  });

  test("an ended window's reset is not promised in the hover either", () => {
    // The row under it said "Resets now" for a window that ended two days ago.
    expect(bankTip(row(), win(10080, 38, 3 * 24 * 60), NOW)).toContain("resets");
    expect(bankTip(row(), win(10080, 38, -2 * 24 * 60), NOW)).not.toContain("resets");
    expect(bankTip(row(), win(10080, 38, null), NOW)).not.toContain("resets");
  });
});

describe("folding the tail", () => {
  test("the mockup's three widths", () => {
    expect(foldCells(196, 4)).toEqual({ shown: 4, hidden: 0 });
    expect(foldCells(200, 4)).toEqual({ shown: 4, hidden: 0 });
    expect(foldCells(150, 4)).toEqual({ shown: 2, hidden: 2 });
    expect(foldCells(110, 4)).toEqual({ shown: 1, hidden: 3 });
  });

  test("never claims a cell it has no room for, and an unmeasured bar shows every provider", () => {
    // Under one cell plus the +n there is nothing to draw: a cell kept here was
    // clipped by the bar's own overflow, taking the +n with it.
    expect(foldCells(0, 4)).toEqual({ shown: 0, hidden: 4 });
    expect(foldCells(BANK_PLUS_PX + BANK_CELL_PX - 1, 4)).toEqual({ shown: 0, hidden: 4 });
    expect(foldCells(BANK_PLUS_PX + BANK_CELL_PX, 4)).toEqual({ shown: 1, hidden: 3 });
    expect(foldCells(Number.POSITIVE_INFINITY, 4)).toEqual({ shown: 4, hidden: 0 });
  });

  test("the fold arithmetic holds at the exact boundary a fourth cell needs", () => {
    // Two cells and the +n button fit, a third does not — the width the bar
    // measures against, not a constant asserted against a literal.
    expect(foldCells(BANK_CELL_PX * 2 + BANK_PLUS_PX, 3)).toEqual({ shown: 2, hidden: 1 });
    expect(foldCells(BANK_CELL_PX * 3 + BANK_PLUS_PX, 3)).toEqual({ shown: 3, hidden: 0 });
  });
});
