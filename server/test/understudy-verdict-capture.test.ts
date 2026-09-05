/*
 * The verdict has to survive the pipe it comes out of.
 *
 * "The tests decide, not the agent" is the property the whole work loop rests
 * on, and the tab prints the stored outcome under exactly those words. For
 * three real runs what it stored was this, in full:
 *
 *     bun test v1.3.9 (…)
 *     [clickup] card notifications are working again
 *
 * No pass, no fail, no failing test named. The runner read stdout, and `bun
 * test` writes its verdict to STDERR — so the evidence was thrown away at the
 * point of capture, not lost later.
 *
 * These are two separate claims, and the first is about bun rather than about
 * this application: it is asserted here so that the day it changes, the test
 * that tells us is the one next to the code that depends on it.
 */
import { describe, expect, test } from "bun:test";

/**
 * The end of the declaration that starts at `from`, for tests that read shape.
 *
 * Bounding a source slice by a character count is the thing that broke five
 * tests in one afternoon: every time, somebody had added a paragraph of
 * comment inside the function and pushed the assertion past the cut. A test
 * that fails because the code got better documented is one people delete.
 */
function endOfBlock(text: string, from: number): number {
  const close = text.indexOf("\n}", from);
  return close === -1 ? text.length : close;
}
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("where a test runner puts its verdict", () => {
  test("bun writes the counts to stderr, not to stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-verdict-"));
    writeFileSync(join(dir, "x.test.ts"),
      'import { expect, test } from "bun:test";\ntest("one", () => { expect(1).toBe(1); });\n');

    const p = Bun.spawn(["bun", "test", "x.test.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    await p.exited;

    // The claim that made the outcome empty. If this ever flips, the runner
    // below is reading the wrong stream again and this test says so first.
    expect(err, "the counts live on stderr").toMatch(/\d+ pass/);
    expect(out, "stdout carries the banner and little else").not.toMatch(/\d+ pass/);
  });
});

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

describe("so the runner reads both, at the same time", () => {
  const block = (name: string) => {
    const from = src.indexOf(`async function ${name}(`);
    expect(from, `${name} should exist`).toBeGreaterThan(-1);
    // To the end of the function. A fixed window silently starts covering the
    // next function once anything is inserted, and then asserts about it.
    const close = src.indexOf("\n}\n", from);
    return src.slice(from, close === -1 ? from + 4000 : close);
  };

  test("the test runner keeps the stream the verdict is on", () => {
    /* `runSuiteOnce`, not `runTestsIn`: one red is now asked again before it
       stops the queue, so `runTestsIn` decides and `runSuiteOnce` is the one
       that actually spawns. The property is unchanged and lives there. */
    const b = block("runSuiteOnce");
    expect(b).toContain("new Response(p.stderr).text()");
  });

  test("the agent runner keeps the stream a crash is on", () => {
    // With stderr discarded, a run that died — bad credential, missing CLI,
    // a crash — recorded a failure with an empty reason. That is the one row
    // somebody goes looking for.
    const b = block("runAgentIn");
    expect(b).not.toContain('stderr: "ignore"');
    expect(b).toContain("new Response(p.stderr).text()");
  });

  test("both read the two pipes concurrently, because sequential can hang", () => {
    /*
     * Not a style point. An unread pipe fills; a process blocked writing to a
     * full stderr never exits; `await p.exited` then waits for a program that
     * is waiting for us, until the timeout kills a run that had already
     * finished its work. A suite of several thousand tests writes far more
     * than a pipe buffer holds, so this is the normal case, not the edge.
     */
    for (const name of ["runSuiteOnce", "runAgentIn"]) {
      const b = block(name);
      const at = b.indexOf("Promise.all([");
      expect(at, `${name} must read both streams together`).toBeGreaterThan(-1);
      /*
       * Bounded inside `b`, by the Promise.all's own closing bracket.
       *
       * This said `endOfBlock(src, at)` — and `at` is an index into `b`, not
       * into `src`. Two strings, one offset: it happened to point somewhere
       * plausible and stopped doing so the moment the function grew. A fixed
       * `at + 200` before that had the same failure by a different route.
       */
      const inside = b.slice(at, b.indexOf("])", at));
      expect(inside).toContain("p.stdout");
      expect(inside).toContain("p.stderr");
    }
  });
});
