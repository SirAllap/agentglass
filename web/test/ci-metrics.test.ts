/*
 * The CI metrics table: what each chip counts, what a header click does, and
 * the bar's scale. Fixtures are the shape of a real repository's checks: an
 * end-to-end job that takes minutes and fails now and then, a lint that takes
 * seconds and never does. Durations in seconds through `s()` for readability.
 */
import { describe, expect, it } from "bun:test";
import { barScale, barTop, chipCounts, drift, rerunWhy, matches, nextSort, sortRows, inChip, sparkPaths, span, toRow, verdictWords, DEFAULT_SORT } from "../src/lib/ciMetrics.ts";
import type { CheckAggregate, CheckMetric, SameCommit } from "../../shared/checkBaseline.ts";

const s = (n: number) => n * 1000;
const day = (i: number) => `2026-09-${String(i + 1).padStart(2, "0")}`;
const flat = (m: number | null, n = 14) => Array.from({ length: n }, (_, i) => ({ day: day(i), runs: m == null ? 0 : 3, median: m }));

/** Nothing flipped, 12 runs judged: a check that never disagreed with itself. */
const steady: SameCommit = { flips: 0, judged: 12, unknown: 0, days: 14 };
const flipped = (flips: number, o: Partial<SameCommit> = {}): SameCommit => ({ ...steady, flips, ...o });

const metric = (name: string, o: Partial<CheckAggregate> & { workflow?: string } = {}): CheckMetric => {
  const { workflow = "CI", ...agg } = o;
  return {
    key: `${workflow}\u0001${name}\u0001pull_request`, workflow, name, event: "pull_request",
    aggregate: { runs: 40, successes: 38, latest: { ms: s(600), conclusion: "success", completedAt: 0 }, median: s(600), p90: s(700), failureRate: 0.02, trend: flat(s(600)), sameCommit: steady, ...agg },
  };
};

describe("verdict", () => {
  it("judges this run against the check's own history", () => {
    // Usual 10m, slow end 12m: 27m is past both max(p90, 1.5 x median) and 2.5 x median; 22m only the first.
    expect(toRow(metric("e2e", { median: s(600), p90: s(720), latest: { ms: s(1620), conclusion: "success", completedAt: 0 } })).verdict).toBe("much-slower");
    expect(toRow(metric("e2e", { median: s(600), p90: s(720), latest: { ms: s(1350), conclusion: "success", completedAt: 0 } })).verdict).toBe("slower");
    expect(toRow(metric("e2e", { median: s(600), p90: s(720), latest: { ms: s(700), conclusion: "success", completedAt: 0 } })).verdict).toBe("usual");
    expect(toRow(metric("e2e", { median: s(600), p90: s(720), latest: { ms: s(620), conclusion: "success", completedAt: 0 } })).verdict).toBe("usual");
  });
  it("the same 15 minutes is usual for a job that always takes 15", () => {
    expect(toRow(metric("evals", { median: s(900), p90: s(960), latest: { ms: s(900), conclusion: "success", completedAt: 0 } })).verdict).toBe("usual");
  });
  it("gives no verdict under 5 successes, and none to a failed run", () => {
    expect(toRow(metric("new", { successes: 4, latest: { ms: s(9000), conclusion: "success", completedAt: 0 } })).verdict).toBe("unknown");
    const f = toRow(metric("e2e", { latest: { ms: s(5), conclusion: "failure", completedAt: 0 } }));
    expect(f.verdict).toBe("unknown");
    expect(verdictWords(f)).toBe("failed");
  });
  it("has no run to judge when nothing but cancellations came in", () => {
    const r = toRow(metric("x", { latest: null, median: null, p90: null, successes: 0, failureRate: null }));
    expect(r.verdict).toBe("unknown");
    expect(r.thisRun).toBeNull();
  });
});

describe("drift", () => {
  const two = (before: number | null, now: number | null) => [...flat(before, 7), ...flat(now, 7)];
  it("is how much slower this week ran than last, from 15% up", () => {
    expect(drift(two(s(600), s(756)))).toBeCloseTo(0.26);
    expect(drift(two(s(600), s(680)))).toBeNull();
  });
  it("ignores a change under the noise floor whatever the ratio", () => {
    expect(drift(two(s(20), s(30)))).toBeNull();
  });
  it("needs two days of successes on each side", () => {
    expect(drift(two(null, s(900)))).toBeNull();
    const oneDay = [...flat(s(600), 7), ...flat(null, 6), { day: day(13), runs: 1, median: s(900) }];
    expect(drift(oneDay)).toBeNull();
  });
});

