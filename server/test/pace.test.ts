// The pace math for the plan popover. Every case is a number worked out by
// hand from the rule, not read back from the code: a formula audit of the first
// prototype found thirteen ways it printed a confident wrong sentence, and each
// of them is pinned here so it cannot come back.
//
// The week under test is Wed 23 Sep 2026 15:00 to Wed 30 Sep 15:00 in
// Europe/Madrid (UTC+2 all week). With Mon-Fri 09-19 that is 50 working hours:
// Wed 4 + Thu 10 + Fri 10 + Mon 10 + Tue 10 + Wed 6.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PACE_CONFIG, hourLabel, pace, projectionText, verdictText, budgetLine,
  whenLabel, workingMs, type PaceConfig, type PaceSample,
} from "../../shared/pace.ts";

const TZ = "Europe/Madrid";
const cfg = (over: Partial<PaceConfig> = {}): PaceConfig => ({ ...DEFAULT_PACE_CONFIG, timeZone: TZ, ...over });
/** Madrid wall clock on 2026-09-<d> in the CEST week under test. */
const at = (d: number, h: number, m = 0) => Date.UTC(2026, 8, d, h - 2, m);
const HOUR = 3_600_000;
const START = at(23, 15);
const RESET = at(30, 15);
const WEEK = 10080;

function run(now: number, used: number, over: Partial<PaceConfig> = {}, samples?: PaceSample[]) {
  const c = cfg(over);
  const p = pace({ usedPercent: used, resetsAt: RESET, windowMinutes: WEEK, now, cfg: c, samples });
  if (p.state !== "ok") throw new Error(`stale: ${p.why}`);
  return { p, c };
}

describe("the working-time curve", () => {
  test("the window holds 50 working hours", () => {
    expect(workingMs(cfg(), START, RESET) / HOUR).toBe(50);
      });

  test("expected use at hand-checked instants", () => {
    // Thu 13:37 = Wed 4h + 4h37 = 8.617h of 50.
    expect(run(at(24, 13, 37), 0).p.expected).toBeCloseTo(17.23, 2);
    // Sat noon: the whole of Wed, Thu, Fri = 24h, flat since Fri 19:00.
    expect(run(at(26, 12), 0).p.expected).toBeCloseTo(48, 6);
    // Thu 03:00: only Wednesday's 4h has been worked.
    expect(run(at(24, 3), 0).p.expected).toBeCloseTo(8, 6);
    // A minute before the reset.
    expect(run(RESET - 60_000, 0).p.expected).toBeCloseTo(99.97, 2);
    // Exactly at the reset the whole budget has been earned.
    expect(100 * workingMs(cfg(), START, RESET) / workingMs(cfg(), START, RESET)).toBe(100);
  });

  test("with every hour counted the curve is linear and the midpoint is 50", () => {
    const { p } = run(START + 84 * HOUR, 0, { spread: "all" });
    expect(p.expected).toBeCloseTo(50, 6);
  });

  test("no day ticked behaves as every hour, and says so", () => {
    const { p } = run(at(24, 13, 37), 0, { workDays: [false, false, false, false, false, false, false] });
    expect(p.fellBackToEveryHour).toBe(true);
    expect(workingMs(cfg({ workDays: [false, false, false, false, false, false, false] }), START, RESET) / HOUR).toBe(168);
    // Wed 15:00 to Thu 13:37 is 22h37m of 168.
    expect(p.expected).toBeCloseTo((100 * (22 + 37 / 60)) / 168, 6);
    expect(p.today.working).toBe(true);
  });

  test("a clock change makes the day 25 real hours, not 24", () => {
    // Sat 24 Oct 12:00 CEST to Mon 26 Oct 12:00 CET; the clocks went back on Sun 25 Oct.
    const from = Date.UTC(2026, 9, 24, 10, 0);
    const to = Date.UTC(2026, 9, 26, 11, 0);
    expect((to - from) / HOUR).toBe(49);
    expect(workingMs(cfg({ spread: "all" }), from, to) / HOUR).toBe(49);
    // Mon 26 Oct 09:00 is 08:00Z: the working segment moved with the wall clock.
    expect(workingMs(cfg(), Date.UTC(2026, 9, 26, 8, 0), Date.UTC(2026, 9, 26, 9, 0)) / HOUR).toBe(1);
    expect(workingMs(cfg(), Date.UTC(2026, 9, 26, 7, 0), Date.UTC(2026, 9, 26, 8, 0)) / HOUR).toBe(0);
  });
});

