import type { Budget, BudgetPeriod, BudgetStatus } from "../../shared/types.ts";
import { spendBetween } from "./db.ts";
import { readBudgets } from "./config.ts";

/**
 * A number you chose, instead of one this app picked.
 *
 * The spend insights fired on constants — $15 in fifteen minutes is "burning
 * fast", $60 an hour is a warning — which means they are noise on a project
 * that genuinely costs that, and silent on one where a tenth of it would be
 * alarming. There was no way to say "this should not cost more than X a day"
 * and be told when it does.
 *
 * A budget is deliberately three things: how much, over what period, for what.
 * Not a rate, not a forecast, not a per-session cap. "£40 a month on this
 * repository" is a sentence somebody can say about their own work; "$0.94 an
 * hour averaged over a trailing window" is not, and the second kind of setting
 * is the kind that gets set once and never understood again.
 *
 * Evaluated against the rollup as well as live events, which is what #292 made
 * possible: on a default install raw events are kept for eight days, so before
 * that a monthly budget was a weekly budget wearing a monthly label.
 */

/** Fraction of the limit at which a budget starts warning.
 *
 *  Before the limit rather than only at it: a budget you are told about the
 *  moment you cross it is a receipt, not a control. Four fifths leaves room to
 *  do something and is late enough not to fire on an ordinary Tuesday. */
export const WARN_AT = 0.8;

/** A budget with nothing filled in, for a UI that is adding one. */
export const emptyBudget = (): Budget => ({ root: "", model: "", limit: 0, period: "month" });

/** UTC, and the same UTC the rollup's days are in. A budget evaluated in local
 *  time against days recorded in UTC would jump at whichever midnight came
 *  first, which on the last day of a month is a whole period out. */
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The window a period covers, ending today.
 *
 * Calendar periods, not trailing windows. "This month" is what somebody means
 * by a monthly budget — it resets, and the reset is the thing that makes the
 * number feel like a budget rather than a rolling average. A trailing 30 days
 * never resets, so it can only ever creep towards the limit and stay there.
 *
 * The week starts on Monday, which is what most of the world means by a week
 * and what every calendar the user is also looking at will agree with.
 */
export function periodWindow(period: BudgetPeriod, now = Date.now()): { fromDay: string; toDay: string } {
  const d = new Date(now);
  const toDay = dayOf(now);
  if (period === "day") return { fromDay: toDay, toDay };
  if (period === "week") {
    // getUTCDay: 0 is Sunday, so Monday-start means Sunday counts as six days in.
    const back = (d.getUTCDay() + 6) % 7;
    return { fromDay: dayOf(now - back * 86_400_000), toDay };
  }
  return { fromDay: `${toDay.slice(0, 7)}-01`, toDay };
}

/** Human words for a period, used in the insight's own title. */
export const periodLabel = (p: BudgetPeriod): string =>
  p === "day" ? "today" : p === "week" ? "this week" : "this month";

/**
 * A budget worth acting on.
 *
 * Anything without a positive limit is ignored rather than treated as zero: a
 * half-filled row in the settings pane must not start reporting every project
 * as infinitely over budget.
 */
export const usable = (b: Budget): boolean => Number.isFinite(b.limit) && b.limit > 0;

/**
 * What each budget has spent, and whether that is a problem yet.
 *
 * `spend` is injected so the evaluation can be driven without a database — the
 * arithmetic and the boundaries are what is worth testing here, and they are
 * the part that is wrong in ways nobody notices for a month.
 */
export function budgetStatus(
  budgets: Budget[] = readBudgets(),
  now = Date.now(),
  spend: typeof spendBetween = spendBetween,
): BudgetStatus[] {
  return budgets.filter(usable).map((b) => {
    const { fromDay, toDay } = periodWindow(b.period, now);
    const spent = spend({ fromDay, toDay, root: b.root || null, model: b.model || null });
    // Guarded even though `usable` already rejects a zero limit: this is a
    // denominator, and the one thing worse than a wrong budget is an Infinity
    // rendered as a percentage on somebody's dashboard.
    const pct = b.limit > 0 ? spent / b.limit : 0;
    return {
      budget: b,
      fromDay,
      toDay,
      spent,
      pct,
      level: pct >= 1 ? "over" : pct >= WARN_AT ? "warn" : "ok",
    };
  });
}

/** What a status is about, in the words the insight will use. */
export function budgetScopeLabel(b: Budget): string {
  const where = b.root ? b.root.split("/").filter(Boolean).pop() || b.root : "everything";
  return b.model ? `${where} · ${b.model}` : where;
}