describe("chips", () => {
  const rows = [
    toRow(metric("e2e", { failureRate: 0.14, sameCommit: flipped(3), latest: { ms: s(1350), conclusion: "success", completedAt: 0 } })),
    toRow(metric("docker", { trend: [...flat(s(600), 7), ...flat(s(800), 7)] })),
    toRow(metric("lint", { median: s(41), p90: s(49), latest: { ms: s(40), conclusion: "success", completedAt: 0 }, trend: flat(s(41)) })),
    toRow(metric("brand-new", { runs: 3, successes: 3, failureRate: 0.33, sameCommit: flipped(1, { judged: 3 }) })),
  ];
  it("counts slow, re-run passed and drifting", () => {
    expect(chipCounts(rows)).toEqual({ all: 4, slow: 1, rerun: 1, drifting: 1 });
  });
  it("a high failure rate alone is not a re-run that passed: it has to have flipped on one commit", () => {
    // Fails 1 run in 3 on every commit it sees: broken, and the old 1-in-20 rule flagged it.
    expect(toRow(metric("broken", { failureRate: 0.33, sameCommit: steady })).rerun).toBe(false);
    expect(toRow(metric("flippy", { failureRate: 0.01, sameCommit: flipped(2) })).rerun).toBe(true);
  });
  it("says why, in the check's own numbers", () => {
    expect(rerunWhy(flipped(3))).toBe("Failed, then passed, on the same commit 3 times in 14 days. That is the job, not a single test: open the failed run's log to see which test.");
    expect(rerunWhy(flipped(1))).toBe("Failed, then passed, on the same commit once in 14 days. That is the job, not a single test: open the failed run's log to see which test.");
  });
  it("says what it could not judge instead of leaving a check unmarked in silence", () => {
    expect(rerunWhy(flipped(0, { judged: 0, unknown: 9 }))).toBe("9 runs have no commit recorded, so they cannot be judged for re-runs");
    expect(rerunWhy(steady)).toBe("");
  });
  it("does not flag a check with 3 runs", () => {
    expect(rows[3]!.rerun).toBe(false);
  });
  it("counts only what the filter box lets through", () => {
    expect(chipCounts(rows.filter((r) => matches(r, "lint")))).toEqual({ all: 1, slow: 0, rerun: 0, drifting: 0 });
  });
  it("a chip narrows the table to its rows", () => {
    expect(rows.filter((r) => inChip("rerun", r)).map((r) => r.name)).toEqual(["e2e"]);
  });
});

describe("filter box", () => {
  const r = toRow(metric("test (server)", { workflow: "CI" }));
  it("finds every word in the workflow or the name, any case", () => {
    expect(matches(r, "ci SERVER")).toBe(true);
    expect(matches(r, "server web")).toBe(false);
    expect(matches(r, "  ")).toBe(true);
  });
});

describe("sorting", () => {
  const rows = [
    toRow(metric("b", { median: s(100), p90: s(300) })),
    toRow(metric("a", { median: s(200), p90: null })),
    toRow(metric("c", { median: s(50), p90: s(120) })),
  ];
  it("puts the slowest end first by default and sinks a check with none", () => {
    expect(sortRows(rows, DEFAULT_SORT).map((r) => r.name)).toEqual(["b", "c", "a"]);
  });
  it("sinks a check with none in either direction", () => {
    expect(sortRows(rows, { key: "slow", dir: "asc" }).map((r) => r.name)).toEqual(["c", "b", "a"]);
  });
  it("sorts names A to Z", () => {
    expect(sortRows(rows, { key: "check", dir: "asc" }).map((r) => r.name)).toEqual(["a", "b", "c"]);
  });
  it("ranks a failed run above the slowest one", () => {
    const f = toRow(metric("f", { latest: { ms: s(5), conclusion: "failure", completedAt: 0 } }));
    const m = toRow(metric("m", { median: s(600), p90: s(720), latest: { ms: s(1350), conclusion: "success", completedAt: 0 } }));
    expect(sortRows([m, f], { key: "verdict", dir: "desc" }).map((r) => r.name)).toEqual(["f", "m"]);
  });
  it("a header click flips the column it is on and starts another biggest first", () => {
    expect(nextSort({ key: "slow", dir: "desc" }, "slow")).toEqual({ key: "slow", dir: "asc" });
    expect(nextSort({ key: "slow", dir: "desc" }, "usual")).toEqual({ key: "usual", dir: "desc" });
    expect(nextSort({ key: "slow", dir: "desc" }, "check")).toEqual({ key: "check", dir: "asc" });
  });
});

