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
import { launchedWhere } from "./flightPlanStore.ts";
import { db } from "./db.ts";
import { isWithin, scopeRoots } from "./config.ts";

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
  const launched = launchedWhere();
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

/*
 * The running total, kept per root of a launched plan and per local day, plus a watermark: the last event id counted.
 * A read applies spentSince's own rules (spendRows' scope and cost filter, then the builder-branch-or-launched-tree test)
 * to the events newer than the watermark only, adds them and moves the watermark, so it costs the new events and gives the
 * numbers the full scan gives. Nothing is added when a turn is written, so an event from an older build, or from before this
 * module loaded, is counted on the next read like any other.
 * The rule depends on which plans are launched, so each root keeps a signature of its launched trees. When it changes (a plan
 * launched, or left "launched") the week (only the week: older days stay) is counted once again from the events.
 * Ceiling: an event is scoped with the roots known when it is folded. A path recorded later does not re-attribute earlier spend
 * until the next tree change recounts; paths are not in the signature because that recounted the week on every new build (a 2.6 s stall).
 * Retention deletes old events, not these totals: money already counted stays counted, which is what the scan could no
 * longer say once the events were gone.
 */
// The old flight_spend table (an earlier build of this feature) is left in place and unused: an older build may still read it,
// and dropping it would need a schema generation bump that locks older builds out on another machine. New tables are additive.
db.run(`CREATE TABLE IF NOT EXISTS flight_spend_day (root TEXT NOT NULL, day_start INTEGER NOT NULL, usd REAL NOT NULL, PRIMARY KEY (root, day_start))`);
db.run(`CREATE TABLE IF NOT EXISTS flight_spend_mark (root TEXT PRIMARY KEY, sig TEXT NOT NULL, last_id INTEGER NOT NULL)`);

const isBuilderTurn = (branch: string, dir: string, trees: string[]): boolean =>
  branch.startsWith(BUILDER_BRANCH) || trees.some((t) => dir === t || dir.startsWith(t + "/"));

type SpendEvent = { branch: string; dir: string; project: string; usd: number; ts: number };
const SPEND_COLS = `COALESCE(json_extract(payload, '$.git_branch'), '') AS branch, COALESCE(cwd_path, project_path, '') AS dir, COALESCE(project_path, '') AS project, COALESCE(cwd_path, '') AS cwd, cost_usd AS usd, timestamp AS ts`;
export const RECOUNT_CHUNK = 20000;

/** Fold events into per-day totals: in scope of the root's checkouts (the test scopeClause makes, done here in JS) and a builder's turn. */
function foldSpend(rows: (SpendEvent & { cwd: string })[], roots: string[], trees: string[], into: Map<number, number>): void {
  for (const r of rows) {
    if (roots.length && !roots.some((x) => (r.project !== "" && isWithin(r.project, x)) || (r.cwd !== "" && isWithin(r.cwd, x)))) continue;
    if (isBuilderTurn(r.branch, r.dir, trees)) into.set(dayStart(r.ts), (into.get(dayStart(r.ts)) ?? 0) + r.usd);
  }
}

const recounting = new Map<string, Promise<void>>();
const recountAgain = new Set<string>();           // the trees changed while a recount ran: look again when it ends
const recountFailedAt = new Map<string, number>();
const catchUpFailedAt = new Map<string, number>();   // its own map: a failing catch-up waits without blocking a recount
const RECOUNT_BACKOFF_MS = 5_000;
/** Resolves when every background recount that is running has finished (tests). */
export const settleRecounts = async (): Promise<void> => { while (recounting.size) await Promise.all([...recounting.values()]); };

/** The signature of a root's launched trees right now, or null when no plan is launched there. */
function currentSig(root: string): string | null {
  const launched = launchedWhere().filter((p) => p.root === root);
  if (!launched.length) return null;
  return JSON.stringify([...new Set(launched.flatMap((p) => (p.launched?.worktree ? [p.launched.worktree] : [])))].sort());
}

/**
 * Count the week again for one root, in the background: chunks of event ids with the loop free between them, into a staging map,
 * then one short transaction swaps it in and moves the mark. Events written meanwhile are newer than `top`, so the next read adds them.
 * Never runs inside a request: a request that finds the signature changed returns the totals as they stand and starts this, and
 * the first query waits a macrotask so not even the first chunk runs in that request. The swap checks the root is still launched
 * with this signature; if not, the result is dropped and a fresh recount is looked for when this one ends.
 */
