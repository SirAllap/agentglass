/*
 * A run is handed a worktree with its dependencies in it, and its own words are
 * kept.
 *
 * Two failures from the same afternoon, both of which cost a whole shift rather
 * than one task, because one failed run ends a shift by design.
 *
 * ONE. `git worktree add` links no `node_modules`. The brief has told the agent
 * to run `bun install` first for a while now, and the paragraph names the four
 * runs that learned it the expensive way — one spent 16 minutes of a 23-minute
 * run reading `Cannot find package` as its own change breaking the suite. A
 * fifth then failed differently: it never ran the install at all, six tests
 * failed for "node_modules is missing", and the queue behind it stopped. An
 * instruction the agent can forget is the wrong shape for a precondition of the
 * verdict meaning anything, so the loop does it.
 *
 * TWO. The outcome was the test output alone. A run that concluded "measured,
 * nothing to fix" recorded 3900 pass / 0 fail and not one word of why — the
 * answer thrown away, the proof kept.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const loop = readFileSync(new URL("../src/understudy-loop.ts", import.meta.url).pathname, "utf8");
const index = readFileSync(new URL("../src/index.ts", import.meta.url).pathname, "utf8");

function fn(src: string, name: string): string {
  const from = src.indexOf(`function ${name}(`);
  expect(from, `${name} should exist`).toBeGreaterThan(-1);
  const next = src.slice(from + 1).search(/\n(?:async )?function [A-Za-z]/);
  return next === -1 ? src.slice(from) : src.slice(from, from + 1 + next);
}

describe("the worktree has its dependencies before anyone works in it", () => {
  test("the loop installs, rather than asking the agent to remember", () => {
    const body = fn(loop, "workOne");
    const cut = body.indexOf("cutWorktree(");
    const install = body.indexOf("installInto(cut.path");
    const agent = body.indexOf("await p.agent(");
    expect(cut).toBeGreaterThan(-1);
    // After the cut — there is nothing to install into before it — and before
    // the agent, which is the whole point.
    expect(install).toBeGreaterThan(cut);
    expect(agent).toBeGreaterThan(install);
  });

  test("a failed install is not fatal, but the agent is told", () => {
    const body = fn(loop, "workOne");
    expect(body).toContain("installed.ok ? \"\"");
    expect(body).toContain("A missing package is that, not your change");
    // Told by being added to the prompt, not by a log line nobody reads.
    expect(body).toMatch(/brief\([^)]*\) \+ envNote/);
  });

  test("the real installer runs bun install in the worktree", () => {
    const body = fn(index, "runInstallIn");
    /* Resolved to an absolute path now — the packaged app's PATH has no `bun`
       in it, and a missing one arrived as an ENOENT from inside a run. What
       this pins is still that it is an INSTALL, run in the worktree. */
    expect(body).toContain('Bun.spawn([bun, "install"]');
    expect(body).toContain("bunBin()");
    expect(body).toContain("cwd");
    // Both pipes at once: sequential reads deadlock on a full buffer, which is
    // the bug this file's neighbours already record.
    expect(body).toContain("await Promise.all([");
  });

  /*
   * `runInstallIn` sits in the window before the run row exists — see the note
   * beside `INSTALL_TIMEOUT_MS` — so a hang here is invisible to every sweep
   * that only checks for a running row. `runSuiteOnce` already gets the timer
   * treatment for the same reason; this is that same treatment on the install.
   */
  test("the real installer is given the same timeout treatment as the test suite", () => {
    const body = fn(index, "runInstallIn");
    expect(body).toContain("timeoutMs");
    expect(body).toContain("setTimeout(() => {");
    expect(body).toContain("p.kill()");
  });

  test("a timed-out install is reported the way a failed one is", () => {
    const body = fn(loop, "installInto");
    // `installInto` treats whatever the installer hands back uniformly: `ok`
    // decides, not why it is false. A timeout arriving as `{ ok: false, ... }`
    // needs no special case here — it already reads as a failed install.
    expect(body).toContain("r.ok ? \"\" : r.out.slice(-400)");
    expect(body).toMatch(/install\(path, \w+\)/);
  });

  /*
   * BOTH CALL SITES, and this test exists because only one of them had it.
   *
   * `Loop.workOne` (one task, by hand) and `Loop.workUntilDone` (the loop that
   * actually runs the queue) each take their own options object. The install
   * was wired into the first and not the second, so every task the LOOP ran
   * still got a worktree with no packages — and the brief had just stopped
   * telling the agent to install, because the loop was supposed to be doing it.
   * Two runs failed on `node_modules is missing` before anyone counted the
   * call sites.
   */
  test("every route that starts a run hands it in", () => {
    const sites = (index.match(/agent: runAgentIn,/g) ?? []).length;
    const wired = (index.match(/install: runInstallIn,/g) ?? []).length;
    expect(sites).toBeGreaterThan(0);
    expect(wired, `${sites} routes start a run, ${wired} install first`).toBe(sites);
  });

  test("a loop passes it through to every task", () => {
    const body = fn(loop, "workUntilDone");
    expect(body).toContain("install: p.install,");
  });
});