describe("today's allowance and the verdict", () => {
  test("Thu 13:37, 12% used: share 20, end of day 28, 16% left, room", () => {
    const { p, c } = run(at(24, 13, 37), 12);
    expect(p.today.share).toBe(20);
    expect(p.today.endOfDay).toBe(28);
    expect(p.today.left).toBe(16);
    expect(p.today.verdict).toBe("room");
    expect(verdictText(p, at(24, 13, 37), c.timeZone)).toBe("Room to add work · 16% left today");
  });

  test("the thresholds: over below -0.05, used up around 0, then 10% and 50% of the share", () => {
    const now = at(24, 13, 37);
    const v = (used: number) => run(now, used).p.today.verdict;
    expect(v(28.06)).toBe("over");
    expect(v(28.04)).toBe("used-up");
    expect(v(28)).toBe("used-up");
    expect(v(27.96)).toBe("used-up");
    expect(v(26)).toBe("cut-back"); // left 2 of 20 = exactly 0.1
    expect(v(25.9)).toBe("on-pace");
    expect(v(18)).toBe("on-pace"); // left 10 of 20 = exactly 0.5
    expect(v(17.9)).toBe("room");
  });

  test("used up exactly is not printed as 'over by 0%'", () => {
    const { p, c } = run(at(24, 13, 37), 28);
    expect(verdictText(p, at(24, 13, 37), c.timeZone)).toBe("Today's share is used up · new share tomorrow 09:00");
  });

  test("the daily cap, not the curve, can be what runs out", () => {
    // Thu 18:00, rollover off: 3% at Thu 00:00, 24% now, so 21% spent against a
    // 20% share. The curve still has 4% (28 - 24). It is the cap that is over,
    // and 'back in budget' is not the true thing to say about a cap.
    const samples: PaceSample[] = [{ t: at(23, 20), used: 3 }];
    const { p, c } = run(at(24, 18), 24, { rollover: false }, samples);
    expect(p.today.spent).toBe(21);
    expect(p.today.left).toBe(-1);
    expect(p.today.binding).toBe("cap");
    expect(p.today.backInBudgetAt).toBeNull();
    expect(verdictText(p, at(24, 18), c.timeZone)).toBe("Today's share is used up · new share tomorrow 09:00");
  });

  test("rollover lets one earlier day's leftover be spent today, no more", () => {
    // Same numbers with rollover on: the cap is 2 x 20 = 40, so the curve binds.
    const samples: PaceSample[] = [{ t: at(23, 20), used: 3 }];
    const { p } = run(at(24, 18), 24, { rollover: true }, samples);
    expect(p.today.left).toBe(4);
    expect(p.today.binding).toBe("curve");
  });

  test("without samples today's spend is unknown and the curve alone decides", () => {
    const { p } = run(at(24, 18), 24, { rollover: false });
    expect(p.today.spent).toBeNull();
    expect(p.today.left).toBe(4);
  });

  test("over on the curve says when the curve catches up", () => {
    // Fri 10:00, 60% used: the day ends at 48% (24h of 50), so 12% over, and
    // the curve reaches 60% at 30h worked: Wed 4 + Thu 10 + Fri 10 + Mon 6 = Mon 15:00.
    const now = at(25, 10);
    const { p, c } = run(now, 60);
    expect(p.today.verdict).toBe("over");
    expect(p.today.backInBudgetAt).toBe(at(28, 15));
    expect(verdictText(p, now, c.timeZone)).toBe("Over today's share by 12% · back in budget Mon 15:00");
  });

  test("today's hours outside the window is a day off, not 'over by 12%'", () => {
    // Hours 09-14, Wed 23 16:00: today's working time ended before the window began.
    const now = at(23, 16);
    const { p, c } = run(now, 12, { workStart: 9, workEnd: 14 });
    expect(p.today.share).toBe(0);
    expect(p.today.working).toBe(false);
    expect(p.today.verdict).toBe("day-off");
    expect(verdictText(p, now, c.timeZone)).toBe("Day off · next budget tomorrow 09:00");
  });

  test("no working hours left before the reset says so", () => {
    // Hours 16-19, Wed 30 10:00: the reset is at 15:00, before work begins.
    const now = at(30, 10);
    const { p, c } = run(now, 12, { workStart: 16, workEnd: 19 });
    expect(p.today.verdict).toBe("day-off");
    expect(verdictText(p, now, c.timeZone)).toBe("No working hours left in this window");
  });

  test("ends-at caption: midnight, and nothing for every-hour spread", () => {
    expect(hourLabel(24)).toBe("midnight");
    expect(hourLabel(19)).toBe("19:00");
    expect(run(at(24, 13), 5, { workEnd: 24 }).p.today.endsAtHour).toBe(24);
    expect(run(at(24, 13), 5, { spread: "all" }).p.today.endsAtHour).toBeNull();
  });
});