function startRecount(root: string, trees: string[], sig: string, top: number, week: number): void {
  if (recounting.has(root)) { recountAgain.add(root); return; }
  if (Date.now() - (recountFailedAt.get(root) ?? -Infinity) < RECOUNT_BACKOFF_MS) return;
  const run = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    const roots = scopeRoots(root);
    const staged = new Map<number, number>();
    let lo = (db.query<{ m: number | null }, [number]>(`SELECT MIN(id) AS m FROM events WHERE timestamp >= ?`).get(week)?.m ?? top + 1) - 1;
    while (lo < top) {
      const hi = Math.min(lo + RECOUNT_CHUNK, top);
      foldSpend(db.query<any, [number, number, number]>(`SELECT ${SPEND_COLS} FROM events WHERE id > ? AND id <= ? AND cost_usd > 0 AND timestamp >= ?`).all(lo, hi, week), roots, trees, staged);
      lo = hi;
      await new Promise((r) => setTimeout(r, 0));
    }
    db.transaction(() => {
      if (currentSig(root) !== sig) { recountAgain.add(root); return; }   // unlaunched or re-scoped meanwhile: not ours to write
      // Retention keeps more than a week with the default, so the week's first day is whole. Below 7 days the first surviving day is rebuilt from what is left.
      // Delete from the earliest of that and the earliest staged day: retention may have removed staged events since, and the old row for that day must not be added to.
      const first = db.query<{ t: number | null }, [number]>(`SELECT MIN(timestamp) AS t FROM events WHERE timestamp >= ?`).get(week)?.t;
      const from = Math.min(first != null ? dayStart(first) : Infinity, ...staged.keys());
      if (from !== Infinity) db.query(`DELETE FROM flight_spend_day WHERE root = ? AND day_start >= ?`).run(root, from);
      for (const [day, usd] of staged) db.query(`INSERT INTO flight_spend_day (root, day_start, usd) VALUES (?, ?, ?) ON CONFLICT (root, day_start) DO UPDATE SET usd = usd + excluded.usd`).run(root, day, usd);
      db.query(`INSERT INTO flight_spend_mark (root, sig, last_id) VALUES (?, ?, ?) ON CONFLICT (root) DO UPDATE SET sig = excluded.sig, last_id = excluded.last_id`).run(root, sig, top);
    })();
    recountFailedAt.delete(root);
  };
  track(root, run, "recount", recountFailedAt);
}

/** Run a background job for a root: one at a time, failures logged and backed off, a fresh look when it ends if the trees changed. */
function track(root: string, run: () => Promise<void>, what: string, failedAt: Map<string, number>): void {
  const p = run().catch((e) => {
    failedAt.set(root, Date.now());   // each kind waits on its own map: a failed catch-up must not block a needed recount
    console.warn(`flight budget: ${what} failed for ${root}, retrying in ${RECOUNT_BACKOFF_MS / 1000} s:`, e);
  }).finally(() => {
    recounting.delete(root);
    if (recountAgain.delete(root)) { try { catchUpTotals(); } catch (e) { console.warn(`flight budget: catch-up after ${what} failed for ${root}:`, e); } }
  });
  recounting.set(root, p);
}

/** Add the events after the mark to the totals in the background, one chunk of ids at a time, so a long gap never runs inside a request. */
function startCatchUp(root: string, trees: string[], sig: string, from: number, top: number): void {
  if (Date.now() - (catchUpFailedAt.get(root) ?? -Infinity) < RECOUNT_BACKOFF_MS) return;
  track(root, async () => {
    await new Promise((r) => setTimeout(r, 0));
    const roots = scopeRoots(root);
    let lo = from;
    while (lo < top) {
      const hi = Math.min(lo + RECOUNT_CHUNK, top);
      const add = new Map<number, number>();
      foldSpend(db.query<any, [number, number]>(`SELECT ${SPEND_COLS} FROM events WHERE id > ? AND id <= ? AND cost_usd > 0`).all(lo, hi), roots, trees, add);
      const ok = db.transaction(() => {
        const m = db.query<{ sig: string; last_id: number }, [string]>(`SELECT sig, last_id FROM flight_spend_mark WHERE root = ?`).get(root);
        if (!m || m.sig !== sig || m.last_id !== lo) return false;   // someone moved the mark: not ours to add
        for (const [day, usd] of add) db.query(`INSERT INTO flight_spend_day (root, day_start, usd) VALUES (?, ?, ?) ON CONFLICT (root, day_start) DO UPDATE SET usd = usd + excluded.usd`).run(root, day, usd);
        db.query(`UPDATE flight_spend_mark SET last_id = ? WHERE root = ?`).run(hi, root);
        return true;
      })();
      if (!ok) { recountAgain.add(root); return; }
      lo = hi;
      await new Promise((r) => setTimeout(r, 0));
    }
    catchUpFailedAt.delete(root);
  }, "catch-up", catchUpFailedAt);
}

