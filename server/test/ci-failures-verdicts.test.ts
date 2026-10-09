/*
 * A failure's verdict is worked out from what the app has read, joined to the
 * check runs it knows: which pull request each job belonged to, and whether the
 * same job re-ran on the same commit and passed. Names and numbers are invented.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-ci-verdicts-"));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "p.db");
const { readCheckFailures, cachedSummaries } = await import("../src/ciFailures.ts");
const { recordRuns } = await import("../src/checkRuns.ts");
type C = import("../../shared/types.ts").PrCheck;
type Src = import("../src/ciFailures.ts").FailureSources;

const REPO = "github.com/acme/orbit";
const T0 = Date.parse("2026-09-20T00:00:00Z");
const LOG = (test: string, msg: string) => `error: ${msg}\n(fail) ${test} [1ms]`;
const run = (job: string, state: "failure" | "success", at: number): C => ({
  name: "build", workflow: "CI", event: "pull_request", state, done: true,
  url: `https://github.com/acme/orbit/actions/runs/${job}/job/${job}`,
  startedAt: new Date(at).toISOString(), completedAt: new Date(at + 60_000).toISOString(),
});
const src = (log: string): Src => ({ annotations: async () => ({ ok: true, items: [] }), log: async () => ({ ok: true, text: log, bytes: log.length }), output: async () => ({ ok: true, output: null }) });
const read = (job: string, log: string) => readCheckFailures(REPO, job, {}, src(log));

describe("verdicts from what was read", () => {
  test("the same failure on two other pull requests says so, counting pull requests", async () => {
    const log = LOG("orbit sync > gives its slot back", "timeout after 20000ms");
    recordRuns(REPO, 475, "aaa", [run("201", "failure", T0)]);
    recordRuns(REPO, 471, "bbb", [run("202", "failure", T0 + 1_000_000)]);
    recordRuns(REPO, 482, "ccc", [run("203", "failure", T0 + 2_000_000)]);
    await read("201", log);
    await read("202", log);
    const mine = await read("203", log);
    expect(mine.ok && mine.verdicts).toEqual([{ kind: "others", prs: 2 }]);
  });

  test("a failure only this pull request has read is 'this PR', and says no more", async () => {
    recordRuns(REPO, 490, "ddd", [run("210", "failure", T0)]);
    const r = await read("210", LOG("orbit board > keeps four lanes", "expected 4"));
    expect(r.ok && r.verdicts).toEqual([{ kind: "this-pr" }]);
  });

  test("a job that re-ran green on the same commit makes its failing tests flaky", async () => {
    recordRuns(REPO, 495, "eee", [run("220", "failure", T0)]);
    recordRuns(REPO, 495, "eee", [run("221", "success", T0 + 600_000)]);
    const r = await read("220", LOG("orbit desk > a second claim is refused", "expected refused"));
    expect(r.ok && r.verdicts).toEqual([{ kind: "flaky" }]);
  });

  test("a green re-run on ANOTHER commit is a new commit's result, not a retry", async () => {
    recordRuns(REPO, 496, "fff", [run("230", "failure", T0)]);
    recordRuns(REPO, 496, "ggg", [run("231", "success", T0 + 600_000)]);
    const r = await read("230", LOG("orbit desk > another claim", "expected refused"));
    expect(r.ok && r.verdicts).toEqual([{ kind: "this-pr" }]);
  });

  test("a job whose commit is unknown is never judged flaky", async () => {
    recordRuns(REPO, 497, "", [run("240", "failure", T0)]);
    recordRuns(REPO, 497, "", [run("241", "success", T0 + 600_000)]);
    const r = await read("240", LOG("orbit desk > third claim", "expected refused"));
    expect(r.ok && r.verdicts).toEqual([{ kind: "this-pr" }]);
  });

  test("a step's exit code is 'seen once', however often it repeats", async () => {
    const smoke = "##[group]Run make smoke\n##[endgroup]\nboom\n##[error]Process completed with exit code 7.";
    recordRuns(REPO, 498, "hhh", [run("250", "failure", T0)]);
    recordRuns(REPO, 499, "iii", [run("251", "failure", T0)]);
    await read("250", smoke);
    const r = await read("251", smoke);
    expect(r.ok && r.verdicts).toEqual([{ kind: "once" }]);
  });

  test("the cache answers with verdicts too, and the history is as of now: a later PR changes an earlier answer", async () => {
    const log = LOG("orbit lanes > fresh one", "boom");
    recordRuns(REPO, 500, "jjj", [run("260", "failure", T0)]);
    await read("260", log);
    expect(cachedSummaries(REPO, ["260"])["260"]!.verdicts).toEqual([{ kind: "this-pr" }]);
    recordRuns(REPO, 501, "kkk", [run("261", "failure", T0 + 1_000)]);
    await read("261", log);
    expect(cachedSummaries(REPO, ["260"])["260"]!.verdicts).toEqual([{ kind: "others", prs: 1 }]);
  });
});