describe("a run's outcome keeps what it said", () => {
  const body = fn(loop, "workOne");

  test("the words come first and the verdict under them", () => {
    const at = body.indexOf("const both = (words: string, tests: string");
    expect(at).toBeGreaterThan(-1);
    const helper = body.slice(at, body.indexOf(";", body.indexOf("verdict(tests")));
    expect(helper.indexOf("verdict(words")).toBeLessThan(helper.indexOf("verdict(tests"));
    expect(helper).toContain("what the tests said");
  });

  test("both endings record both halves", () => {
    /*
     * Read as a property, not as one line of source. This pinned the exact
     * string `both(said.out, checked.out` and broke the day the `done` call
     * grew a second argument and wrapped onto three lines — the two halves
     * were both still there, in that order, which is the whole thing it means
     * to check.
     */
    for (const ending of ["done", "failed"]) {
      /*
       * Every place that ending is recorded AFTER the tests have run. The
       * earliest `failed` is the agent that never finished its turn — there is
       * no test result to record there, because `verify` has not happened yet,
       * and demanding one would be demanding a fact that does not exist.
       */
      const calls: string[] = [];
      /*
       * BOTH ways a run is ended, because there are two now. `finishRun` writes
       * the row; `endedEmptyHanded` writes the same row and additionally puts
       * the task back on the queue, which is what stops an undelivered run from
       * silently taking the task with it. The property being checked here — the
       * outcome carries what the agent said AND what the tests said — is
       * identical either way, so this looks for the ending, not for one spelling
       * of it.
       */
      const starts: number[] = [];
      for (const shape of [`finishRun(runId, "${ending}"`, `endedEmptyHanded(runId, p.item, "${ending}"`]) {
        for (let at = body.indexOf(shape); at > -1; at = body.indexOf(shape, at + 1)) starts.push(at);
      }
      for (const at of starts.sort((a, b) => a - b)) {
        /* To the call's OWN closing paren, by balancing them — not a fixed
           number of characters, which is how a comment added inside a call
           silently changes what a test is looking at. */
        let depth = 0, end = at;
        for (let i = body.indexOf("(", at); i < body.length; i++) {
          if (body[i] === "(") depth++;
          else if (body[i] === ")") { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        calls.push(body.slice(at, end));
      }
      expect(calls.length, `no ${ending} ending`).toBeGreaterThan(0);
      const afterTests = calls.filter((c) => c.includes("both("));
      expect(afterTests.length, `${ending} never goes through both()`).toBeGreaterThan(0);
      for (const call of afterTests) {
        expect(call, `${ending} loses what it said`).toContain("said.out");
        expect(call, `${ending} loses what the tests said`).toContain("checked.out");
      }
    }
  });
});
