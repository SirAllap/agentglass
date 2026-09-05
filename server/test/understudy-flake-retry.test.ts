/*
 * A flake must not stop the queue.
 *
 * A shift stops on ONE failed run — deliberately, and it is the right rule:
 * everything queued behind a failure was drafted against a picture of the world
 * that turned out wrong. But the tmux tests share a single socket and the server
 * behind it is single-threaded, so under load a couple of them lose a race that
 * has nothing to do with the change under test. When that happens the cost is
 * not one run, it is the whole queue until somebody comes back and looks.
 *
 * Measured on three separate runs in one afternoon: each reported a red, and
 * each came back green on a second pass in the same worktree with nothing
 * changed at all.
 *
 * So: ask twice, and only a red twice is a failure — but never silently, because
 * a retry nobody is told about is how a real intermittent bug hides for months.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/index.ts", import.meta.url).pathname, "utf8");

function fn(name: string): string {
  const from = src.indexOf(`function ${name}(`);
  expect(from).toBeGreaterThan(-1);
  const next = src.slice(from + 1).search(/\n(?:async )?function [A-Za-z]/);
  return next === -1 ? src.slice(from) : src.slice(from, from + 1 + next);
}

describe("a red suite is asked again before it stops anything", () => {
  /* The retry is PER SUITE, not per verdict: `runTestsIn` walks the table and
     this is the part that asks one of them twice. A flake in web must not cost
     the run any more than a flake in server does. */
  const body = fn("runOneSuiteWithRetry");

  test("every suite in the table gets the same retry", () => {
    const runner = fn("runTestsIn");
    expect(runner).toContain("for (const suite of VERDICT_SUITES)");
    expect(runner).toContain("runOneSuiteWithRetry(cwd, timeoutMs, suite)");
  });

  test("a green first run is not run twice", () => {
    const at = body.indexOf("if (first.ok) return");
    expect(at).toBeGreaterThan(-1);
    // The second call has to come after the early return, or every passing run
    // pays for the flake protection twice over.
    expect(body.indexOf("runSuiteOnce(cwd, timeoutMs, suite)", at)).toBeGreaterThan(at);
  });

  test("red then green is a pass, and it says so", () => {
    expect(body).toContain("ok: true");
    expect(body).toContain("the first run of this suite was red and the second was green");
  });

  test("red twice is still a failure", () => {
    expect(body).toMatch(/if \(!second\.ok\) \{[\s\S]*?ok: false/);
  });

  test("a run that failed twice reports what reproduced, not what merely failed once", () => {
    const stuck = body.slice(body.indexOf("if (!second.ok)"));
    expect(stuck).toContain("failedTestNames(second.out)");
    expect(stuck).toContain("and failed again");
  });
});

describe("the report names the tests, instead of losing them to the tail", () => {
  test("failures are pulled out before anything is trimmed", () => {
    const body = fn("failedTestNames");
    expect(body).toMatch(/\\\(fail\\\)/);
  });

  test("one suite run keeps the whole output — trimming is the caller's job", () => {
    const once = fn("runSuiteOnce");
    expect(once).toContain("return { ok: code === 0, out: both };");
    expect(once).not.toContain("both.slice(-4000)");
  });

  test("both streams are still read at once, because sequence deadlocks", () => {
    const once = fn("runSuiteOnce");
    expect(once).toContain("await Promise.all([");
    expect(once).toContain("new Response(p.stderr).text()");
  });
});
