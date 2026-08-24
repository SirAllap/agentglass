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
import { byUrgency, standingOf, tailOf } from "../src/model/checkJobs.ts";
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
