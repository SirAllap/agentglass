/*
 * A LOOP THAT STOPS ON EVERY FAILURE IS A LOOP SOMEBODY HAS TO WATCH.
 *
 * Measured over one day: five stops, and not one of them had a single line of
 * work behind it — a pane that never started, a clock that ran out before the
 * first edit, a delegate that never came back. Each left a worktree on disk
 * and a queue standing still until a person noticed and restarted it by hand.
 *
 * "We should not have to be on top of it — that is the essence of a clone, it
 * has to think for itself."
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const loop = readFileSync(new URL("../src/understudy-loop.ts", import.meta.url).pathname, "utf8");
const cli = readFileSync(new URL("../src/agents/claudecode.ts", import.meta.url).pathname, "utf8");

describe("a barren failure is swept, not sat on", () => {
  test("it recognises the failures that left nothing", () => {
    /* Each of these is a run that never reached the work: no commit to
       protect, no half-finished edit, nothing for anybody to read. */
    for (const phrase of ["never became ready", "never landed", "already exists", "left nothing behind"]) {
      expect(loop).toContain(phrase);
    }
    expect(loop).toContain("const barren =");
  });

  test("it deletes the worktree with the same call the button uses", () => {
    /* Nothing is removed here that could not be removed by hand from the
       panel — the sweep is not a second, quieter delete. */
    expect(loop).toContain("await discardRun(res.worktree, item.repo, p.git, res.branch)");
    /* And the branch with it: the name is a hash of the item, so an orphan
       makes every future attempt at the same task fail with "already exists". */
    expect(loop).toContain("res.branch");
  });

  test("and it carries on to the next task", () => {
    const from = loop.indexOf("const barren =");
    expect(loop.slice(from, loop.indexOf("\n      }", from))).toContain("continue;");
  });

  test("but never sweeps a directory a run is still working in", () => {
    /* "already exists" is in the barren list and it is the one message that can
       mean the worktree belongs to a run that is STILL GOING — two loops, the
       same item, the second refused. Sweeping there is `rm -rf` on the first
       one's work while its agent is mid-edit. The HTTP discard route has
       refused exactly this with a 409 since it was written; this caller never
       asked. */
    const from = loop.indexOf("const barren =");
    const block = loop.slice(from, loop.indexOf("\n      }", from));
    expect(block).toContain("runOwning(res.worktree)");
    expect(block).toMatch(/owner\?\.state === "running"/);
  });
});

describe("but it does not sweep forever", () => {
  test("two barren failures in a row still stop it", () => {
    /* Two in a row is not bad luck, it is something broken upstream of the
       work. A loop that keeps cutting worktrees against a broken CLI is worse
       than one that stops and says so. */
    expect(loop).toContain("sweptLast");
    expect(loop).toContain("stopped after two runs in a row that never got started");
  });

  test("a run that DID leave something still stops the loop", () => {
    /* The original reasoning holds for this half: a worktree with half a
       change in it is a state nobody has seen, and starting the next task on
       top of it is how one bad run becomes four. */
    expect(loop).toContain("stopped after a run that did not finish");
  });

  test("the sweep count reaches the summary", () => {
    /* Silently deleting five worktrees and reporting a clean run would be the
       same failure one level up. */
    expect(loop).toContain("swept and carried on");
  });
});

describe("an unattended run has no subagents", () => {
  test("the flag is only for runs nobody is watching", () => {
    /* Two whole shifts produced nothing because the run delegated and then
       waited — "I'll wait for the Explore agent's findings". Delegating is
       good advice for somebody who can see the delegate come back; nobody is
       watching this one. A line in the brief was tried first and did not
       survive the next shift, which is how you learn a rule is not a
       mechanism. */
    expect(cli).toContain('if (spec.unattended) argv.push("--disallowed-tools", "Task");');
  });

  test("an attended chat keeps the tool", () => {
    /* There, a subagent that stalls is a thing he can see and stop. Counted
       rather than pattern-matched: ONE place denies the tool, and it is the
       one guarded by `unattended`. */
    const denies = cli.match(/--disallowed-tools/g) ?? [];
    expect(denies.length).toBe(1);
    expect(cli).toContain('if (spec.unattended) argv.push("--disallowed-tools", "Task");');
  });
});