/**
 * Bring every launched root's totals up to the newest event. The signature is the launched trees only: nothing in it changes
 * with a build, a boot, a Map order or the paths the scanner has recorded so far (the scope is tested in JS per event, so a path
 * recorded later scopes the events folded after it; earlier spend is not re-attributed, see the ceiling above). The watermark and signature live in flight_spend_mark, so a restart reads them back.
 */
function catchUpTotals(): void {
  const launched = launchedWhere();
  const byRoot = new Map<string, string[]>();
  for (const p of launched) {
    const trees = byRoot.get(p.root) ?? [];
    if (p.launched?.worktree) trees.push(p.launched.worktree);
    byRoot.set(p.root, trees);
  }
  const top = db.query<{ m: number | null }, []>(`SELECT MAX(id) AS m FROM events`).get()?.m ?? 0;
  const week = weekStart(Date.now());
  for (const [root, trees] of byRoot) {
    const sig = JSON.stringify([...new Set(trees)].sort());
    const mark = db.query<{ sig: string; last_id: number }, [string]>(`SELECT sig, last_id FROM flight_spend_mark WHERE root = ?`).get(root);
    if (!mark || mark.sig !== sig) startRecount(root, trees, sig, top, week);
    if (!mark || recounting.has(root)) continue;   // nothing counted yet, or a background job owns the mark
    // A stale signature whose recount failed (backing off) keeps counting new events into the old totals, so they never freeze; the next recount replaces them.
    if (top - mark.last_id > RECOUNT_CHUNK) { startCatchUp(root, trees, mark.sig, mark.last_id, top); continue; }   // far behind: chunks in the background, this read returns the totals as they stand
    const rows = db.query<any, [number, number]>(`SELECT ${SPEND_COLS} FROM events WHERE id > ? AND id <= ? AND cost_usd > 0`).all(mark.last_id, top);   // scoped with the roots known now: see the ceiling above
    const add = new Map<number, number>();
    foldSpend(rows, scopeRoots(root), trees, add);
    db.transaction(() => {
      for (const [day, usd] of add) db.query(`INSERT INTO flight_spend_day (root, day_start, usd) VALUES (?, ?, ?) ON CONFLICT (root, day_start) DO UPDATE SET usd = usd + excluded.usd`).run(root, day, usd);
      db.query(`UPDATE flight_spend_mark SET last_id = ? WHERE root = ?`).run(top, root);
    })();
  }
  // A root with no launched plan counts nothing, and starts from 0 if one is launched there again.
  const live = [...byRoot.keys()];
  for (const { root } of db.query<{ root: string }, []>(`SELECT root FROM flight_spend_mark`).all()) {
    if (live.includes(root)) continue;
    db.query(`DELETE FROM flight_spend_day WHERE root = ?`).run(root);
    db.query(`DELETE FROM flight_spend_mark WHERE root = ?`).run(root);
  }
}

const totalSince = (since: number): number => {
  catchUpTotals();
  return preflightCostSince(since) + (db.query<{ usd: number | null }, [number]>(`SELECT SUM(usd) AS usd FROM flight_spend_day WHERE day_start >= ?`).get(since)?.usd ?? 0);
};

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

/** Kept so callers that said "look again" still compile: with running totals there is nothing cached to forget. */
export const forgetBudget = (): void => {};

/**
 * Where the day's and the week's spend stand against the caps. Autopilot drops to co-pilot until `until` when one is reached.
 * No cache and no scan: the builders' spend is a running total per root and local day (flight_spend_day), added to on read
 * (catchUpTotals), so a read costs the events since the last one. It used to scan the week's events, ~25 MB of
 * payload and ~1 s cold on the thread the terminal rides, every time a 10 s cache ran out. With `deps` (tests) it still scans.
 */
export function budgetState(now = Date.now(), deps?: SpendDeps, _fresh = false): BudgetState {
  const dailyCap = capAt("day", now), weeklyCap = capAt("week", now);
  const spend = {
    day: deps ? spentSince(dayStart(now), deps) : totalSince(dayStart(now)),
    week: deps ? spentSince(weekStart(now), deps) : totalSince(weekStart(now)),
  };
  const { day: dayUsd, week: weekUsd } = spend;
  const reached = dayUsd >= dailyCap ? "daily" : weekUsd >= weeklyCap ? "weekly" : null;
  const until = reached === "daily" ? nextDay(now) : reached === "weekly" ? nextWeek(now) : null;
  return { reached, dayUsd, weekUsd, dailyCap, weeklyCap, until };
}
