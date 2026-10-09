// The CI metrics table: which checks are slow, passed on a re-run, or drifting, and in what order.
//
// Measured: the Checks tab judges one pull request's job against that job's own
// history, and says nothing about the repository as a whole. This is the same
// yardstick over every check at once, so the verdict is `durationVerdict`
// (shared/checkBaseline.ts) and never a threshold written down here: an eval
// suite that always takes 15 minutes is not slow, the same suite at 40 is.
//
// Pure, so the table and its tests share one definition of each chip. What it
// does not do: judge a check with fewer than MIN_SAMPLES successes, and see
// inside a day (the trend is one median per day, so a 14-day drift is the
// finest thing it can call).
//
// "Re-run passed" is not a failure rate, and it is not "flaky": that word belongs
// to a test, and a job can run thousands of them. Measured on the old rule
// (1 failure in 20 runs) a check that failed because the code was broken, and one
// cancelled by a newer push, both came out flagged. It is `rerunPassed`
// (shared/checkBaseline.ts): the same commit both failed and passed the job, and
// which test failed is not in the data.

import { durationVerdict, rerunPassed, MIN_SAMPLES, NOISE_MS, type CheckAggregate, type CheckMetric, type DurationVerdict, type SameCommit } from "../../../shared/checkBaseline.ts";

/** The last week's median against the week before it. */
const DRIFT_RATIO = 1.15;
const WEEK = 7;

export type Chip = "all" | "slow" | "rerun" | "drifting";
export const CHIPS: readonly Chip[] = ["all", "slow", "rerun", "drifting"];

export type SortKey = "check" | "usual" | "slow" | "fails" | "verdict";
export interface Sort { key: SortKey; dir: "asc" | "desc" }
/** Slowest end first: the check with the longest tail is the one worth opening. */
export const DEFAULT_SORT: Sort = { key: "slow", dir: "desc" };

const average = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
/** The days of a trend that had a success, in order. */
const medians = (trend: CheckAggregate["trend"]): number[] => trend.flatMap((d) => (d.median == null ? [] : [d.median]));

/**
 * How much slower the last 7 days ran than the 7 before, as a fraction (0.26 is
 * "26% slower"), or null when it is not a drift: under DRIFT_RATIO, under
 * NOISE_MS, or a week with fewer than 2 days of successes to average.
 */
export function drift(trend: CheckAggregate["trend"]): number | null {
  const now = medians(trend.slice(-WEEK)), before = medians(trend.slice(-2 * WEEK, -WEEK));
  if (now.length < 2 || before.length < 2) return null;
  const a = average(now), b = average(before);
  return a >= b * DRIFT_RATIO && a - b >= NOISE_MS ? a / b - 1 : null;
}

export interface Row {
  key: string;
  name: string;
  /** Workflow name, "" for a check that has none. */
  workflow: string;
  runs: number;
  usual: number | null;
  slowEnd: number | null;
  failRate: number | null;
  trend: CheckAggregate["trend"];
  /** The newest run: what the bar's marker shows. It is also inside `usual`, which is the whole stored history: a lone outlier among 5 successes pulls the median toward itself. */
  thisRun: number | null;
  failed: boolean;
  verdict: DurationVerdict;
  rerun: boolean;
  sameCommit: SameCommit;
  drift: number | null;
}

/**
 * The hover for a check that passed on a re-run: what was seen, in its own numbers,
 * and where to look next. For a check that did not it says only what could not be judged (runs with no commit
 * recorded: stored before it was kept, or read from a response without one),
 * and is empty when there is nothing to say.
 */
export function rerunWhy(f: SameCommit): string {
  if (f.flips > 0) return `Failed, then passed, on the same commit ${f.flips === 1 ? "once" : `${f.flips} times`} in ${f.days} days. That is the job, not a single test: open the failed run's log to see which test.`;
  return f.unknown > 0 ? `${f.unknown} run${f.unknown === 1 ? " has" : "s have"} no commit recorded, so ${f.unknown === 1 ? "it" : "they"} cannot be judged for re-runs` : "";
}

export function toRow(m: CheckMetric): Row {
  const a = m.aggregate;
  const enough = a.successes >= MIN_SAMPLES && a.median != null && a.p90 != null;
  const usual = enough ? { median: a.median!, p90: a.p90!, n: a.successes } : undefined;
  const failed = a.latest?.conclusion === "failure";
  return {
    key: m.key, name: m.name, workflow: m.workflow, runs: a.runs,
    usual: a.median, slowEnd: a.p90, failRate: a.failureRate,
    trend: a.trend,
    thisRun: a.latest?.ms ?? null,
    failed,
    // A failed run stops early, so "faster" would be a lie: shared/checkBaseline.ts refuses it too.
    verdict: failed ? "unknown" : durationVerdict(a.latest?.ms ?? null, usual),
    rerun: rerunPassed(a.sameCommit),
    sameCommit: a.sameCommit,
    drift: drift(a.trend),
  };
}

export const isSlow = (r: Row): boolean => r.verdict === "slower" || r.verdict === "much-slower";