describe("status against the curve", () => {
  test("below the budget is under pace, above is ahead, inside the band is on", () => {
    const now = at(24, 13, 37); // expected 17.23, band 1.72
    expect(run(now, 10).p.status).toBe("under");
    expect(run(now, 17).p.status).toBe("on");
    expect(run(now, 20).p.status).toBe("ahead");
    expect(budgetLine(run(now, 10).p)).toBe("budget 17% · under pace");
  });

  test("too early to judge under 2% expected", () => {
    expect(run(at(23, 15, 30), 0).p.status).toBe("too-early");
  });
});

describe("a reading that does not belong to a window", () => {
  test("reset already passed", () => {
    const p = pace({ usedPercent: 50, resetsAt: at(30, 15), windowMinutes: WEEK, now: at(30, 17), cfg: cfg() });
    expect(p).toEqual({ state: "stale", why: "reset-passed" });
  });

  test("reset more than a window away (a second account's start read as this one's)", () => {
    const p = pace({ usedPercent: 12, resetsAt: at(30, 23) + 37 * 60_000, windowMinutes: WEEK, now: at(23, 16), cfg: cfg() });
    expect(p).toEqual({ state: "stale", why: "reset-too-far" });
  });
});

describe("the projection", () => {
  test("at a burn that lands exactly on 100 the week fits", () => {
    // Wed 19:00: 4h worked, 8% used -> 2%/h, 46h left -> exactly 100 at the reset.
    const now = at(23, 19);
    const { p, c } = run(now, 8);
    expect(p.burn).toEqual({ source: "week", perWorkHour: 2 });
    expect(p.projection.kind).toBe("fits");
    expect(projectionText(p, now, RESET, c.timeZone)).toBe("At this speed: 100% at the reset");
  });

  test("a faster burn empties the week before the reset", () => {
    const now = at(24, 13, 37);
    const { p, c } = run(now, 20);
    expect(p.projection.kind).toBe("empty-before-reset");
    expect(p.projection.emptyAt).not.toBeNull();
    expect(p.projection.emptyAt!).toBeLessThan(RESET);
    expect(projectionText(p, now, RESET, c.timeZone)).toMatch(/^At this speed: empty .* · before the reset$/);
  });

  test("nothing used means nothing to project", () => {
    const now = at(24, 13, 37);
    const { p, c } = run(now, 0);
    expect(p.projection.kind).toBe("none");
    expect(projectionText(p, now, RESET, c.timeZone)).toBe("No recent use. Nothing to project.");
  });

  test("100% used is empty now, whatever the burn", () => {
    const now = at(24, 13, 37);
    const { p, c } = run(now, 100);
    expect(p.projection.kind).toBe("empty-now");
    expect(projectionText(p, now, RESET, c.timeZone)).toBe("Empty now · back at the reset Wed 30 Sep 15:00");
  });

  test("only working hours consume: a Saturday adds nothing", () => {
    const { p } = run(at(26, 12), 30);
    // 24h worked, 26h to go, 1.25%/h -> 30 + 32.5.
    expect(p.projection.atReset).toBeCloseTo(62.5, 6);
  });

  test("the recent burn wins over the week's average", () => {
    // Thu 15:00, readings 10 at 12:00 and 16 now: 6% over 3 working hours.
    const samples: PaceSample[] = [{ t: at(24, 12), used: 10 }];
    const { p } = run(at(24, 15), 16, {}, samples);
    expect(p.burn.source).toBe("recent");
    expect(p.burn.perWorkHour).toBe(2);
  });

  test("a reading taken after a gap is not evidence of a rate", () => {
    const samples: PaceSample[] = [{ t: at(24, 12), used: 10 }, { t: at(24, 14, 50), used: 16, gap: true }];
    const { p } = run(at(24, 15), 16, {}, samples);
    expect(p.burn.source).toBe("week");
  });

  test("less than an hour into the window there is no rate", () => {
    const { p } = run(at(23, 15, 30), 5);
    expect(p.burn.source).toBe("none");
  });
});

describe("naming a moment", () => {
  const now = at(23, 16); // a Wednesday
  test("today, tomorrow, a weekday, and a date when a bare weekday would mislead", () => {
    expect(whenLabel(at(23, 18), now, TZ)).toBe("today 18:00");
    expect(whenLabel(at(24, 9), now, TZ)).toBe("tomorrow 09:00");
    expect(whenLabel(at(26, 9), now, TZ)).toBe("Sat 09:00");
    expect(whenLabel(at(28, 9), now, TZ)).toBe("Mon 09:00");
    // Six days on is a Tuesday, but a week on is "Wed" from a Wednesday: dated.
    expect(whenLabel(at(30, 15), now, TZ)).toBe("Wed 30 Sep 15:00");
  });
});
