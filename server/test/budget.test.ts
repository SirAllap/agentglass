/*
 * Budgets, and the arithmetic nobody notices is wrong for a month.
 *
 * Spend insights fired on constants — $15 in fifteen minutes is "burning fast",
 * $60 an hour is a warning — which is noise on a project that genuinely costs
 * that and silence on one where a tenth would be alarming. A budget replaces
 * the constant with a number somebody chose.
 *
 * Which makes the boundaries load-bearing in a way a threshold never was. A
 * monthly budget that starts on the wrong day, or resets in the wrong timezone,
 * is not a visible bug: it is a number on a dashboard that is quietly a
 * different number from the one the user is thinking of, and the first time
 * anybody finds out is at the end of a month.
 *
 * So the window is computed against fixed instants here rather than against
 * `Date.now()`, and the spend lookup is injected — what is worth pinning is the
 * decision, not SQLite's ability to add.
 */
import { describe, expect, test } from "bun:test";
import {
  periodWindow, periodLabel, budgetStatus, budgetScopeLabel, usable, emptyBudget, WARN_AT,
} from "../src/budget.ts";
import type { Budget } from "../../shared/types.ts";
import { readBudgets } from "../src/config.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const b = (over: Partial<Budget> = {}): Budget => ({ ...emptyBudget(), limit: 100, ...over });

/** A fixed instant, so "today" is a fact rather than whenever this runs.
 *  2026-07-15 is a Wednesday; 2026-07-01 is a Wednesday too. */
const WED = Date.parse("2026-07-15T09:30:00Z");

describe("the window a period covers", () => {
  test("a day is that day, in UTC", () => {
    expect(periodWindow("day", WED)).toEqual({ fromDay: "2026-07-15", toDay: "2026-07-15" });
  });

  test("a week starts on Monday", () => {
    // What most of the world means by a week, and what every calendar the user
    // is also looking at will agree with.
    expect(periodWindow("week", WED)).toEqual({ fromDay: "2026-07-13", toDay: "2026-07-15" });
  });

  test("and Sunday belongs to the week that is ending, not the one starting", () => {
    // The off-by-one that a `getUTCDay()` used raw produces: Sunday is 0, so a
    // naive subtraction makes it the first day of a new week and a Sunday
    // afternoon silently resets the budget.
    const sun = Date.parse("2026-07-19T23:00:00Z");
    expect(periodWindow("week", sun)).toEqual({ fromDay: "2026-07-13", toDay: "2026-07-19" });
    const mon = Date.parse("2026-07-20T00:30:00Z");
    expect(periodWindow("week", mon)).toEqual({ fromDay: "2026-07-20", toDay: "2026-07-20" });
  });

  test("a month starts on the first, and is a calendar month", () => {
    // Not a trailing thirty days. A trailing window never resets, so it can
    // only creep towards the limit and stay there — which is an average with a
    // limit painted on it, not a budget.
    expect(periodWindow("month", WED)).toEqual({ fromDay: "2026-07-01", toDay: "2026-07-15" });
    const first = Date.parse("2026-07-01T00:00:01Z");
    expect(periodWindow("month", first)).toEqual({ fromDay: "2026-07-01", toDay: "2026-07-01" });
  });

  test("and the year boundary is not special-cased into being wrong", () => {
    const jan = Date.parse("2027-01-03T12:00:00Z"); // a Sunday
    expect(periodWindow("month", jan)).toEqual({ fromDay: "2027-01-01", toDay: "2027-01-03" });
    expect(periodWindow("week", jan)).toEqual({ fromDay: "2026-12-28", toDay: "2027-01-03" });
  });

  test("late in a day still means the UTC day", () => {
    expect(periodWindow("day", Date.parse("2026-07-15T23:59:59Z")).toDay).toBe("2026-07-15");
    expect(periodWindow("day", Date.parse("2026-07-16T00:00:00Z")).toDay).toBe("2026-07-16");
  });

  /**
   * …and in a timezone that is not this one.
   *
   * The rollup writes UTC days, so a window computed in local time jumps at
   * whichever midnight arrives first — which on the last day of a month puts a
   * budget a whole period out. This machine runs in UTC, where that bug is
   * completely invisible: local and UTC agree on every instant, and a mutation
   * swapping `toISOString()` for local date parts passed every check above.
   *
   * So the property is checked where it can actually fail, in a child process
   * with TZ set. UTC+14 and UTC-11 straddle the date line, so at 23:30Z on the
   * 15th one of them is already on the 16th and the other is still on the 15th.
   */
  test("and stays the UTC day on a machine that is not in UTC", () => {
    const budgetSrc = new URL("../src/budget.ts", import.meta.url).pathname;
    const script = [
      `const { periodWindow } = await import(${JSON.stringify(budgetSrc)});`,
      `const now = Date.parse("2026-07-15T23:30:00Z");`,
      `console.log(JSON.stringify({ local: new Date(now).getDate(),`,
      `  day: periodWindow("day", now), month: periodWindow("month", now) }));`,
    ].join("\n");
    for (const [tz, localDate] of [["Pacific/Kiritimati", 16], ["Pacific/Niue", 15]] as const) {
      const r = Bun.spawnSync(["bun", "-e", script], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TZ: tz },
      });
      const out = JSON.parse(r.stdout.toString().trim() || "{}");
      // The child really is in that zone — otherwise this test proves nothing.
      expect(out.local, `${tz} did not take effect`).toBe(localDate);
      expect(out.day, tz).toEqual({ fromDay: "2026-07-15", toDay: "2026-07-15" });
      expect(out.month, tz).toEqual({ fromDay: "2026-07-01", toDay: "2026-07-15" });
    }
  });
});

