/*
 * The rules that decide whether a CI job is red, and which log lines open.
 *
 * Every one of these is a thing the screen would otherwise get wrong silently.
 * A job read as failed when it is still running sends somebody to fix nothing;
 * a job read as fine when it reported no conclusion hides the thing they came
 * for. Neither shows up in a screenshot, because both draw a perfectly
 * ordinary row.
 */
import { describe, expect, test } from "bun:test";
import { DETAIL_POLL_MS, JOBS_POLL_MS, byUrgency, foldJobLog, jobSquares, jobsLine, jobsPassedLine, looksFailed, checksMoved, nextDetailPoll, nextJobsPoll, runLine, runGroups, greenMeansLine, runSquares, runningCheckLine, standingOf, tailOf } from "../src/model/checkJobs.ts";
import type { PrCheck, PrCheckJob, PrCheckRollup } from "../../shared/types.ts";

const job = (over: Partial<PrCheckJob> = {}): PrCheckJob => ({
  id: "1", runId: "9", name: "test", status: "completed", conclusion: "success",
  startedAt: null, completedAt: null, url: "", ...over,
});

describe("what a job is", () => {
  test("status is read before conclusion", () => {
    // The one that matters: `conclusion` is null while a job runs, and reading
    // it first makes a running job indistinguishable from one with no verdict.
    const running = standingOf(job({ status: "in_progress", conclusion: null }));
    expect(running.standing).toBe("running");
    expect(running.word).toBe("in progress");
  });

  test("queued is running, not waiting to fail", () => {
    expect(standingOf(job({ status: "queued", conclusion: null })).standing).toBe("running");
  });

  test("success is the only conclusion that passes", () => {
    expect(standingOf(job({ conclusion: "success" })).standing).toBe("fine");
    expect(standingOf(job({ conclusion: "SUCCESS" })).standing).toBe("fine");
  });

  test("skipped and neutral are not failures", () => {
    // A path-filtered workflow skips most of its jobs on most pull requests.
    // Counting those as red reports an ordinary branch as twenty failures.
    expect(standingOf(job({ conclusion: "skipped" })).standing).toBe("fine");
    expect(standingOf(job({ conclusion: "neutral" })).standing).toBe("fine");
  });

  test("a completed job with no conclusion is not a pass", () => {
    expect(standingOf(job({ conclusion: null })).standing).toBe("failed");
    expect(standingOf(job({ conclusion: "" })).standing).toBe("failed");
  });

  test("GitHub's own word survives, rather than being flattened to «failed»", () => {
    // A cancelled job and a failing test are different things to do next.
    expect(standingOf(job({ conclusion: "cancelled" })).word).toBe("cancelled");
    expect(standingOf(job({ conclusion: "timed_out" })).word).toBe("timed_out");
  });
});

describe("the order they are shown in", () => {
  test("failed first, then running, then the rest", () => {
    const list = [
      job({ id: "ok", conclusion: "success" }),
      job({ id: "going", status: "in_progress", conclusion: null }),
      job({ id: "bad", conclusion: "failure" }),
    ];
    expect(byUrgency(list).map((j) => j.id)).toEqual(["bad", "going", "ok"]);
  });

  test("inside a band the workflow's own order is kept", () => {
    // Which means the first red job is the first thing that broke — usually
    // the only one worth reading.
    const list = [
      job({ id: "build", conclusion: "failure" }),
      job({ id: "test", conclusion: "failure" }),
      job({ id: "lint", conclusion: "failure" }),
    ];
    expect(byUrgency(list).map((j) => j.id)).toEqual(["build", "test", "lint"]);
  });

  test("it does not sort the caller's array", () => {
    // That array is React state; sorting it in place is a mutation nothing
    // re-renders on.
    const list = [job({ id: "ok" }), job({ id: "bad", conclusion: "failure" })];
    byUrgency(list);
    expect(list.map((j) => j.id)).toEqual(["ok", "bad"]);
  });

  test("an empty list is an empty list", () => {
    expect(byUrgency([])).toEqual([]);
  });
});

