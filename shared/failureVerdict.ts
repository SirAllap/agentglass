/*
 * What a failing test's history says about it, from facts only.
 *
 * Every verdict names what was SEEN ("failed and passed on the same commit"),
 * never why. The inputs are the failures the app has read (ci_failure_items)
 * joined to the check runs it knows (check_runs), so a verdict is as wide as
 * that knowledge: it can say "also failed on 3 other PRs", it can never say
 * "only this PR", because absence from what was read is not absence from the
 * repository. The lens (S3) widens the knowledge with a capped backfill; it
 * does not change what a verdict claims.
 */

/** One place a failure with this signature was read. */
export interface Seen {
  signature: string;
  job: string;
  /** The pull request that run belonged to, when the app knows it. */
  pr: number | null;
  /** The run was a push to the default branch. */
  main: boolean;
}

/** The failure being judged. `weak`: a step's exit code, not a named test. */
export interface Subject {
  job: string;
  pr: number | null;
  /** The same job re-ran on the same commit and passed: every test it ran passed that time. */
  passedOnRetry: boolean;
  weak: boolean;
}

export type TestVerdict =
  | { kind: "main" }
  | { kind: "flaky" }
  /** `nums`: which pull requests, newest first, so the chip can name them. `unknown`: other runs of this failure whose
   *  pull request the app does not know, counted apart so the claim is never wider than what was seen. Absent in a verdict kept before they existed. */
  | { kind: "others"; prs: number; nums?: number[]; unknown?: number }
  /** The lens's own wording for a test seen on several pull requests and not on main: "Failed on N PRs". */
  | { kind: "prs"; prs: number }
  | { kind: "this-pr"; pr?: number }
  | { kind: "once" };

/**
 * Order matters and is the claim: a test that failed and then passed on the same
 * commit is flaky whatever else is said of it; failing on the default branch
 * outranks failing on other pull requests; and a step's exit code is too weak a
 * signature to compare, so it says only that it was seen.
 */
export function testVerdict(signature: string, seen: Seen[], me: Subject): TestVerdict {
  if (me.weak) return { kind: "once" };
  if (me.passedOnRetry) return { kind: "flaky" };
  const elsewhere = seen.filter((s) => s.signature === signature && s.job !== me.job);
  if (elsewhere.some((s) => s.main)) return { kind: "main" };
  const prs = new Set<number>();
  for (const s of elsewhere) if (s.pr != null && s.pr !== me.pr) prs.add(s.pr);
  if (prs.size) {
    const unknown = new Set(elsewhere.filter((s) => s.pr == null).map((s) => s.job)).size;
    return { kind: "others", prs: prs.size, nums: [...prs].sort((a, b) => b - a), ...(unknown ? { unknown } : {}) };
  }
  return { kind: "this-pr" };
}

/** The chip's words. Each says what was seen. */
export function verdictLabel(v: TestVerdict, pr?: number | null): string {
  switch (v.kind) {
    case "main": return "Red on main";
    case "flaky": return "Flaky test";
    case "others": return v.nums?.length === 1 && !v.unknown ? `Also failed on #${v.nums[0]}` : `Also failed on ${v.prs} other ${v.prs === 1 ? "PR" : "PRs"}`;
    case "prs": return `Failed on ${v.prs} PRs`;
    case "this-pr": { const n = v.pr ?? pr; return n ? `This PR only · #${n}` : "This PR only"; }
    case "once": return "Seen once";
  }
}

/**
 * Whose problem a card's failing tests are. "Not yours" needs EVERY failing test
 * to be red elsewhere: one new failure among shared ones is still yours to fix.
 * With several, the count is the smallest, so the sentence is true of each.
 */
export function cardOwnership(verdicts: TestVerdict[]): { notYours: false } | { notYours: true; main: boolean; prs: number } {
  if (!verdicts.length) return { notYours: false };
  if (!verdicts.every((v) => v.kind === "main" || v.kind === "others")) return { notYours: false };
  if (verdicts.every((v) => v.kind === "main")) return { notYours: true, main: true, prs: 0 };
  return { notYours: true, main: false, prs: Math.min(...verdicts.map((v) => (v.kind === "others" ? v.prs : Infinity))) };
}

/**
 * One failing test across everything the app has read: the lens's row verdict.
 * Same order of claims as `testVerdict`, but about the test, not about one run
 * of it — so "this PR only" names the PR, and several PRs without main is
 * simply "failed on N PRs". A run with no known pull request counts for none.
 */
export function signatureVerdict(occ: Seen[], o: { flaky: boolean; weak: boolean }): TestVerdict {
  if (o.weak) return { kind: "once" };
  if (o.flaky) return { kind: "flaky" };
  if (occ.some((s) => s.main)) return { kind: "main" };
  const prs = [...new Set(occ.map((s) => s.pr).filter((n): n is number => n != null))];
  if (prs.length > 1) return { kind: "prs", prs: prs.length };
  if (prs.length === 1) return { kind: "this-pr", pr: prs[0] };
  return { kind: "once" };
}

/** Failed runs one refresh of the lens reads. Shared so the page states the cap the server enforces. */
export const LENS_REFRESH_CAP = 6;
