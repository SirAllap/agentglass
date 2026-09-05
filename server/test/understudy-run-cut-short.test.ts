/*
 * A run that ends without finishing has to say what happened.
 *
 * MEASURED, on a real run: the understudy worked for thirty minutes, produced
 * 782KB of transcript, and stopped in the middle of a sentence. Its row said
 * `running` — for ever, because the server it was running under was gone — and
 * its outcome was empty.
 *
 * The reason had been in the stream the whole time: a `rate_limit_event`
 * saying the five-hour window had no credit left. The formatter dropped it,
 * the outcome never looked for it, and nothing on the screen could tell that
 * apart from an agent that sat there doing nothing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const watchPy = await Bun.file(new URL("../../scripts/understudy-watch.py", import.meta.url)).text();

describe("stopped by a usage limit", () => {
  test("the outcome names the limit and when it lifts", () => {
    const fn = src.slice(src.indexOf("function finalWords("), src.indexOf("\n}", src.indexOf("function finalWords(")));
    expect(fn).toContain("rate_limit_event");
    expect(fn).toContain("resetsAt");
    expect(fn).toContain("stopped by the");
  });

  test("a run with no closing message says that, rather than trailing raw json", () => {
    // Without a `result` event there is nothing to quote, and a tail of JSON
    // answers nothing. The sentence is the answer.
    const fn = src.slice(src.indexOf("function finalWords("), src.indexOf("\n}", src.indexOf("function finalWords(")));
    expect(fn).toContain("it stopped before finishing");
  });

  test("the counter shows it too, since that is where somebody is looking", () => {
    expect(watchPy).toContain('if kind == "rate_limit_event":');
    expect(watchPy).toContain("limit reached");
  });
});

describe("a run nobody is left to finish", () => {
  test("runs still marked running at startup are abandoned", async () => {
    const work = await Bun.file(new URL("../src/understudy-work.ts", import.meta.url)).text();
    expect(work).toContain("export function abandonOrphanedRuns()");
    // `abandoned`, not `failed`: those are different facts. Failed means the
    // work was judged; abandoned means nobody was left to judge it.
    const fn = work.slice(work.indexOf("export function abandonOrphanedRuns("),
      work.indexOf("\n}", work.indexOf("export function abandonOrphanedRuns(")));
    expect(fn).toContain('"abandoned"');
    expect(fn).not.toContain('"failed"');
  });

  test("and the sweep runs at startup, where it can be sure", () => {
    // Anything `running` when this process starts predates it by definition.
    // Through `recoverAfterRestart`, which calls the sweep AND puts each task
    // back on the queue: closing the run row was never the hard part, and six
    // measured restarts each left behind a task nothing would ever offer again.
    expect(src).toContain("recoverAfterRestart()");
    const wd = readFileSync(new URL("../src/understudy-watchdog.ts", import.meta.url), "utf8");
    expect(wd).toContain("Work.abandonOrphanedRuns()");
  });

  test("nothing deletes the worktree on the way", () => {
    /*
     * Whatever it managed is still in that directory — thirty minutes of it,
     * in the case that prompted this — and keeping the evidence of a run that
     * did not finish is the reason worktrees are not tidied away.
     */
    const work = src.slice(src.indexOf("const recovered = recoverAfterRestart()"), src.length);
    expect(work.slice(0, 400)).not.toContain("worktree");
    const wd = readFileSync(new URL("../src/understudy-watchdog.ts", import.meta.url), "utf8");
    expect(wd).not.toContain("rmSync");
  });
});