describe("where a budget stands", () => {
  const spendOf = (amount: number) => () => amount;

  test("under the warn line is nothing to say", () => {
    const [s] = budgetStatus([b({ limit: 100 })], WED, spendOf(50));
    expect(s!.level).toBe("ok");
    expect(s!.pct).toBe(0.5);
  });

  test("warns before the limit, not at it", () => {
    // A budget you are told about the moment you cross it is a receipt, not a
    // control — there is nothing left to do about it.
    expect(budgetStatus([b({ limit: 100 })], WED, spendOf(100 * WARN_AT))[0]!.level).toBe("warn");
    expect(budgetStatus([b({ limit: 100 })], WED, spendOf(100 * WARN_AT - 0.01))[0]!.level).toBe("ok");
    expect(WARN_AT).toBeLessThan(1);
  });

  test("and over is over, exactly at the limit", () => {
    expect(budgetStatus([b({ limit: 100 })], WED, spendOf(99.99))[0]!.level).toBe("warn");
    expect(budgetStatus([b({ limit: 100 })], WED, spendOf(100))[0]!.level).toBe("over");
  });

  test("the percentage is not capped, because how far over is the point", () => {
    expect(budgetStatus([b({ limit: 100 })], WED, spendOf(180))[0]!.pct).toBe(1.8);
  });

  /** Collected into an array rather than a `let`: TypeScript narrows a nullable
   *  captured by a callback to `null`, so the assertion would be about the type
   *  rather than the value. */
  const asksOf = (budgets: Budget[]) => {
    const seen: { fromDay: string; toDay: string; root?: string | null; model?: string | null }[] = [];
    budgetStatus(budgets, WED, (o) => { seen.push(o); return 0; });
    return seen;
  };

  test("asks about the window the period names", () => {
    const [asked] = asksOf([b({ period: "month", root: "/home/x/orbit", model: "claude-opus-5" })]);
    expect(asked).toEqual({
      fromDay: "2026-07-01", toDay: "2026-07-15",
      root: "/home/x/orbit", model: "claude-opus-5",
    });
  });

  test("and a week or a day asks about that window, not about the month", () => {
    // The period is the whole setting. Evaluating every budget over a month
    // makes a daily limit fire once and then stay lit until the first.
    const asked: Record<string, { fromDay: string; toDay: string }> = {};
    for (const period of ["day", "week", "month"] as const) {
      const [o] = asksOf([b({ period })]);
      asked[period] = { fromDay: o!.fromDay, toDay: o!.toDay };
    }
    expect(asked).toEqual({
      day: { fromDay: "2026-07-15", toDay: "2026-07-15" },
      week: { fromDay: "2026-07-13", toDay: "2026-07-15" },
      month: { fromDay: "2026-07-01", toDay: "2026-07-15" },
    });
  });

  test("and an unset root or model asks about everything, not about the empty string", () => {
    expect(asksOf([b()])[0]).toMatchObject({ root: null, model: null });
  });
});