/** Whether a row belongs on a chip. */
export const inChip = (c: Chip, r: Row): boolean => IN[c](r);

const IN: Record<Chip, (r: Row) => boolean> = {
  all: () => true,
  slow: isSlow,
  rerun: (r) => r.rerun,
  drifting: (r) => r.drift != null,
};

/** The count on each chip, over the rows the filter box lets through, so a chip never promises rows the box has hidden. */
export function chipCounts(rows: Row[]): Record<Chip, number> {
  return Object.fromEntries(CHIPS.map((c) => [c, rows.filter((r) => IN[c](r)).length])) as Record<Chip, number>;
}

/** Every word of the query is somewhere in "workflow name", any case. */
export function matches(r: Row, query: string): boolean {
  const hay = `${r.workflow} ${r.name}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

const VERDICT_RANK: Record<DurationVerdict, number> = { "much-slower": 4, slower: 3, usual: 2, faster: 1, unknown: 0 };

/** The value a column sorts on. Null has no place in the order and always sinks. */
function cell(r: Row, k: SortKey): number | string | null {
  switch (k) {
    case "check": return r.name.toLowerCase();
    case "usual": return r.usual;
    case "slow": return r.slowEnd;
    case "fails": return r.failRate;
    // A failed run outranks every duration: it is the worst thing a run can be.
    case "verdict": return r.failed ? 5 : VERDICT_RANK[r.verdict];
  }
}

export function sortRows(rows: Row[], s: Sort): Row[] {
  const sign = s.dir === "asc" ? 1 : -1;
  return [...rows].sort((x, y) => {
    const a = cell(x, s.key), b = cell(y, s.key);
    if (a == null || b == null) return a == null && b == null ? x.name.localeCompare(y.name) : a == null ? 1 : -1;
    const c = typeof a === "string" ? a.localeCompare(b as string) : a - (b as number);
    return c ? c * sign : x.name.localeCompare(y.name);
  });
}

/** What a header click does: the same column flips, another starts where its numbers are biggest first (names, A to Z). */
export function nextSort(cur: Sort, key: SortKey): Sort {
  if (cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "check" ? "asc" : "desc" };
}

/** 42s, 8m, 11m 12s, 1h 2m: seconds kept under an hour, because 11m 12s against 13m is the whole point of the column. */
export function span(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** The longest span any check draws: the one axis every bar shares. */
export function barTop(rows: Pick<Row, "usual" | "slowEnd" | "thisRun">[]): number {
  return Math.max(0, ...rows.flatMap((r) => [r.usual ?? 0, r.slowEnd ?? 0, r.thisRun ?? 0])) * 1.02 || 1;
}

/**
 * Where usual, slow end and this run sit on the shared axis, as fractions of it.
 * One axis for every row, over ALL the checks and not the ones a chip leaves
 * showing, so filtering never moves a bar and 11m in one row is as long as 11m
 * in the next. The cost, chosen: a 40 second check is a sliver beside a 30
 * minute one, and its marker is what says how it went.
 */
export function barScale(r: Pick<Row, "usual" | "slowEnd" | "thisRun">, top: number): { usual: number; slowEnd: number; marker: number | null } {
  return { usual: (r.usual ?? 0) / top, slowEnd: (r.slowEnd ?? 0) / top, marker: r.thisRun == null ? null : r.thisRun / top };
}

/** The words after this run's figure. */
export function verdictWords(r: Row): string {
  if (r.failed) return "failed";
  switch (r.verdict) {
    case "much-slower": return "much slower";
    case "slower": return "slower";
    case "faster": return "faster";
    default: return "";
  }
}

/**
 * The sparkline as separate polylines: a day with no success breaks the line
 * rather than drawing a slope through a day nobody measured, and a lone day is
 * a short tick so it is not lost. `ref` (the slow end) joins the scale at both
 * ends, so its dashed line is inside the box whether the days run under it or over it.
 */
export function sparkPaths(trend: CheckAggregate["trend"], w: number, h: number, ref: number | null = null): { lines: string[]; last: { x: number; y: number } | null; refY: number | null } {
  const vals = medians(trend);
  if (!vals.length) return { lines: [], last: null, refY: null };
  const lo = Math.min(...vals, ref ?? Infinity), hi = Math.max(...vals, ref ?? 0), range = hi - lo || 1;
  const step = w / Math.max(1, trend.length - 1);
  const y = (v: number) => +(h - ((v - lo) / range) * h).toFixed(1);
  const lines: string[] = [];
  let run: { x: number; y: number }[] = [];
  let last: { x: number; y: number } | null = null;
  const flush = () => {
    if (run.length > 1) lines.push(run.map((p) => `${p.x},${p.y}`).join(" "));
    else if (run[0]) lines.push(`${run[0].x - 1},${run[0].y} ${run[0].x + 1},${run[0].y}`);
    run = [];
  };
  trend.forEach((d, i) => {
    if (d.median == null) { flush(); return; }
    last = { x: +(i * step).toFixed(1), y: y(d.median) };
    run.push(last);
  });
  flush();
  return { lines, last, refY: ref == null ? null : y(ref) };
}
