/*
 * The Checks tab, decided here so a test can read it.
 *
 * github.com lists checks flat, not by workflow: failing first, then the ones
 * still running, then the ones that passed, and the skipped ones folded away
 * behind a count. Each row says its full name ("Workflow / job (event)") and
 * how it ended ("Successful in 5m"), plus the line the check wrote about its
 * own result when it wrote one.
 */
import type { PrCheck, PrCheckRollup } from "../../../shared/types.ts";
import { durationVerdict, MIN_SAMPLES, type DurationVerdict } from "../../../shared/checkBaseline.ts";

const isSkipped = (k: PrCheck) => k.state === "skipped" || k.state === "neutral";

/** "Workflow / job (event)" — the name GitHub prints, and the only one that tells two runs of one job apart. */
export function checkLabel(k: PrCheck): string {
  const base = k.workflow && !k.name.startsWith(`${k.workflow} /`) ? `${k.workflow} / ${k.name}` : k.name;
  return k.event ? `${base} (${k.event})` : base;
}

/** One row's identity on the Checks tab: its label and its link, the index only for a check that has none. */
export const checkRowId = (k: PrCheck, i = 0): string => `${checkLabel(k)}::${k.url ?? i}`;

/** 42s, 5m, 1h 2m. Under a second is "1s": a check that took no time still ran. */
export function formatSpan(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function checkSpan(k: PrCheck): number | null {
  if (!k.startedAt || !k.completedAt) return null;
  const ms = Date.parse(k.completedAt) - Date.parse(k.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** "Successful in 5m — No code pitfalls detected". */
export function checkStatusLine(k: PrCheck, now = Date.now()): string {
  const span = checkSpan(k);
  const in_ = span == null ? "" : ` in ${formatSpan(span)}`;
  const head = k.state === "success" ? `Successful${in_}`
    : k.state === "failure" ? (k.cancelled ? `Cancelled${in_}` : `Failing${span == null ? "" : ` after ${formatSpan(span)}`}`)
    : k.state === "pending"
      ? (k.startedAt && Number.isFinite(Date.parse(k.startedAt)) ? `In progress — ${formatSpan(now - Date.parse(k.startedAt))}` : "Queued")
    : k.state === "neutral" ? "Neutral" : "Skipped";
  return k.title ? `${head} — ${k.title}` : head;
}

export interface CheckSections { failing: PrCheck[]; running: PrCheck[]; passed: PrCheck[]; skipped: PrCheck[] }

/** GitHub's order. Inside a section the name decides, so a re-read never reshuffles rows. */
export function sectionChecks(all: PrCheck[]): CheckSections {
  const byName = (a: PrCheck, b: PrCheck) => checkLabel(a).localeCompare(checkLabel(b));
  const pick = (f: (k: PrCheck) => boolean) => all.filter(f).sort(byName);
  return {
    failing: pick((k) => k.state === "failure"),
    running: pick((k) => k.state === "pending"),
    passed: pick((k) => k.state === "success"),
    skipped: pick(isSkipped),
  };
}

// ---------------------------------------------------------------------------
// The redesigned tab: a verdict, what needs you, then the rest folded.
// ---------------------------------------------------------------------------

export type CheckFilter = "all" | "failed" | "running" | "required" | "slow";

/**
 * Milliseconds to judge: the span of a passed run, or the time a running one
 * has taken so far. A failed or cancelled run is not judged: it stopped early,
 * so "faster than usual" would be a lie.
 */
export function judgedMs(k: PrCheck, now = Date.now()): number | null {
  if (k.state === "success") return checkSpan(k);
  if (k.state === "pending" && k.startedAt && Number.isFinite(Date.parse(k.startedAt))) return Math.max(0, now - Date.parse(k.startedAt));
  return null;
}

/** Normal, slower or faster than this job's own history, and "unknown" when it has too little of one. */
export const checkVerdict = (k: PrCheck, now = Date.now()): DurationVerdict =>
  durationVerdict(judgedMs(k, now), k.usual, k.state === "pending");

/** The "Slower than usual" chip and the amber bar agree on this. */
export const isSlow = (k: PrCheck, now = Date.now()): boolean => {
  const v = checkVerdict(k, now);
  return v === "slower" || v === "much-slower";
};

/** "15m · usually 14m (last 20 runs)", or why there is nothing to compare with. */
export function usualTip(k: PrCheck, now = Date.now()): string {
  const ms = judgedMs(k, now);
  const head = ms == null ? "" : k.state === "pending" ? `running ${formatSpan(ms)}` : formatSpan(ms);
  const u = k.usual;
  if (k.state !== "success" && k.state !== "pending") return head;
  if (!u || u.n < MIN_SAMPLES) return `${head ? `${head} · ` : ""}not enough history yet`;
  const v = checkVerdict(k, now);
  const word = v === "much-slower" || v === "slower" ? (k.state === "pending" ? " — running longer than usual" : " — slower than usual")
    : v === "faster" ? " — faster than usual" : "";
  return `${head} · usually ${formatSpan(u.median)} (last ${u.n} runs)${word}`;
}

/** Where the job's usual median falls on a bar scaled to `slowestMs`: the tick mark. Null with no verdict-grade history. */
export function usualTick(k: PrCheck, slowestMs: number): number | null {
  const u = k.usual;
  if (!u || u.n < MIN_SAMPLES || slowestMs <= 0) return null;
  return Math.max(0, Math.min(1, u.median / slowestMs));
}

const matches = (k: PrCheck, f: CheckFilter): boolean =>
  f === "all" ? true : f === "failed" ? k.state === "failure" : f === "running" ? k.state === "pending"
  : f === "required" ? !!k.required : isSlow(k);

/** How many checks each chip would show, so a chip with nothing behind it can stay away. */
export function filterCounts(all: PrCheck[]): Record<CheckFilter, number> {
  const out = { all: all.length, failed: 0, running: 0, required: 0, slow: 0 } as Record<CheckFilter, number>;
  for (const k of all) for (const f of ["failed", "running", "required", "slow"] as const) if (matches(k, f)) out[f]++;
  return out;
}

export function applyFilter(all: PrCheck[], filter: CheckFilter, query: string): PrCheck[] {
  const q = query.trim().toLowerCase();
  return all.filter((k) => matches(k, filter) && (!q || checkLabel(k).toLowerCase().includes(q)));
}

/** "E2E (checkout)" reads as "E2E · checkout": a matrix's arguments are the part that tells its jobs apart. */
export function shortName(k: PrCheck): string {
  return k.name.replace(/\s*\(([^()]*)\)$/, " · $1").replace(/\s+/g, " ").trim();
}

/** Bar width, as a share of the slowest run on the pull request: 0 when it has no span. A running job draws how long it has been going. */
export function spanShare(k: PrCheck, slowestMs: number, now = Date.now()): number {
  const s = checkSpan(k) ?? (k.state === "pending" ? judgedMs(k, now) : null);
  if (s == null || slowestMs <= 0) return 0;
  return Math.max(0.03, Math.min(1, s / slowestMs));
}

export function slowest(all: PrCheck[]): PrCheck | null {
  let best: PrCheck | null = null;
  for (const k of all) if ((checkSpan(k) ?? -1) > (best ? checkSpan(best) ?? -1 : -1)) best = k;
  return best;
}

export interface WorkflowCard { name: string; checks: PrCheck[]; passed: number; skipped: number }

/**
 * The passed checks, folded by workflow. Failing and running are pinned above
 * and skipped are folded away, so a card only ever holds what is finished and
 * fine; slowest first inside it, which is the order that answers "why did this
 * take so long".
 */
export function workflowCards(all: PrCheck[], group: (k: PrCheck) => string): WorkflowCard[] {
  const m = new Map<string, PrCheck[]>();
  for (const k of all) {
    if (k.state !== "success") continue;
    const g = group(k);
    (m.get(g) ?? m.set(g, []).get(g)!).push(k);
  }
  return [...m.entries()]
    .map(([name, checks]) => ({ name, checks: checks.sort((a, b) => (checkSpan(b) ?? 0) - (checkSpan(a) ?? 0) || shortName(a).localeCompare(shortName(b))), passed: checks.length, skipped: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The hero's headline and tally, in the words a person would say aloud. */
export function verdictHero(c: PrCheckRollup, checks: PrCheck[]): { title: string; tone: "bad" | "warn" | "ok" | "none"; tally: string[]; required: string | null } {
  const req = checks.filter((k) => k.required);
  const reqPassed = req.filter((k) => k.state === "success").length;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const title = c.failure > 0
    ? (c.pending > 0 ? `${plural(c.failure, "check")} failing · ${c.pending} still running` : `${plural(c.failure, "check")} failing`)
    : c.pending > 0 ? `${c.pending} of ${c.total} still running`
    : c.total === 0 ? "No checks" : "All checks have passed";
  return {
    title,
    tone: c.failure > 0 ? "bad" : c.pending > 0 ? "warn" : c.total === 0 ? "none" : "ok",
    tally: [`${c.success} passed`, `${c.skipped} skipped`, ...(c.failure ? [`${c.failure} failing`] : []), ...(c.pending ? [`${c.pending} running`] : [])],
    required: req.length ? `${reqPassed}/${req.length} required passed` : null,
  };
}