describe("a budget that is not one", () => {
  test("is ignored rather than treated as zero", () => {
    // A half-filled row in the settings pane must not start reporting every
    // project as infinitely over budget.
    expect(usable(b({ limit: 0 }))).toBe(false);
    expect(usable(b({ limit: -5 }))).toBe(false);
    expect(usable(b({ limit: NaN }))).toBe(false);
    expect(usable(b({ limit: Infinity }))).toBe(false);
    expect(usable(b({ limit: 0.01 }))).toBe(true);
  });

  test("and never reaches the evaluation at all", () => {
    let calls = 0;
    const out = budgetStatus([b({ limit: 0 }), b({ limit: 10 })], WED, () => { calls++; return 1; });
    expect(out).toHaveLength(1);
    expect(calls).toBe(1);
  });
});

describe("saying what a budget is about", () => {
  test("names the project by its directory, not its whole path", () => {
    expect(budgetScopeLabel(b({ root: "/home/x/code/orbit" }))).toBe("orbit");
    expect(budgetScopeLabel(b({ root: "/home/x/code/orbit/" }))).toBe("orbit");
  });

  test("says 'everything' rather than nothing when it covers the machine", () => {
    expect(budgetScopeLabel(b())).toBe("everything");
  });

  test("and names the model when the budget is about one", () => {
    expect(budgetScopeLabel(b({ root: "/a/orbit", model: "claude-opus-5" }))).toBe("orbit · claude-opus-5");
    expect(budgetScopeLabel(b({ model: "claude-opus-5" }))).toBe("everything · claude-opus-5");
  });

  test("the period reads as a phrase, since it lands mid-sentence", () => {
    expect(periodLabel("day")).toBe("today");
    expect(periodLabel("week")).toBe("this week");
    expect(periodLabel("month")).toBe("this month");
  });
});

/**
 * A config file somebody edited by hand.
 *
 * Driven through `readBudgets` rather than through a running server, because
 * the settings file is read once per resolved path — the same caching every
 * other setting here uses — so a live process does not see an edit until it
 * restarts. That is existing behaviour and consistent with `root`; what is
 * worth pinning is that when the file *is* read, a row it cannot use is
 * dropped rather than coerced into something plausible.
 */
describe("reading budgets off disk", () => {
  const withConfig = <T,>(budgets: unknown, fn: () => T): T => {
    // A fresh directory per case, which is also what invalidates the cache.
    const home = mkdtempSync(join(tmpdir(), "agx-bcfg-"));
    process.env.XDG_CONFIG_HOME = home;
    mkdirSync(join(home, "agentglass"), { recursive: true });
    writeFileSync(join(home, "agentglass", "config.json"), JSON.stringify({ budgets }));
    return fn();
  };

  test("keeps the rows it can use and drops the ones it cannot", () => {
    const out = withConfig(
      [{ root: "", model: "", limit: 40, period: "month" },
       { limit: "40", period: "month" },   // a string is a guess, not a limit
       { limit: 5 },                       // no period
       { limit: 5, period: "year" },       // not a period this app has
       null, "a budget", 7,
       { root: "", model: "", limit: 9, period: "day" }],
      () => readBudgets(),
    );
    expect(out.map((b) => b.limit)).toEqual([40, 9]);
  });

  test("fills in the parts a hand-edit is allowed to leave out", () => {
    const [b] = withConfig([{ limit: 12, period: "week" }], () => readBudgets());
    expect(b).toEqual({ root: "", model: "", limit: 12, period: "week" });
  });

  test("expands a leading ~ in a root, like every other path in this file", () => {
    const [b] = withConfig([{ root: "~/code/orbit", limit: 1, period: "day" }], () => readBudgets());
    expect(b!.root.startsWith("~")).toBe(false);
    expect(b!.root.endsWith("/code/orbit")).toBe(true);
  });

  test("a budgets key that is not a list costs the budgets, not the read", () => {
    expect(withConfig({ nope: true }, () => readBudgets())).toEqual([]);
    expect(withConfig("all of them", () => readBudgets())).toEqual([]);
  });

  test("and no budgets key at all is simply none", () => {
    const home = mkdtempSync(join(tmpdir(), "agx-bcfg-"));
    process.env.XDG_CONFIG_HOME = home;
    expect(readBudgets()).toEqual([]);
  });
});
