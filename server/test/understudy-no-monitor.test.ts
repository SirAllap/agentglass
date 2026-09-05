/*
 * The tool a stalled run always reached for, taken off the table.
 *
 * Six runs on this machine spent a turn "waiting for the Monitor notification"
 * from a job they had backgrounded — in a one-shot `-p` process where the turn
 * that runs is the only turn there is, so nothing was ever coming back to read
 * it. `understudy-loop.test.ts` now catches the run that stalls anyway, but
 * that is the check noticing a promise already broken. This is the promise
 * never being offered: `runAgentIn` launches with `Monitor` disallowed, so an
 * agent that backgrounds a job has no honest way to say it will hear back.
 */
import { describe, expect, test } from "bun:test";

describe("the work loop's own agent cannot wait on a notification that never arrives", () => {
  test("Monitor is disallowed on the one-shot launch", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src.indexOf("async function runAgentIn(");
    const close = src.indexOf("\n}\n", from);
    const block = src.slice(from, close === -1 ? from + 4000 : close);
    expect(block).toContain("--disallowedTools");
    expect(block).toContain("Monitor");
    // Bash stays: the run still needs git and the test suite.
    expect(block).not.toContain('"Bash"');
  });
});
