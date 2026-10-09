/*
 * The Checks tab reads like GitHub's: header wording and order, failing first,
 * skipped folded, and a name that says which trigger ran it. Fixtures are the
 * shape of a real pull request with 71 runs (58 successful, 13 skipped).
 */
import { describe, expect, it } from "bun:test";
import { applyFilter, checkLabel, checkStatusLine, filterCounts, formatSpan, sectionChecks, shortName, slowest, spanShare, verdictHero, checkVerdict, usualTip, usualTick, workflowCards } from "../src/lib/prChecksList.ts";
import type { PrCheck, PrCheckRollup } from "../../shared/types.ts";

const chk = (o: Partial<PrCheck>): PrCheck => ({ name: "Tests", workflow: "CI", state: "success", done: true, ...o });
const roll = (o: Partial<PrCheckRollup>) =>
  ({ total: 71, success: 58, failure: 0, skipped: 13, pending: 0, allDone: true, verdict: "green", failing: [], ...o }) as PrCheckRollup;

describe("rows", () => {
  it("names the run by workflow, job and trigger", () => {
    expect(checkLabel(chk({ event: "pull_request_review" }))).toBe("CI / Tests (pull_request_review)");
    expect(checkLabel(chk({ workflow: "", name: "ci/legacy" }))).toBe("ci/legacy");
  });
  it("says how long it took, and what the check wrote", () => {
    const t = "2026-09-30T10:00:00Z";
    expect(checkStatusLine(chk({ startedAt: t, completedAt: "2026-09-30T10:05:00Z" }))).toBe("Successful in 5m");
    expect(checkStatusLine(chk({ title: "No code pitfalls detected" }))).toBe("Successful — No code pitfalls detected");
    expect(checkStatusLine(chk({ state: "failure", startedAt: t, completedAt: "2026-09-30T10:00:42Z" }))).toBe("Failing after 42s");
    expect(checkStatusLine(chk({ state: "pending", done: false, startedAt: t }), Date.parse(t) + 90_000)).toBe("In progress — 2m");
    expect(formatSpan(3_720_000)).toBe("1h 2m");
  });
});

describe("sections", () => {
  it("failing, then running, then passed, with skipped apart", () => {
    const s = sectionChecks([
      chk({ name: "b" }), chk({ name: "a", state: "skipped" }), chk({ name: "c", state: "failure" }),
      chk({ name: "d", state: "pending", done: false }), chk({ name: "e", state: "neutral" }),
    ]);
    expect(s.failing.map((k) => k.name)).toEqual(["c"]);
    expect(s.running.map((k) => k.name)).toEqual(["d"]);
    expect(s.passed.map((k) => k.name)).toEqual(["b"]);
    expect(s.skipped.map((k) => k.name)).toEqual(["a", "e"]);
  });
});

describe("the redesigned tab", () => {
  const at = (s: number, e: number) => ({ startedAt: new Date(Date.UTC(2026, 8, 30, 9, 0, s)).toISOString(), completedAt: new Date(Date.UTC(2026, 8, 30, 9, 0, e)).toISOString() });
  const all = [
    chk({ name: "unit", required: true, ...at(0, 312) }),
    chk({ name: "e2e (checkout)", state: "failure", ...at(0, 505) }),
    chk({ name: "e2e (settings)", state: "pending", done: false }),
    chk({ name: "lint", workflow: "Security", ...at(0, 41) }),
    chk({ name: "claude", state: "skipped", event: "pull_request" }),
  ];
  it("counts what each chip would show", () => {
    expect(filterCounts(all)).toEqual({ all: 5, failed: 1, running: 1, required: 1, slow: 0 });
  });
  it("filters by chip and by typed text", () => {
    expect(applyFilter(all, "failed", "").map((k) => k.name)).toEqual(["e2e (checkout)"]);
    expect(applyFilter(all, "all", "SETTINGS").map((k) => k.name)).toEqual(["e2e (settings)"]);
    expect(applyFilter(all, "slow", "unit")).toHaveLength(0);
  });
  it("shortens a matrix name and scales bars to the slowest run", () => {
    expect(shortName(all[1]!)).toBe("e2e · checkout");
    expect(slowest(all)!.name).toBe("e2e (checkout)");
    expect(spanShare(all[0]!, 505_000)).toBeCloseTo(312 / 505, 3);
    expect(spanShare(all[2]!, 505_000)).toBe(0);
  });
  it("folds only the passed checks into workflow cards, slowest first", () => {
    const cards = workflowCards([...all, chk({ name: "types", ...at(0, 90) })], (k) => k.workflow);
    expect(cards.map((c) => [c.name, c.checks.map((k) => k.name)])).toEqual([["CI", ["unit", "types"]], ["Security", ["lint"]]]);
  });
  it("puts the verdict and the required tally in the hero", () => {
    const h = verdictHero(roll({ failure: 1, pending: 1, success: 56 }), all);
    expect(h.title).toBe("1 check failing · 1 still running");
    expect(h.tone).toBe("bad");
    expect(h.required).toBe("1/1 required passed");
    expect(verdictHero(roll({}), []).required).toBeNull();
    expect(verdictHero(roll({}), []).title).toBe("All checks have passed");
  });
});

describe("colour comes from the job's own history", () => {
  const at = (sec: number) => ({ startedAt: "2026-09-30T09:00:00Z", completedAt: new Date(Date.parse("2026-09-30T09:00:00Z") + sec * 1000).toISOString() });
  const usual = (medianMin: number, n = 20) => ({ usual: { median: medianMin * 60_000, p90: medianMin * 60_000 * 1.1, n } });
  it("15m for a job that usually takes 14m is usual, the same 15m for a 4m job is slower", () => {
    const evals = chk({ name: "evals", ...at(15 * 60), ...usual(14) });
    const unit = chk({ name: "unit", ...at(15 * 60), ...usual(4) });
    expect(checkVerdict(evals)).toBe("usual");
    expect(checkVerdict(unit)).toBe("much-slower");
    expect(filterCounts([evals, unit]).slow).toBe(1);
    expect(applyFilter([evals, unit], "slow", "").map((k) => k.name)).toEqual(["unit"]);
  });
  it("says what it compared with, or that there is nothing yet", () => {
    expect(usualTip(chk({ ...at(15 * 60), ...usual(14) }))).toBe("15m · usually 14m (last 20 runs)");
    expect(usualTip(chk({ ...at(15 * 60), ...usual(14, 4) }))).toBe("15m · not enough history yet");
    expect(checkVerdict(chk({ ...at(90 * 60), ...usual(14, 4) }))).toBe("unknown");
  });
  it("a running job is compared by elapsed time", () => {
    const now = Date.parse("2026-09-30T09:30:00Z");
    const run = chk({ state: "pending", done: false, startedAt: "2026-09-30T09:00:00Z", ...usual(14) });
    expect(checkVerdict(run, now)).toBe("slower");
    expect(usualTip(run, now)).toContain("running longer than usual");
    expect(checkVerdict(run, Date.parse("2026-09-30T09:10:00Z"))).toBe("usual");
  });
  it("a failed run is not judged, and the tick sits at the median on the bar's scale", () => {
    expect(checkVerdict(chk({ state: "failure", ...at(10), ...usual(14) }))).toBe("unknown");
    expect(usualTick(chk({ ...usual(14) }), 28 * 60_000)).toBeCloseTo(0.5);
    expect(usualTick(chk({}), 28 * 60_000)).toBeNull();
  });
});
