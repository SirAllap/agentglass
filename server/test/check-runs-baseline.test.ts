// A job that always takes 15 minutes is not slow. The baseline is the same job
// (workflow, name, trigger) on earlier runs of any pull request of the repo.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-check-runs-"));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "p.db");
const { recordRuns, annotateUsual, repoMetrics, RUNS_PER_KEY } = await import("../src/checkRuns.ts");
const { db } = await import("../src/db.ts");
type C = import("../../shared/types.ts").PrCheck;

const T0 = Date.parse("2026-09-01T00:00:00Z");
let n = 0;
const run = (name: string, min: number, o: Partial<C> = {}, at = T0 + ++n * 3_600_000): C => ({
  name, workflow: "Evals", event: "pull_request", state: "success", done: true,
  url: `https://github.com/acme/orbit/actions/runs/${n}/job/${at}`,
  startedAt: new Date(at).toISOString(), completedAt: new Date(at + min * 60_000).toISOString(), ...o,
});

describe("check run history", () => {
  test("many pull requests fill one history per key; the median is the job's own", () => {
    for (let i = 0; i < 12; i++) recordRuns("acme/orbit", 100 + i, "abc", [run("suite", 14 + (i % 3) - 1)]);
    const now = run("suite", 15);
    annotateUsual("acme/orbit", [now]);
    expect(now.usual?.n).toBe(12);
    expect(now.usual?.median).toBe(14 * 60_000);
    // another repo, another trigger, another job: nothing borrowed
    const other = [run("suite", 15, { event: "push" }), run("lint", 1)];
    annotateUsual("acme/orbit", other);
    expect(other[0].usual).toBeUndefined();
    const elsewhere = [run("suite", 15)];
    annotateUsual("acme/harbor", elsewhere);
    expect(elsewhere[0].usual).toBeUndefined();
  });

  test("only the last 20 successes count, and failures and cancellations do not move the median", () => {
    for (let i = 0; i < 30; i++) recordRuns("acme/orbit", i, "", [run("unit", 2)]);
    for (let i = 0; i < 10; i++) recordRuns("acme/orbit", i, "", [run("unit", 30, { state: "failure" })]);
    recordRuns("acme/orbit", 1, "", [run("unit", 30, { state: "failure", cancelled: true })]);
    const c = run("unit", 2);
    annotateUsual("acme/orbit", [c]);
    expect(c.usual).toEqual({ median: 120_000, p90: 120_000, n: 20 });
    const m = repoMetrics("acme/orbit", T0 + 40 * 86_400_000).find((x) => x.name === "unit")!;
    expect(m.aggregate.runs).toBe(41);
    expect(m.aggregate.failureRate).toBeCloseTo(10 / 40);
  });

  test("the run being read is left out of its own baseline", () => {
    const self = run("solo", 40);
    recordRuns("acme/orbit", 1, "", [run("solo", 10), run("solo", 10), run("solo", 10), run("solo", 10), self]);
    annotateUsual("acme/orbit", [self]);
    expect(self.usual?.n).toBe(4);
    expect(self.usual?.median).toBe(10 * 60_000);
  });

  test("skipped, running and undated runs are not stored, and a run is stored once", () => {
    const before = (db.prepare("SELECT COUNT(*) c FROM check_runs").get() as { c: number }).c;
    const c = run("once", 3);
    expect(recordRuns("acme/orbit", 1, "", [c, c, run("s", 1, { state: "skipped" }), run("p", 1, { state: "pending", done: false }), run("u", 1, { completedAt: undefined })])).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM check_runs").get() as { c: number }).c).toBe(before + 1);
  });

  test("retention: 200 runs per key, and nothing older than 90 days", () => {
    const now = Date.now();
    for (let i = 0; i < RUNS_PER_KEY + 15; i++) recordRuns("acme/orbit", i, "", [run("many", 1, {}, now - 3_600_000 - i * 1000)], now);
    recordRuns("acme/orbit", 1, "", [run("many", 1, {}, now - 100 * 86_400_000)], now);
    const q = (db.prepare("SELECT COUNT(*) c FROM check_runs WHERE key LIKE '%many%'").get() as { c: number }).c;
    expect(q).toBe(RUNS_PER_KEY);
  });
});