describe("which lines of the log open", () => {
  test("the tail, because that is where a failure is", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const { lines, total } = tailOf(text, 3);
    expect(total).toBe(10);
    expect(lines).toEqual(["line 8", "line 9", "line 10"]);
  });

  test("a short log is not trimmed", () => {
    const { lines, total } = tailOf("one\ntwo", 100);
    expect(total).toBe(2);
    expect(lines).toEqual(["one", "two"]);
  });

  test("trailing blank lines go before the count is taken", () => {
    // A log ending in six of them would otherwise open on an empty screen,
    // which reads exactly like a log that failed to load.
    const { lines, total } = tailOf("real\n\n\n   \n", 2);
    expect(total).toBe(1);
    expect(lines).toEqual(["real"]);
  });

  test("an empty log has no lines, not one empty one", () => {
    // "".split("\n") is [""], which would draw a blank row and count it.
    expect(tailOf("", 10)).toEqual({ lines: [], total: 0 });
    expect(tailOf("   \n  ", 10)).toEqual({ lines: [], total: 0 });
  });

  test("exactly the limit is not trimmed", () => {
    const text = "a\nb\nc";
    expect(tailOf(text, 3).lines).toEqual(["a", "b", "c"]);
  });
});

describe("foldJobLog", () => {
  // Shaped like a real Actions log, with an invented workflow so nobody's
  // name lands in the fixture: the stamp, one folded step, and a failure
  // inside another.
  const raw = [
    "2026-03-04T09:12:03.5910000Z ##[group]Run npm ci",
    "2026-03-04T09:12:03.6010000Z added 412 packages in 6s",
    "2026-03-04T09:12:04.1000000Z ##[endgroup]",
    "2026-03-04T09:12:05.2200000Z ##[group]Run the acme-widget test suite",
    "2026-03-04T09:12:07.0000000Z ##[error]Process completed with exit code 1.",
    "2026-03-04T09:12:07.0100000Z ##[endgroup]",
  ].join("\n");

  test("strips the timestamp from every line", () => {
    for (const line of foldJobLog(raw).split("\n")) {
      expect(/^\d{4}-\d\d-\d\dT/.test(line)).toBe(false);
    }
  });

  test("a group marker becomes its title, and the close marker is gone", () => {
    const lines = foldJobLog(raw).split("\n");
    expect(lines).toEqual([
      "Run npm ci",
      "added 412 packages in 6s",
      "Run the acme-widget test suite",
      "##[error]Process completed with exit code 1.",
    ]);
  });

  test("##[error] survives folding, so the row still tints red", () => {
    const errorLine = foldJobLog(raw).split("\n").find((l) => l.includes("exit code 1"));
    expect(errorLine).toBeDefined();
    expect(looksFailed(errorLine!)).toBe(true);
  });

  test("a group with no title still gets a line, not a blank one lost to trimming", () => {
    expect(foldJobLog("2026-01-01T00:00:00.0000000Z ##[group]").split("\n")).toEqual(["step"]);
  });
});

/* The Checks screen read once and stayed on "running" after the run finished:
 * the phone said 2 failed while GitHub said 7/7. It asks again while something
 * runs, and stops when nothing does. */
describe("when to ask again", () => {
  test("only while a job is running", () => {
    expect(nextJobsPoll([job(), job({ status: "in_progress", conclusion: null })])).toBe(JOBS_POLL_MS);
    expect(nextJobsPoll([job(), job({ conclusion: "failure" })])).toBeNull();
    expect(nextJobsPoll([])).toBeNull();
    expect(nextJobsPoll(null)).toBeNull();
  });
  test("the pull request screen follows its pending count, more slowly", () => {
    expect(nextDetailPoll(3)).toBe(DETAIL_POLL_MS);
    expect(DETAIL_POLL_MS).toBeGreaterThan(JOBS_POLL_MS);
    expect(nextDetailPoll(0)).toBeNull();
    expect(nextDetailPoll(undefined)).toBeNull();
  });
});

describe("did the checks move", () => {
  const roll = (over: Partial<PrCheckRollup> = {}): PrCheckRollup => ({
    total: 7, success: 5, failure: 0, skipped: 0, pending: 2, allDone: false, verdict: null, failing: [], ...over,
  });
  test("same counts: no full re-read is worth paying for", () => {
    expect(checksMoved(roll(), roll())).toBe(false);
  });
  test("a job finishing, failing or appearing is a move", () => {
    expect(checksMoved(roll(), roll({ pending: 1, success: 6 }))).toBe(true);
    expect(checksMoved(roll(), roll({ pending: 1, failure: 1 }))).toBe(true);
    expect(checksMoved(roll(), roll({ total: 8 }))).toBe(true);
  });
});

/* The run as the mock draws it (screens 32 and 34). */
const roll = (over: Partial<PrCheckRollup> = {}): PrCheckRollup => ({
  total: 6, success: 6, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [], ...over,
});

describe("the run's own line", () => {
  test("the denominator is the number a reader cannot get elsewhere", () => {
    expect(runLine(roll({ total: 49, success: 48, pending: 1 }))).toBe("48 of 49 passed · 1 running");
  });
  test("a failure is named before the ones still going", () => {
    expect(runLine(roll({ total: 4, success: 2, failure: 1, pending: 1 }))).toBe("2 of 4 passed · 1 failed · 1 running");
  });
  test("no checks at all is not zero of zero", () => {
    expect(runLine(roll({ total: 0, success: 0 }))).toBe("No checks on this pull request");
  });
});

