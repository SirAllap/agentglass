// "Flaky" means the same commit both failed and passed the same check. A check
// that fails on every push is broken, not flaky, and a cancelled run says
// nothing about the job. Measured on the old rule (1 failure in 20 runs): a
// check that failed because the code was wrong, and one cancelled by a newer
// push, both came out "Flaky".
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-check-flaky-"));
/* A repository of its own: bun runs every test file in one process, the
   database is whichever one the first import opened, and check-runs-baseline
   records the same "unit" key under acme/orbit — sharing the name made both
   files prune each other's history. */
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "p.db");
const { recordRuns, repoMetrics } = await import("../src/checkRuns.ts");
const { flakiness, isFlaky } = await import("../../shared/checkBaseline.ts");
type C = import("../../shared/types.ts").PrCheck;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse("2026-09-20T00:00:00Z");
const NOW = T0 + 5 * 86_400_000;
let n = 0;
/** One attempt of a job. GitHub gives a re-run its own job URL (`/runs/R/job/J`, a new J), which is what tells the two attempts apart here. */
const attempt = (name: string, state: C["state"], o: Partial<C> = {}): C => {
  const at = T0 + ++n * 600_000;
  return {
    name, workflow: "CI", event: "pull_request", state, done: true,
    url: `https://github.com/acme/lumen/actions/runs/${9000 + Math.floor(n / 3)}/job/${at}`,
    startedAt: new Date(at).toISOString(), completedAt: new Date(at + 120_000).toISOString(), ...o,
  };
};
const sha = (s: string) => s.padEnd(40, "0");
const metric = (repo: string, name: string) => repoMetrics(repo, NOW).find((m) => m.name === name)!.aggregate;

