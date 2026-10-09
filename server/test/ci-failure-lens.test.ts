/*
 * The "Failing tests" lens: failures counted across everything the app has read,
 * and the capped backfill that reads more. Fake sources stand in for GitHub, so
 * what is asserted is the arithmetic, the verdicts and the request budget.
 * Names and numbers are invented.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-ci-lens-"));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "p.db");
const { readCheckFailures } = await import("../src/ciFailures.ts");
const { failingTests, refreshFailingTests, REFRESH_CAP } = await import("../src/ciFailureLens.ts");
const { recordRuns } = await import("../src/checkRuns.ts");
type C = import("../../shared/types.ts").PrCheck;
type Src = import("../src/ciFailures.ts").FailureSources;
type Lens = import("../src/ciFailureLens.ts").LensSources;

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-01T12:00:00Z");
const run = (job: string, state: "failure" | "success", at: number, name = "build"): C => ({
  name, workflow: "CI", event: "pull_request", state, done: true,
  url: `https://github.com/acme/orbit/actions/runs/${job}/job/${job}`,
  startedAt: new Date(at).toISOString(), completedAt: new Date(at + 60_000).toISOString(),
});
const LOG = (t: string, m: string) => `error: ${m}\n(fail) ${t} [1ms]`;
const srcOf = (log: string): Src => ({ annotations: async () => ({ ok: true, items: [] }), log: async () => ({ ok: true, text: log, bytes: log.length }), output: async () => ({ ok: true, output: null }) });
const read = (repo: string, job: string, log: string) => readCheckFailures(repo, job, {}, srcOf(log));

const step = story();

describe("the rows", () => {
  const R = "github.com/acme/lens1";
  step("one row per signature, counted over runs and pull requests, with first and last seen", async () => {
    const t = LOG("orbit sync > gives its slot back", "timeout after 20000ms");
    recordRuns(R, 475, "a1", [run("301", "failure", NOW - 9 * DAY)]);
    recordRuns(R, 471, "a2", [run("302", "failure", NOW - 5 * DAY)]);
    recordRuns(R, 471, "a3", [run("303", "failure", NOW - 2 * DAY)]);
    for (const j of ["301", "302", "303"]) await read(R, j, t);
    const r = failingTests(R, NOW);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ title: "orbit sync > gives its slot back", check: "build", runs: 3, prs: 2, verdict: { kind: "prs", prs: 2 } });
    expect(r.rows[0]!.firstSeen).toBe(NOW - 9 * DAY + 60_000);
    expect(r.rows[0]!.lastSeen).toBe(NOW - 2 * DAY + 60_000);
    expect(r.rows[0]!.gist).toBe("timeout after <t>");
  });

  step("a test on one pull request names it", async () => {
    const R2 = "github.com/acme/lens2";
    recordRuns(R2, 482, "b1", [run("311", "failure", NOW - DAY)]);
    await read(R2, "311", LOG("orbit board > keeps four lanes", "expected 4"));
    expect(failingTests(R2, NOW).rows[0]!.verdict).toEqual({ kind: "this-pr", pr: 482 });
  });

  step("a step's exit code is 'seen once'", async () => {
    const R3 = "github.com/acme/lens3";
    recordRuns(R3, 483, "c1", [run("321", "failure", NOW - DAY, "smoke")]);
    await read(R3, "321", "##[group]Run make smoke\n##[endgroup]\nboom\n##[error]Process completed with exit code 7.");
    expect(failingTests(R3, NOW).rows[0]).toMatchObject({ verdict: { kind: "once" }, check: "smoke" });
  });

  step("failed then passed on the same commit is flaky, by TEST: the same job is not the verdict", async () => {
    const R4 = "github.com/acme/lens4";
    recordRuns(R4, 484, "d1", [run("331", "failure", NOW - 3 * DAY)]);
    recordRuns(R4, 484, "d1", [run("332", "success", NOW - 3 * DAY + 600_000)]);
    await read(R4, "331", LOG("orbit desk > a second claim is refused", "expected refused"));
    expect(failingTests(R4, NOW).rows[0]!.verdict).toEqual({ kind: "flaky" });
  });

  step("says how much of the history it is counted from", async () => {
    const R5 = "github.com/acme/lens5";
    recordRuns(R5, 1, "e1", [run("341", "failure", NOW - DAY), run("342", "failure", NOW - 2 * DAY, "e2e"), run("343", "success", NOW - DAY, "lint")]);
    await read(R5, "341", LOG("a > b", "boom"));
    const r = failingTests(R5, NOW);
    expect(r).toMatchObject({ failedRuns: 2, readRuns: 1 });
  });

  step("a failed run older than the retention window is not counted", () => {
    const R6 = "github.com/acme/lens6";
    recordRuns(R6, 1, "f1", [run("351", "failure", NOW - 100 * DAY)], NOW);
    expect(failingTests(R6, NOW).failedRuns).toBe(0);
  });

  step("the default call makes no request: there is nothing here that could", () => {
    expect(failingTests("github.com/acme/empty", NOW)).toEqual({ ok: true, rows: [], failedRuns: 0, readRuns: 0 });
  });
});

describe("the refresh", () => {
  const lens = (o: { main?: Awaited<ReturnType<Lens["newestMainRun"]>>; jobs?: { id: string; name: string; at: number }[]; log?: (job: string) => string; budgetAfter?: number }) => {
    const calls: string[] = [];
    let reads = 0;
    const l: Lens = {
      newestMainRun: async () => { calls.push("main"); return o.main ?? { ok: true, run: null, requests: 1 }; },
      mainJobs: async () => { calls.push("jobs"); return { ok: true, jobs: o.jobs ?? [], requests: 1 }; },
      readJob: async (job, step) => {
        calls.push(`read ${job}`);
        if (o.budgetAfter != null && reads >= o.budgetAfter) return { ok: false, kind: "budget", resetAt: null, requests: 1 };
        reads++;
        return readCheckFailures(REPO, job, { step }, srcOf(o.log?.(job) ?? LOG("orbit board > keeps four lanes", "expected 4")));
      },
    };
    return { l, calls };
  };
  let REPO = "";

  step("reads at most the cap, newest first, counts what it cost and what is left", async () => {
    REPO = "github.com/acme/rf1";
    for (let i = 0; i < 8; i++) recordRuns(REPO, 600 + i, "g" + i, [run(String(400 + i), "failure", NOW - (8 - i) * 3_600_000)]);
    const { l, calls } = lens({});
    const r = await refreshFailingTests(REPO, l, NOW);
    expect(REFRESH_CAP).toBe(6);
    expect(r.refresh).toMatchObject({ read: 6, cap: 6, pending: 2, requests: 1 + 6 * 2, main: "unknown" });
    expect(calls.slice(1)).toEqual(["407", "406", "405", "404", "403", "402"].map((j) => `read ${j}`));
    // the second press reads the rest and nothing it already has
    const again = await refreshFailingTests(REPO, l, NOW);
    expect(again.refresh).toMatchObject({ read: 2, pending: 0 });
    const third = await refreshFailingTests(REPO, l, NOW);
    expect(third.refresh).toMatchObject({ read: 0, pending: 0, requests: 1 });
  });

  step("the newest main push, when it failed, is read first and makes its tests 'red on main'", async () => {
    REPO = "github.com/acme/rf2";
    recordRuns(REPO, 700, "h1", [run("501", "failure", NOW - 2 * DAY)]);
    const main = { ok: true as const, requests: 2, run: { id: "9001", sha: "m1", branch: "main", conclusion: "failure", at: NOW } };
    const { l, calls } = lens({ main, jobs: [{ id: "9101", name: "build", at: NOW }] });
    const r = await refreshFailingTests(REPO, l, NOW);
    expect(calls).toEqual(["main", "jobs", "read 9101", "read 501"]);
    expect(r.refresh).toMatchObject({ main: "red", requests: 2 + 1 + 2 * 2 });
    // pressed again: the same run, so its jobs are not listed twice
    const again = lens({ main, jobs: [{ id: "9101", name: "build", at: NOW }] });
    const second = await refreshFailingTests(REPO, again.l, NOW);
    expect(again.calls).toEqual(["main"]);
    expect(second.refresh).toMatchObject({ read: 0, requests: 2 });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ runs: 2, prs: 1, verdict: { kind: "main" } });
  });

  step("a newer main push that passed ends 'red on main', the old failure notwithstanding", async () => {
    REPO = "github.com/acme/rf2";
    const green = { ok: true as const, requests: 2, run: { id: "9002", sha: "m2", branch: "main", conclusion: "success", at: NOW + 1 } };
    const { l } = lens({ main: green });
    const r = await refreshFailingTests(REPO, l, NOW);
    expect(r.refresh).toMatchObject({ main: "green" });
    expect(r.rows[0]!.verdict).not.toEqual({ kind: "main" });
  });

  step("stops at the budget, keeps what it read, and says so", async () => {
    REPO = "github.com/acme/rf3";
    for (let i = 0; i < 4; i++) recordRuns(REPO, 800 + i, "i" + i, [run(String(600 + i), "failure", NOW - (4 - i) * 3_600_000)]);
    const { l } = lens({ budgetAfter: 2 });
    const r = await refreshFailingTests(REPO, l, NOW);
    expect(r.refresh).toMatchObject({ read: 2, pending: 2, error: "GitHub's hourly budget is used up" });
    expect(r.rows.length).toBeGreaterThan(0);
  });

  step("a main run that cannot be looked at does not stop the pull request backfill from being counted, and says why", async () => {
    REPO = "github.com/acme/rf4";
    recordRuns(REPO, 900, "j1", [run("701", "failure", NOW - DAY)]);
    const { l } = lens({ main: { ok: false, error: "could not list the newest push", requests: 2 } });
    const r = await refreshFailingTests(REPO, l, NOW);
    expect(r.refresh).toMatchObject({ main: "unknown", error: "could not list the newest push" });
  });
});
