/*
 * A RUN THAT OWES A FILE HAS TO WRITE IT.
 *
 * Everything else in the loop judges a run by its commit and its tests, and
 * both of those are blind to a run that writes a REPORT. A study, a design, an
 * audit legitimately leaves the repository untouched — so a clean tree is the
 * expected outcome there, not evidence of anything, and a green suite is green
 * precisely because nothing changed.
 *
 * Measured: the task-provider design run spawned two subagents, sat waiting on
 * notifications that never came, wrote no file, and recorded itself `done`.
 * Nothing in the loop could have caught it, because nothing was asking.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const loop = readFileSync(new URL("../src/understudy-loop.ts", import.meta.url).pathname, "utf8");
const types = readFileSync(new URL("../../shared/types.ts", import.meta.url).pathname, "utf8");
const db = readFileSync(new URL("../src/db.ts", import.meta.url).pathname, "utf8");
const source = readFileSync(new URL("../src/understudy-sources-work.ts", import.meta.url).pathname, "utf8");

describe("a task can name the file it owes", () => {
  test("the column exists and is nullable — most tasks owe a commit instead", () => {
    expect(db).toContain("ALTER TABLE understudy_asked ADD COLUMN deliverable TEXT");
  });

  test("the queue carries it through to the work item", () => {
    expect(source).toContain("deliverable: r.deliverable || undefined");
    expect(types).toMatch(/deliverable\?: string;/);
  });
});

describe("and the loop checks it before saying done", () => {
  /* The check has to sit AFTER the tests and BEFORE the `done`, or it is
     either judging a run that has not finished or not judging it at all. */
  test("it runs between the suite and the verdict", () => {
    const check = loop.indexOf("if (p.item.deliverable)");
    const done = loop.indexOf('finishRun(runId, "done"');
    expect(check).toBeGreaterThan(-1);
    expect(done).toBeGreaterThan(check);
  });

  test("existence is not enough — it must have been written by THIS run", () => {
    /* Existence alone passes on a file left by an earlier attempt, which is
       the exact case this is for: the second run of a task whose first run
       half-finished. So the mtime is compared against a stamp taken before
       the worktree was even cut. */
    expect(loop).toContain("st.mtimeMs >= startedAt");
    expect(loop).toContain("const startedAt = Date.now();");
    const stamp = loop.indexOf("const startedAt = Date.now();");
    const cut = loop.indexOf("const cut = await cutWorktree(");
    expect(stamp).toBeLessThan(cut);
  });

  test("a missing deliverable lands on `empty`, not on a failure", () => {
    /* `empty` is the state that already means "it finished and left nothing",
       and this is the same fact arriving by a different road. A new state
       would be a second word for one situation. */
    const from = loop.indexOf("if (p.item.deliverable)");
    const block = loop.slice(from, from + 1200);
    /* Through `endedEmptyHanded`, which finishes the run as `empty` AND puts
       the task back so it is not silently lost — the state this asserts is the
       one that goes in the row, and it is named right here in the call. */
    expect(block).toMatch(/end(edEmptyHanded|Run)\([^)]*"empty"/);
    expect(block).toContain("ok: false");
  });

  test("it says which file and whether it was stale or absent", () => {
    /* "it did not deliver" sends somebody looking. Naming the path, and
       saying whether the file is missing or merely older than the run, is the
       difference between a report and a search. */
    expect(loop).toContain("${p.item.deliverable} is ${existsSync(owed)");
    expect(loop).toContain('"older than this run"');
    expect(loop).toContain('"not there"');
  });

  test("a leading ~ is expanded — the queue is filled by hand", () => {
    expect(loop).toContain("homedir()");
    expect(loop).toMatch(/replace\(\/\^~\(\?=/);
  });
});
