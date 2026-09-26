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
import { byUrgency, foldJobLog, looksFailed, standingOf, tailOf } from "../src/model/checkJobs.ts";
import type { PrCheckJob } from "../../shared/types.ts";

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
