/*
 * A run that waits on an agent which is no longer there.
 *
 * `runAgentInPane` polled for the exit-code file and nothing else, so the only
 * thing that could end a wait early was the agent finishing. An agent that DIED
 * — its window killed, tmux restarted, the shell inside it gone — writes no rc
 * file, and the loop sat on it for the whole forty-five minute budget before
 * recording a timeout.
 *
 * Measured, not imagined: run 18 spent thirty-five minutes recorded as
 * "running" with no matching process anywhere on the machine, no window on the
 * engine socket and not one file touched in its worktree. Nothing would have
 * said so until the clock ran out, and the shift's own rule — one failure ends
 * it — means those minutes are the whole queue standing still.
 *
 * Three properties, and the third is the one that is easy to get wrong.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/index.ts", import.meta.url).pathname, "utf8");

/*
 * The body of `runAgentInPane`, bounded by the next top-level declaration
 * rather than a character count — a paragraph added inside it must not move
 * what this can see. See no-fixed-source-slices.test.ts.
 *
 * Not `indexOf("\n}")`: this function takes an object parameter written over
 * twenty lines, so the first brace at column zero closes the PARAMETER, and a
 * body bounded by it is empty. Which is what happened writing this.
 */
function runAgentInPaneBody(): string {
  const from = src.indexOf("async function runAgentInPane(p: {");
  expect(from).toBeGreaterThan(-1);
  const next = src.slice(from + 1).search(/\n(?:async )?function [A-Za-z]/);
  expect(next).toBeGreaterThan(-1);
  return src.slice(from, from + 1 + next);
}

describe("the wait ends when the agent dies, not when the clock does", () => {
  const body = runAgentInPaneBody();

  test("the window is asked about while waiting", () => {
    expect(body).toContain("await leaseHeld(win.windowId)");
  });

  test("liveness is asked on its own interval, not every poll", () => {
    expect(body).toContain("AGENT_LIVENESS_MS");
    expect(src).toMatch(/const AGENT_LIVENESS_MS = [\d_]+;/);
  });

  /*
   * THE ORDERING, which is the whole correctness of this.
   *
   * A run that finishes normally writes rc and THEN its window closes, and
   * those two are not simultaneous. Land the liveness check in that gap and a
   * perfectly good run is reported as a death — with its answer sitting on disk
   * unread. So the rc file is re-checked after the window comes back gone, and
   * before anything is called dead.
   */
  test("a gone window re-checks the exit code before calling it a death", () => {
    const at = body.indexOf("await leaseHeld(win.windowId)");
    const after = body.slice(at);
    const recheck = after.indexOf("fsExists(rcPath)");
    const declares = after.indexOf("died = true");
    expect(recheck).toBeGreaterThan(-1);
    expect(declares).toBeGreaterThan(recheck);
  });

  test("the death is reported as one, and carries the transcript with it", () => {
    expect(body).toContain("its window is gone");
    // Not an empty string and not a bare sentence: whatever the agent got
    // through before it went is the only evidence of why.
    const at = body.indexOf("its window is gone");
    expect(body.slice(body.lastIndexOf("return", at), at)).toContain("${out}");
  });

  test("running out of time is still its own, different ending", () => {
    expect(body).toContain("it ran out of time and was stopped");
  });
});

/*
 * Why a run stopped, said in a way somebody can act on.
 *
 * "It ran out of time" and "it ran out of time and had written nothing for
 * forty of those minutes" are different reports, and only the second one tells
 * you where to look. The silence never decides anything — an agent thinking
 * between tool calls writes nothing for minutes and is working perfectly — it
 * only rides along with whatever ending the run gets.
 */
describe("an ending says how long the agent had been quiet", () => {
  const body = runAgentInPaneBody();

  test("transcript growth is watched on the same interval as liveness", () => {
    expect(body).toContain("Bun.file(outPath).size");
    expect(body).toMatch(/if \(size !== lastSize\) \{ lastSize = size; lastGrew = Date\.now\(\); \}/);
  });

  test("silence under a minute is not worth saying", () => {
    expect(body).toMatch(/silentFor >= 60 \?/);
    expect(body).toMatch(/: ""/);
  });

  test("both bad endings carry it", () => {
    const timeout = body.slice(body.indexOf("it ran out of time and was stopped"));
    expect(timeout.slice(0, 80)).toContain("${silence}");
    const death = body.slice(body.indexOf("its window is gone"));
    expect(death.slice(0, 120)).toContain("${silence}");
  });
});

/*
 * The screen, when the transcript has nothing.
 *
 * Run 18 produced three events in forty-five minutes and timed out, and the
 * outcome could say nothing about why — the transcript was the only thing read
 * and the transcript was empty. Whatever the agent was really doing was on the
 * screen of its own window, and nobody looked.
 */
describe("a bad ending brings back what was on screen", () => {
  const body = runAgentInPaneBody();

  test("both bad endings capture the pane", () => {
    expect(body).toContain("paneTail(win.windowId)");
    expect((body.match(/paneTail\(win\.windowId\)/g) ?? []).length).toBe(2);
  });

  test("a run that finished does not", () => {
    // The success return is the one that reads the exit code. It must not be
    // dragging a screenshot of a finished agent along with the answer.
    const ok = body.slice(body.indexOf("const code = Number.parseInt"));
    expect(ok).not.toContain("paneTail");
  });

  test("the timeout captures before the window is closed", () => {
    // `finally` calls endLease, which kills it. A capture after that is empty.
    const capture = body.indexOf("const screen = await paneTail");
    const fin = body.indexOf("} finally {");
    expect(capture).toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(capture);
  });

  test("it keeps the tail, not the whole scrollback", () => {
    const fn = src.slice(src.indexOf("async function paneTail"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toMatch(/slice\(-\d+\)/);
  });
});
