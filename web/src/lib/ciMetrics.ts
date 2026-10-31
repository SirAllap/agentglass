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

export type Chip = "all" | "slow" | "rerun" | "drifting" | "failing";
export const CHIPS: readonly Chip[] = ["all", "slow", "rerun", "drifting", "failing"];

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
  /** The pull request the newest run belonged to, when the record kept it. */
  thisPr: number | null;
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
    thisPr: a.latest?.pr ?? null,
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
  failing: (r) => r.failed,
};

/** The count on each chip, over the rows the filter box lets through, so a chip never promises rows the box has hidden. */
export function chipCounts(rows: Row[]): Record<Chip, number> {
  return Object.fromEntries(CHIPS.map((c) => [c, rows.filter((r) => IN[c](r)).length])) as Record<Chip, number>;
}

/**
 * The five tiles above the history. Each one filters it, and each one is the
 * entrance to a chip that was already there: Pass rate is every check, Median
 * run opens the slow ones, and Failing now the checks whose newest run failed.
 * (The failing TESTS are the box under the history, not a tile.)
 */
export type Tile = "pass" | "median" | "rerun" | "drifting" | "failing";
export const TILES: readonly Tile[] = ["pass", "median", "rerun", "drifting", "failing"];

/** What the view shows: the chip a tile filters the history by. */
export type CiView = Chip;

const TILE_VIEW: Record<Tile, CiView> = { pass: "all", median: "slow", rerun: "rerun", drifting: "drifting", failing: "failing" };

/** The tile a view belongs to. */
export const tileOf = (v: CiView): Tile => TILES.find((t) => TILE_VIEW[t] === v)!;

/** The view a press on a tile opens. */
export const viewOfTile = (t: Tile): CiView => TILE_VIEW[t];

export type TileTone = "good" | "info" | "warn" | "bad";

/** Fewest pass-or-fail runs a week must hold before it may be compared with the one before it. */
export const WEEK_MIN_RUNS = 5;

/**
 * The pass rate of the last 7 days against the 7 before, in whole points (+2 is
 * "two points better"), over every check's runs together. Null when either week
 * has fewer than WEEK_MIN_RUNS judged runs, or when the record carries no
 * per-day counts (kept before they were stored): a change out of three runs, or
 * out of nothing, is not said. Ceiling: the whole repository, never one check.
 */
export function passDelta(rows: Pick<Row, "trend">[]): number | null {
  const week = (from: number, to?: number) => {
    let passed = 0, failed = 0, seen = false;
    for (const r of rows) for (const d of r.trend.slice(from, to)) {
      if (d.passed == null || d.failed == null) continue;
      seen = true; passed += d.passed; failed += d.failed;
    }
    return seen && passed + failed >= WEEK_MIN_RUNS ? passed / (passed + failed) : null;
  };
  const now = week(-WEEK, undefined), before = week(-2 * WEEK, -WEEK);
  return now == null || before == null ? null : Math.round((now - before) * 100);
}

/** How many pull requests the failing checks' newest runs belong to; null when none of them says. */
export function failingPrs(rows: Pick<Row, "failed" | "thisPr">[]): number | null {
  const prs = new Set(rows.flatMap((r) => (r.failed && r.thisPr != null ? [r.thisPr] : [])));
  return prs.size || null;
}