describe("flaky = the same commit both failed and passed", () => {
  test("a check that failed then passed on the same commit, on several commits, is flaky", () => {
    for (const s of ["a1", "b2", "c3"]) {
      recordRuns("acme/lumen", 1, sha(s), [attempt("unit", "failure")]);
      recordRuns("acme/lumen", 1, sha(s), [attempt("unit", "success")]); // the re-run passed
    }
    recordRuns("acme/lumen", 2, sha("d4"), [attempt("unit", "success")]);
    recordRuns("acme/lumen", 2, sha("e5"), [attempt("unit", "success")]);
    const f = metric("acme/lumen", "unit").flakiness;
    expect(f.flips).toBe(3);
    expect(f.judged).toBe(8);
    expect(isFlaky(f)).toBe(true);
  });

  test("a check that fails on every commit and never passes is broken, not flaky", () => {
    for (const s of ["f1", "f2", "f3", "f4", "f5", "f6"]) recordRuns("acme/lumen", 3, sha(s), [attempt("e2e", "failure")]);
    // even retried on the same commit: it failed both times
    recordRuns("acme/lumen", 3, sha("f6"), [attempt("e2e", "failure")]);
    const a = metric("acme/lumen", "e2e");
    expect(a.failureRate).toBe(1);
    expect(a.flakiness.flips).toBe(0);
    expect(isFlaky(a.flakiness)).toBe(false);
  });

  test("failing on one commit and passing on the next is a fix, not a flake", () => {
    // What the old rule got wrong: 1 failure in 6 runs, every one of them honest.
    recordRuns("acme/lumen", 4, sha("g1"), [attempt("lint", "failure")]);
    for (const s of ["g2", "g3", "g4", "g5", "g6"]) recordRuns("acme/lumen", 4, sha(s), [attempt("lint", "success")]);
    const a = metric("acme/lumen", "lint");
    expect(a.failureRate).toBeCloseTo(1 / 6);
    expect(isFlaky(a.flakiness)).toBe(false);
  });

  test("a cancelled run and a skipped one are not a failure", () => {
    for (const s of ["h1", "h2", "h3", "h4", "h5"]) {
      recordRuns("acme/lumen", 5, sha(s), [attempt("build", "failure", { cancelled: true })]);
      recordRuns("acme/lumen", 5, sha(s), [attempt("build", "success")]);
    }
    recordRuns("acme/lumen", 5, sha("h6"), [attempt("build", "skipped")]);
    const f = metric("acme/lumen", "build").flakiness;
    expect(f.flips).toBe(0);
    expect(isFlaky(f)).toBe(false);
  });

  test("runs recorded without their commit cannot be judged, and say so", () => {
    for (let i = 0; i < 4; i++) {
      recordRuns("acme/lumen", 6, "", [attempt("old", "failure")]);
      recordRuns("acme/lumen", 6, "", [attempt("old", "success")]);
    }
    const f = metric("acme/lumen", "old").flakiness;
    expect(f.unknown).toBe(8);
    expect(f.judged).toBe(0);
    expect(isFlaky(f)).toBe(false);
  });

  test("a read that arrives late fills in the commit of a run stored without one, and nothing overwrites it after", () => {
    const c = attempt("late", "failure");
    expect(recordRuns("acme/lumen", 7, "", [c])).toBe(1);
    expect(recordRuns("acme/lumen", 7, sha("i1"), [c])).toBe(1);
    // a second read that names another commit does not move a run that already has one
    expect(recordRuns("acme/lumen", 7, sha("i2"), [c])).toBe(0);
    const f = metric("acme/lumen", "late").flakiness;
    expect(f.unknown).toBe(0);
    expect(f.judged).toBe(1);
  });

  test("the same commit in two pull requests is two merge results, not one commit that disagreed", () => {
    for (const s of ["l1", "l2", "l3", "l4", "l5"]) {
      recordRuns("acme/lumen", 20, sha(s), [attempt("stacked", "failure")]);
      recordRuns("acme/lumen", 21, sha(s), [attempt("stacked", "success")]); // same head, another base
    }
    expect(metric("acme/lumen", "stacked").flakiness.flips).toBe(0);
  });

  test("under the minimum sample nothing is called, however it flipped", () => {
    recordRuns("acme/lumen", 8, sha("j1"), [attempt("rare", "failure")]);
    recordRuns("acme/lumen", 8, sha("j1"), [attempt("rare", "success")]);
    const f = metric("acme/lumen", "rare").flakiness;
    expect(f.flips).toBe(1);
    expect(isFlaky(f)).toBe(false);
  });

  test("only the last 14 days count", () => {
    const rows = [0, 1, 2, 3, 4].flatMap((i) => [
      { conclusion: "failure" as const, ms: 1, completedAt: NOW - 20 * 86_400_000 + i, sha: sha("k" + i) },
      { conclusion: "success" as const, ms: 1, completedAt: NOW - 20 * 86_400_000 + i + 1, sha: sha("k" + i) },
    ]);
    expect(flakiness(rows, NOW).flips).toBe(0);
    expect(flakiness(rows, NOW, 30).flips).toBe(5);
  });
});

const prsSrc = await Bun.file(join(import.meta.dir, "../src/prs.ts")).text();

describe("the commit comes from the response that carried the checks", () => {
  const code = prsSrc.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  test("both reads ask GitHub for the commit's oid and file the runs under it", () => {
    expect(code.match(/commit\{oid [^`]*?contexts\(first:100\)/g)?.length).toBe(2);
    const calls = code.match(/learnFromRead\([^;]*;/g) ?? [];
    expect(calls.length).toBe(2);
    // A cached head can be a push behind: filing runs under it invents flakes.
    for (const c of calls) expect(c).not.toContain("knownHeadSha");
    expect(calls.filter((c) => c.includes("commit?.oid")).length).toBe(2);
  });

  test("a push between two pages of checks stops the walk instead of mixing two commits", () => {
    const fill = code.slice(code.indexOf("async function fillChecks("));
    const body = fill.slice(0, fill.indexOf("\n}\n"));
    expect(body).toContain("commit{oid ");
    expect(body).toMatch(/oid !== [^)]*oid\) break/);
  });
});