describe("drawing", () => {
  it("writes a duration with the seconds it needs", () => {
    expect([s(22), s(480), s(672), s(3720), s(7200)].map(span)).toEqual(["22s", "8m", "11m 12s", "1h 2m", "2h"]);
  });
  it("draws every bar on one axis, so 11m is as long in one row as in the next", () => {
    const rows = [{ usual: s(672), slowEnd: s(1140), thisRun: s(1350) }, { usual: s(41), slowEnd: s(49), thisRun: s(40) }, { usual: s(660), slowEnd: s(750), thisRun: s(1770) }];
    const top = barTop(rows);
    expect(barScale(rows[2]!, top).marker).toBeLessThan(1);
    expect(barScale(rows[0]!, top).usual).toBeLessThan(barScale(rows[0]!, top).slowEnd);
    expect(barScale(rows[0]!, top).slowEnd).toBeLessThan(barScale(rows[0]!, top).marker!);
    // 41s beside a 30 minute check is a sliver, and still on the track.
    expect(barScale(rows[1]!, top).usual).toBeLessThan(0.03);
    expect(barScale({ usual: s(660), slowEnd: s(750), thisRun: null }, top).marker).toBeNull();
  });
  it("breaks the sparkline at a day with no success and ticks a lone day", () => {
    const t = [{ day: day(0), runs: 1, median: 5 }, { day: day(1), runs: 1, median: 9 }, { day: day(2), runs: 0, median: null }, { day: day(3), runs: 1, median: 7 }];
    const p = sparkPaths(t, 30, 10, 9);
    expect(p.lines).toHaveLength(2);
    expect(p.lines[1]!.split(" ")).toHaveLength(2);
    expect(p.last).toEqual({ x: 30, y: 5 });
    expect(p.refY).toBe(0);
  });
  it("keeps the dashed line inside the box when every day ran over it", () => {
    const t = [{ day: day(0), runs: 1, median: 50 }, { day: day(1), runs: 1, median: 60 }];
    const { refY } = sparkPaths(t, 30, 10, 20);
    expect(refY).toBe(10);
  });
  it("draws nothing for a check with no successful day", () => {
    expect(sparkPaths(flat(null), 30, 10)).toEqual({ lines: [], last: null, refY: null });
  });
});

// The pills above the list are one exclusive group by hand: each onClick clears
// the others' flags, and a new one that is not cleared by the rest leaves two
// views claiming the same screen.
const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
describe("the CI pill in the panel's exclusive row", () => {
  it("clears the inbox, and the inbox, the board and every scope clear it", () => {
    expect(panel).toContain("onClick={() => { setInboxOn(false); setMetricsOn(true); }}");
    expect(panel).toContain("onClick={() => { setMetricsOn(false); setInboxOn(true); }}");
    expect(panel).toContain("setInboxOn(false); setMetricsOn(false); setBoard(false); setFilter(v.scope)");
    expect(panel).toContain("setInboxOn(false); setMetricsOn(false); setStateSel(\"open\"); setBoard(true);");
  });
  it("is drawn before the inbox, which the switch would otherwise never reach", () => {
    expect(panel.indexOf("{metricsOn ? (")).toBeGreaterThan(0);
    expect(panel.indexOf("{metricsOn ? (")).toBeLessThan(panel.indexOf(") : inboxOn ? ("));
  });
});

/*
 * Flaky is a property of a TEST. A job can run thousands of them, and what the
 * rows hold is only that the job failed and then passed on one commit, so no
 * string a person reads may call a job flaky. Comments may say why not; only
 * code lines (labels, tooltips, chip keys, sort keys) are scanned.
 */
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join("\n");
const tableSources = {
  "shared/checkBaseline.ts": await Bun.file(new URL("../../shared/checkBaseline.ts", import.meta.url)).text(),
  "web/src/lib/ciMetrics.ts": await Bun.file(new URL("../src/lib/ciMetrics.ts", import.meta.url)).text(),
  "web/src/components/prs/CiMetrics.tsx": await Bun.file(new URL("../src/components/prs/CiMetrics.tsx", import.meta.url)).text(),
};
describe("the CI table never calls a job flaky", () => {
  for (const [name, src] of Object.entries(tableSources)) {
    it(`${name} has no flaky/flake in code or strings`, () => {
      expect(code(src).match(/flak/i)).toBeNull();
    });
  }
  it("the CI pill of the pull request panel does not either", () => {
    const pill = panel.split("\n").find((l) => l.includes("Every check of this repository against its own history"));
    expect(pill).not.toBeUndefined();
    expect(pill!.match(/flak/i)).toBeNull();
  });
  it("the badge and the hover say what was measured and point at the log", () => {
    expect(tableSources["web/src/components/prs/CiMetrics.tsx"]).toContain("Re-run passed");
    expect(rerunWhy(flipped(2))).toContain("That is the job, not a single test");
    expect(rerunWhy(flipped(2)).match(/flak/i)).toBeNull();
  });
});