/** The line under the pass rate: how many runs it stands on, and the week's change when there is one to say. */
export function passDetail(runs: number, delta: number | null): string {
  const base = `last ${runs} run${runs === 1 ? "" : "s"}`;
  if (delta == null) return base;
  return `${base} · ${delta === 0 ? "level with last week" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)} vs last week`}`;
}

/** The line under Failing now: the pull requests it is on when the record says, else what a failing check is. */
export function failingDetail(prs: number | null): string {
  return prs == null ? "newest run failed" : `on ${prs} pull request${prs === 1 ? "" : "s"}`;
}

/**
 * What each tile says: the figure, the line under it, and the tone the figure
 * is drawn in. The pass rate is the runs-weighted mean of each check's own
 * (1 - failure rate); a cancelled run is counted by the check's rate, not
 * separately, because the aggregate does not keep it. Its tone is a display
 * choice (90% and above reads as good), not a verdict: the verdicts of this
 * view are all against a check's own history.
 */
export function tileFacts(rows: Row[], counts: Record<Chip, number>): Record<Tile, { label: string; value: string; detail: string; tone: TileTone }> {
  const judged = rows.filter((r) => r.failRate != null && r.runs > 0);
  const weight = judged.reduce((n, r) => n + r.runs, 0);
  const pass = weight ? judged.reduce((n, r) => n + (1 - r.failRate!) * r.runs, 0) / weight : null;
  const usuals = rows.flatMap((r) => (r.usual == null ? [] : [r.usual])).sort((a, b) => a - b);
  const median = usuals.length ? (usuals[Math.floor((usuals.length - 1) / 2)]! + usuals[Math.ceil((usuals.length - 1) / 2)]!) / 2 : null;
  const slowest = rows.reduce<Row | null>((m, r) => (r.slowEnd != null && (!m || r.slowEnd > (m.slowEnd ?? 0)) ? r : m), null);
  return {
    pass: { label: "Pass rate", value: pass == null ? "—" : `${Math.round(pass * 100)}%`, detail: passDetail(rows.reduce((n, r) => n + r.runs, 0), passDelta(rows)), tone: pass == null || pass >= 0.9 ? "good" : "warn" },
    median: { label: "Median run", value: median == null ? "—" : span(median), detail: counts.slow ? `${counts.slow} slow now` : slowest ? `slowest: ${slowest.name}` : "none slow now", tone: "info" },
    rerun: { label: "Re-run passed", value: String(counts.rerun), detail: "passed after a retry", tone: "warn" },
    drifting: { label: "Drifting", value: String(counts.drifting), detail: "slower than their usual", tone: "info" },
    failing: { label: "Failing now", value: String(counts.failing), detail: counts.failing ? failingDetail(failingPrs(rows)) : "nothing failing", tone: counts.failing ? "bad" : "good" },
  };
}

/** The one status chip of a row, or null when the run is simply usual. A failed run outranks everything, then a re-run that passed, then the verdict, then a week that drifted. */
export function statusChip(r: Row): { label: string; tone: "bad" | "warn" | "good" } | null {
  if (r.failed) return { label: "Failed", tone: "bad" };
  if (r.rerun) return { label: "Re-run passed", tone: "warn" };
  if (r.verdict === "much-slower") return { label: "much slower", tone: "bad" };
  if (r.verdict === "slower") return { label: "slower", tone: "warn" };
  if (r.drift != null) return { label: "drifting", tone: "warn" };
  if (r.verdict === "faster") return { label: "faster", tone: "good" };
  return null;
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

/** The sort menu: every column the table used to sort by, in both directions, as `key:dir`. */
export const SORT_CHOICES: readonly { value: string; label: string }[] = [
  { value: "slow:desc", label: "Slow end \u00b7 longest first" },
  { value: "slow:asc", label: "Slow end \u00b7 shortest first" },
  { value: "usual:desc", label: "Usual \u00b7 longest first" },
  { value: "usual:asc", label: "Usual \u00b7 shortest first" },
  { value: "check:asc", label: "Check \u00b7 A to Z" },
  { value: "check:desc", label: "Check \u00b7 Z to A" },
  { value: "fails:desc", label: "Fails \u00b7 most first" },
  { value: "fails:asc", label: "Fails \u00b7 fewest first" },
  { value: "verdict:desc", label: "This run \u00b7 worst first" },
  { value: "verdict:asc", label: "This run \u00b7 best first" },
];

export const sortChoice = (s: Sort): string => `${s.key}:${s.dir}`;

/** The sort a menu value names; the default when it names none (a stale value). */
export function parseSortChoice(v: string): Sort {
  const [key, dir] = v.split(":");
  return SORT_CHOICES.some((c) => c.value === v) ? { key: key as SortKey, dir: dir as "asc" | "desc" } : DEFAULT_SORT;
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

/**
 * The pill at the end of a history row: the share of its judged runs that passed, in the tone of how
 * much of a problem that is. Display tones, not a verdict (the verdicts of this view are against a
 * check's own history): 95 and above reads as good, 80 and above as a warning.
 */
export function passChip(r: Pick<Row, "failRate">): { label: string; tone: "good" | "warn" | "bad" | "neutral" } {
  if (r.failRate == null) return { label: "\u2014", tone: "neutral" };
  const pct = Math.round((1 - r.failRate) * 100);
  return { label: `${pct}% pass`, tone: pct >= 95 ? "good" : pct >= 80 ? "warn" : "bad" };
}

/**
 * The days of a trend as bar heights from 0 to 1, scaled to the check's own tallest day; a day with
 * no success is null (drawn as a stub, never as zero seconds). The same medians as the line, so the
 * bars and the line in the open row cannot disagree.
 */
export function dayBars(trend: CheckAggregate["trend"]): (number | null)[] {
  const top = Math.max(0, ...trend.map((d) => d.median ?? 0));
  return trend.map((d) => (d.median == null || top === 0 ? null : d.median / top));
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
