/*
 * What Flight plan has spent, and whether a cap is reached. Two sources, both
 * already measured elsewhere: a Preflight's own cost (the certificate it
 * wrote) and the cost of builder sessions, which the cockpit books per turn
 * with the branch the turn recorded. A builder's branch is `flight-plan/<slug>`
 * (flightPlan.ts cutBuilderWorktree), so "the builders Flight plan launched" is
 * the turns whose branch starts there: no second ledger to keep in step.
 */
import { spendRows, type SpendRow } from "./spend.ts";
import { APP, getSetting, preflightCostSince } from "./preflightStore.ts";
import { listPlans } from "./flightPlanStore.ts";

export const BUILDER_BRANCH = "flight-plan/";

export interface SpendDeps { trees?: () => string[]; rows?: (root: string, since: number) => SpendRow[]; preflight?: (since: number) => number; roots?: () => string[] }

const midnight = (now: number): number => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** Local midnight at the start of the day, and of the Monday that opened the week. */
export const dayStart = midnight;
export function weekStart(now: number): number {
  const d = new Date(midnight(now));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** Dollars Flight plan spent since `since`: every Preflight, plus every turn a flight-plan builder branch recorded. */
export function spentSince(since: number, deps: SpendDeps = {}): number {
  const launched = listPlans({ state: "launched" });
  const roots = (deps.roots ?? (() => [...new Set(launched.map((p) => p.root))]))();
  const trees = (deps.trees ?? (() => launched.flatMap((p) => (p.launched?.worktree ? [p.launched.worktree] : []))))();
  const rows = deps.rows ?? spendRows;
  let usd = (deps.preflight ?? preflightCostSince)(since);
  // A turn is a builder's when it ran on a flight-plan branch OR in the tree of a plan that was launched: a branch the builder renamed, or a turn that recorded none, still costs.
  for (const root of roots) {
    for (const r of rows(root, since)) {
      if (r.branch.startsWith(BUILDER_BRANCH) || trees.some((t) => r.dir === t || r.dir.startsWith(t + "/"))) usd += r.usd;
    }
  }
  return usd;
}

export interface BudgetState { reached: "daily" | "weekly" | null; dayUsd: number; weekUsd: number; dailyCap: number; weeklyCap: number; until: number | null }

const CACHE_MS = 10_000;
let cached: { at: number; day: number; week: number } | null = null;
/** Tests that add spend look again at once. */
export const forgetBudget = (): void => { cached = null; };

/**
 * Where the day's and the week's spend stand against the caps. Autopilot drops to co-pilot until `until` when one is reached.
 * The spend is cached a few seconds for a view that asks per plan (a Go or a drain asks `fresh`, never the cache) and the caps are not: spendRows reads the events window in SQLite on the thread the terminal rides
 * (spend.ts measured 1.1 s cold) and a list of plans asks once per plan, while a cap the person just changed must count at once.
 */
export function budgetState(now = Date.now(), deps?: SpendDeps, fresh = false): BudgetState {
  const dailyCap = Number(getSetting(APP, "flightPlan.budget.dailyUsd")), weeklyCap = Number(getSetting(APP, "flightPlan.budget.weeklyUsd"));
  let spend = !deps && !fresh && cached && now - cached.at < CACHE_MS ? cached : null;
  if (!spend) {
    spend = { at: now, day: spentSince(dayStart(now), deps), week: spentSince(weekStart(now), deps) };
    if (!deps) cached = spend;   // a Go or a queue drain asks `fresh`, and refreshes it for the readers
  }
  const { day: dayUsd, week: weekUsd } = spend;
  const reached = dayUsd >= dailyCap ? "daily" : weekUsd >= weeklyCap ? "weekly" : null;
  const until = reached === "daily" ? dayStart(now) + 86_400_000 : reached === "weekly" ? weekStart(now) + 7 * 86_400_000 : null;
  return { reached, dayUsd, weekUsd, dailyCap, weeklyCap, until };
}
