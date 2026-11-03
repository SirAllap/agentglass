/*
 * What Flight plan has spent, and whether a cap is reached. Two sources, both
 * already measured elsewhere: a Preflight's own cost (the certificate it
 * wrote) and the cost of builder sessions, which the cockpit books per turn
 * with the branch the turn recorded. A builder's branch is `flight-plan/<slug>`
 * (flightPlan.ts cutBuilderWorktree), so "the builders Flight plan launched" is
 * the turns whose branch starts there: no second ledger to keep in step.
 */
import { spendRows, type SpendRow } from "./spend.ts";
import { APP, getSetting, preflightCostSince, putSetting, type SettingKey } from "./preflightStore.ts";
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

/** The next local midnight that opens a day, and the Monday that opens a week. */
const nextDay = (now: number): number => { const d = new Date(dayStart(now)); d.setDate(d.getDate() + 1); return d.getTime(); };
const nextWeek = (now: number): number => { const d = new Date(weekStart(now)); d.setDate(d.getDate() + 7); return d.getTime(); };

export type CapScope = "day" | "week";
const CAP: Record<CapScope, { base: SettingKey; raise: SettingKey; until: SettingKey }> = {
  day: { base: "flightPlan.budget.dailyUsd", raise: "flightPlan.budget.dailyRaiseUsd", until: "flightPlan.budget.dailyRaiseUntil" },
  week: { base: "flightPlan.budget.weeklyUsd", raise: "flightPlan.budget.weeklyRaiseUsd", until: "flightPlan.budget.weeklyRaiseUntil" },
};

/**
 * The cap in force: the person's raise while it lasts, the base cap once it has passed.
 * Read on every call and never cleared by a timer, so a window that was closed at
 * midnight reads the base cap the next time it asks.
 */
export function capAt(scope: CapScope, now = Date.now()): number {
  const k = CAP[scope];
  const base = Number(getSetting(APP, k.base));
  const raise = Number(getSetting(APP, k.raise)), until = Number(getSetting(APP, k.until));
  // A raise never lowers the cap: a base the person raised above it in Settings wins while both are in force.
  return raise > 0 && until > now ? Math.max(base, raise) : base;
}

/** A higher cap until the period's next boundary. The base cap is left alone, so it comes back by itself. */
export function raiseCap(scope: CapScope, usd: number, now = Date.now()): { capUsd: number; until: number } {
  const until = scope === "day" ? nextDay(now) : nextWeek(now);
  putSetting(APP, CAP[scope].raise, usd);
  putSetting(APP, CAP[scope].until, until);
  return { capUsd: usd, until };
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
  const dailyCap = capAt("day", now), weeklyCap = capAt("week", now);
  let spend = !deps && !fresh && cached && now - cached.at < CACHE_MS ? cached : null;
  if (!spend) {
    spend = { at: now, day: spentSince(dayStart(now), deps), week: spentSince(weekStart(now), deps) };
    if (!deps) cached = spend;   // a Go or a queue drain asks `fresh`, and refreshes it for the readers
  }
  const { day: dayUsd, week: weekUsd } = spend;
  const reached = dayUsd >= dailyCap ? "daily" : weekUsd >= weeklyCap ? "weekly" : null;
  const until = reached === "daily" ? nextDay(now) : reached === "weekly" ? nextWeek(now) : null;
  return { reached, dayUsd, weekUsd, dailyCap, weeklyCap, until };
}