describe("the Overview's strip (mock 32)", () => {
  const check = (over: Partial<PrCheck>): PrCheck => ({
    name: "test", workflow: "ci", state: "pending", done: false, ...over,
  });

  test("the chip counts what is not failing, over the whole run", () => {
    expect(jobsPassedLine(roll({ total: 3, success: 2, pending: 1 }))).toBe("2 of 3 jobs passed");
    // A skipped check is not a failure, so it counts as passed here as it
    // does on the board's bar.
    expect(jobsPassedLine(roll({ total: 2, success: 1, skipped: 1 }))).toBe("2 of 2 jobs passed");
    expect(jobsPassedLine(roll({ total: 0, success: 0 }))).toBe("No checks");
  });

  test("the running line names the oldest job and how long it has been", () => {
    const now = Date.parse("2026-11-04T12:04:00Z");
    const line = runningCheckLine([
      check({ name: "web", startedAt: "2026-11-04T12:03:00Z" }),
      check({ name: "server tests", startedAt: "2026-11-04T12:00:00Z" }),
      check({ name: "lint", state: "success", done: true, startedAt: "2026-11-04T11:00:00Z" }),
    ], now);
    expect(line).toBe("server tests · 4 min in");
  });

  test("nothing running is no line, not a stale one", () => {
    expect(runningCheckLine([check({ state: "success", done: true, startedAt: "2026-11-04T11:00:00Z" })], 0)).toBeNull();
    // A queued job has no start time: the name is all that can be said.
    expect(runningCheckLine([check({ name: "web" })], 0)).toBe("web");
  });
});

describe("the squares", () => {
  test("red first, then running, then the rest, capped", () => {
    expect(runSquares(roll({ total: 4, success: 1, failure: 2, pending: 1 }))).toEqual(["fail", "fail", "run", "pass"]);
    expect(runSquares(roll({ total: 49, success: 49 }), 10).length).toBe(10);
  });
  test("a skipped check is not painted green", () => {
    expect(runSquares(roll({ total: 2, success: 0, skipped: 2 }))).toEqual(["skip", "skip"]);
  });
  test("one square per job, and never more squares than jobs", () => {
    const jobs = [
      job({ id: "a", name: "build", conclusion: "failure" }),
      job({ id: "b", name: "test", status: "in_progress", conclusion: null }),
      job({ id: "c", name: "web" }),
    ];
    expect(jobSquares(jobs)).toEqual(["fail", "run", "pass"]);
  });
  test("the job line counts what is there", () => {
    expect(jobsLine([
      job({ id: "a", conclusion: "failure" }),
      job({ id: "b", status: "in_progress", conclusion: null }),
      job({ id: "c" }),
    ])).toBe("3 jobs · 1 failed · 1 running · 1 passed");
  });
});

describe("the run grouped by workflow (mock 41)", () => {
  const check = (over: Partial<PrCheck>): PrCheck => ({
    name: "test", workflow: "build", state: "success", done: true, ...over,
  });

  test("one row per workflow, in GitHub's order, with its own squares", () => {
    const rows = runGroups([
      check({ workflow: "build" }),
      check({ workflow: "server", state: "pending" }),
      check({ workflow: "build" }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["build", "server"]);
    expect(rows[0]!.squares).toEqual(["pass", "pass"]);
    expect(rows[0]!.word).toBe("passed");
    expect(rows[1]!.word).toBe("1 running");
  });

  test("a failure is the word, even with a job still running", () => {
    const rows = runGroups([
      check({ workflow: "server", state: "pending" }),
      check({ workflow: "server", state: "failure" }),
    ]);
    expect(rows[0]!.word).toBe("1 failed");
    expect(rows[0]!.tone).toBe("failed");
  });

  test("a workflow whose checks were all skipped does not read as passed", () => {
    const rows = runGroups([check({ workflow: "labels", state: "skipped" })]);
    expect(rows[0]!.word).toBe("does not run");
    expect(rows[0]!.squares).toEqual(["skip"]);
  });

  test("a check with no workflow stands under its own name", () => {
    expect(runGroups([check({ workflow: "", name: "commit-lint" })])[0]!.name).toBe("commit-lint");
  });

  test("the skip line counts checks, not words", () => {
    expect(greenMeansLine(49, 4)).toBe("Green means 45 checks, not 49");
    expect(greenMeansLine(49, 0)).toBe("Green means all 49 checks");
  });
});
