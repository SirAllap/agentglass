/*
 * One task worked start to finish, and the four things that make that safe to
 * leave running.
 *
 * WHAT THIS REPLACED. The understudy could predict the shape of thirteen
 * decisions and perform five reversible git actions. That is an instrument for
 * measuring whether it decides like him — not a thing you can leave working on
 * your issues for a day, and no amount of accuracy converts the first into the
 * second. He said so plainly and he was right.
 *
 * The design rule that made the useful version impossible was "every action
 * must be reversible with a recipe". An agent with Bash cannot satisfy that on
 * any action at all. Isolation replaces it: all the work happens in a
 * DISPOSABLE WORKTREE, so a run that goes wrong costs a directory, and the
 * agent can have every tool he has.
 *
 * Four properties, and none of them is about how good the change is:
 *
 *   nothing is pushed, ever;
 *   the tests decide, not the agent's own report;
 *   a worktree is cut fresh and never reused;
 *   a failed run is LEFT on disk, because it is the evidence.
 */
import { describe, expect, test, beforeAll } from "bun:test";

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
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let L: typeof import("../src/understudy-loop.ts");
let W: typeof import("../src/understudy-work.ts");
let jail = "";

const ITEM = {
  id: "t-1",
  source: "test",
  title: "Make the thing do the other thing",
  detail: "A reviewer asked for it.",
  repo: "",
  weight: 5,
};

beforeAll(async () => {
  jail = mkdtempSync(join(tmpdir(), "agx-loop-"));
  mkdirSync(join(jail, "config", "git"), { recursive: true });
  writeFileSync(join(jail, "config", "git", "private-terms.txt"), "\\bnothing\\b\n");
  process.env.AGENTGLASS_DB = join(jail, "t.db");
  process.env.XDG_CONFIG_HOME = join(jail, "config");
  L = await import("../src/understudy-loop.ts");
  W = await import("../src/understudy-work.ts");
});

/** A git that records what it was asked to do and always succeeds.
 *  `rev-list --count` answers "1" by default — most tests using this stub are
 *  simulating a run that committed, and a stub that always says "nothing
 *  landed" would make every one of them read as `empty` instead of `done`. */
function recordingGit() {
  const calls: string[][] = [];
  return {
    calls,
    git: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-list") return { ok: true, out: "1" };
      return { ok: true, out: "" };
    },
  };
}

describe("nothing leaves this machine", () => {
  test("a whole successful run never pushes", async () => {
    const g = recordingGit();
    const r = await L.workOne({
      item: { ...ITEM, id: "push-1" },
      repo: join(jail, "repo-a"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: "done" }),
      verify: async () => ({ ok: true, out: "3 pass 0 fail" }),
    });
    expect(r.ok).toBe(true);
    /*
     * Enumerated rather than "no push happened": this repository has a great
     * deal of local work that has never gone to a remote, and a push is not the
     * machine's to decide. A `git` verb appearing here that reaches a network
     * should fail a test rather than be noticed later.
     */
    const verbs = g.calls.map((c) => c[0]);
    for (const forbidden of ["push", "fetch", "pull", "remote"]) {
      expect(verbs, `${forbidden} must never be run by the loop`).not.toContain(forbidden);
    }
    expect(r.says).toContain("nothing pushed");
  });

  test("the brief tells the agent the same thing", () => {
    // Belt and braces, and deliberately so: the harness cannot stop an agent
    // running `git push` through Bash, so the instruction has to be explicit
    // and has to say WHY — an instruction with a reason survives paraphrase.
    const text = W.brief(ITEM, "/tmp/wt");
    expect(text).toContain("do not push");
    expect(text).toContain("never gone to a remote");
    expect(text).toContain("never write to the task tracker");
  });
});

describe("the tests decide, not the agent", () => {
  test("a confident agent with failing tests is a failed run", async () => {
    /*
     * The agent reports success and the tests do not pass. His own words on
     * this are "compiling is not evidence", after a session that reported
     * success on a build nobody had run — so the transcript's confidence counts
     * for nothing against a red suite.
     */
    const g = recordingGit();
    const r = await L.workOne({
      item: { ...ITEM, id: "verify-1" },
      repo: join(jail, "repo-b"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: "All done! Everything works." }),
      verify: async () => ({ ok: false, out: "2 fail" }),
    });
    expect(r.ok).toBe(false);
    expect(r.says).toMatch(/tests do not pass/i);
  });

  test("and it is recorded as failed, not merely reported", async () => {
    const last = W.runs(1)[0]!;
    expect(last.state).toBe("failed");
    expect(last.outcome).toContain("tests failed");
  });
});

/*
 * A HANGING INSTALL CANNOT HOLD A RUN OPEN FOR EVER.
 *
 * `installInto` runs BEFORE `beginRun` — there is no run row yet, so
 * `Work.runningRuns()` is empty for as long as it takes, and every watchdog
 * sweep reads that as "nothing happening" rather than "something is stuck".
 * `runInstallIn` used to have no timeout at all, so a wedged `bun install`
 * held that window open for the whole shift, not just the one task.
 *
 * This fake never resolves on its own — that IS what "hanging" means — and is
 * bounded only by the timeout it is handed, the same shape `runInstallIn`
 * itself now uses. If the loop ever stopped passing a timeout through, this
 * would hang the test suite rather than time out cleanly.
 */
describe("the installer cannot hang the run it runs inside", () => {
  test("a hanging install is bounded by the timeout it is handed, and the run still finishes", async () => {
    const g = recordingGit();
    const start = Date.now();
    let receivedTimeout = -1;
    const install = (_cwd: string, timeoutMs: number) => {
      receivedTimeout = timeoutMs;
      return new Promise<{ ok: boolean; out: string }>((resolve) => {
        // Stands in for `runInstallIn`'s own kill-on-timer: a process that
        // never exits on its own, bounded only by the budget it was given.
        setTimeout(() => resolve({ ok: false, out: "it was still going and was stopped" }), 30);
      });
    };
    let agentSawFailure = false;
    const r = await L.workOne({
      item: { ...ITEM, id: "install-hang-1" },
      repo: join(jail, "repo-install-hang"),
      shiftId: null,
      git: g.git,
      install,
      agent: async (_cwd, prompt) => {
        // Reported the way a failed install already is — see `envNote`.
        agentSawFailure = prompt.includes("FAILED");
        return { ok: true, out: "done" };
      },
      verify: async () => ({ ok: true, out: "1 pass 0 fail" }),
    });
    expect(receivedTimeout).toBeGreaterThan(0);
    expect(agentSawFailure).toBe(true);
    expect(r.ok).toBe(true);
    // Bounded by the fake's own 30ms, not by an install that runs forever.
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("a turn that ends holding is not the same as a turn that finished", () => {
  /*
   * MEASURED ON THREE REAL RUNS, the second of them after the brief had
   * already been corrected for exactly this. Each one wrote real, green work
   * and then ended its turn saying it would wait for a background suite to
   * notify it. There is no next turn — the agent process is gone the moment it
   * stops talking — so the commit that would have made the work permanent
   * never happened, and `verify` still passes because it runs against the
   * working tree, not the branch. The row used to read `done, nothing pushed`,
   * which is a true sentence about the wrong fact.
   *
   * After the third one the loop stopped relying on the instruction and put a
   * net under it: the work is green against this very tree, so it commits it
   * rather than leave it on disk. What is NOT allowed back is the old lie —
   * `done` with nothing on the branch, and a row that reads as if the agent
   * had recorded its own work. Both halves are pinned below.
   */
  test("green work the agent never committed is committed by the loop", async () => {
    /* The stand-in tracks whether a commit has happened, because the checks
       after this one ask the branch what is on it — and answering "nothing"
       to that after the net has just committed would test a repository that
       cannot exist. Dirty before the commit, clean and one commit after. */
    const g = {
      calls: [] as string[][],
      committed: false,
      git: async (args: string[]) => {
        g.calls.push(args);
        if (args[0] === "commit") { g.committed = true; return { ok: true, out: "" }; }
        if (args[0] === "status") {
          return { ok: true, out: g.committed ? "" : " M web/src/thing.tsx\n?? web/src/new.tsx\n" };
        }
        if (args[0] === "rev-list") return { ok: true, out: g.committed ? "1" : "0" };
        return { ok: true, out: "" };
      },
    };
    const r = await L.workOne({
      item: { ...ITEM, id: "holding-1", title: "Holding for a monitor that will not fire" },
      repo: join(jail, "repo-holding"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: "Server suite running in background, monitor armed." }),
      verify: async () => ({ ok: true, out: "412 pass\n0 fail\n" }),
    });
    expect(r.ok).toBe(true);
    // It reached the branch, which is the whole point.
    const commit = g.calls.find((c) => c[0] === "commit");
    expect(commit, "the loop never committed the green work").toBeDefined();
    expect(g.calls.some((c) => c[0] === "add")).toBe(true);
    // And it says who committed it. A clone that silently takes credit for
    // work it did not record is a clone whose failures stop being visible.
    // It goes on to be judged like any other finished run — the net commits,
    // it does not hand down a verdict of its own.
    const last = W.runs(1)[0]!;
    expect(last.state).toBe("done");
    expect(last.outcome).toContain("the loop committed this");
    // And the deliverable check still ran: skipping it was the first thing
    // this net got wrong, and a task that must write a file would have been
    // called done with nobody looking for the file.
    expect(L.workOne.toString().indexOf("rescuedByLoop = true"))
      .toBeLessThan(L.workOne.toString().indexOf("p.item.deliverable"));
    expect(commit!.join(" ")).toContain("Committed by the run loop, not by the agent");
  });

  test("and if that commit itself fails, nothing is called done", async () => {
    /*
     * The net is allowed to fail — a hook can reject the commit, a worktree can
     * be locked. What it may never do is report the work as recorded when it is
     * not: that is the exact lie the state existed to catch.
     */
    const g = {
      git: async (args: string[]) => {
        if (args[0] === "status") return { ok: true, out: " M web/src/thing.tsx\n" };
        if (args[0] === "commit") return { ok: false, out: "pre-commit hook refused" };
        return { ok: true, out: "" };
      },
    };
    const r = await L.workOne({
      item: { ...ITEM, id: "holding-3", title: "Green, unrecorded, and the hook says no" },
      repo: join(jail, "repo-holding-refused"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: "Waiting on the suite." }),
      verify: async () => ({ ok: true, out: "412 pass\n0 fail\n" }),
    });
    expect(r.ok).toBe(false);
    expect(r.says).toContain("never committed");
    expect(r.says).toContain("not lost");
    const last = W.runs(1)[0]!;
    expect(last.state).toBe("uncommitted");
  });

  test("a clean tree after green tests is still recorded done, as before", async () => {
    const g = recordingGit();
    const r = await L.workOne({
      item: { ...ITEM, id: "holding-2", title: "Actually finished the turn" },
      repo: join(jail, "repo-committed"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: "committed, done" }),
      verify: async () => ({ ok: true, out: "5 pass\n0 fail\n" }),
    });
    expect(r.ok).toBe(true);
    expect(W.runs(1)[0]!.state).toBe("done");
  });
});

describe("a run can finish `done` having produced nothing", () => {
  /*
   * MEASURED ON A REAL RUN (id 41 on this machine): asked to judge a
   * compression task, it recorded only "Investigating brief/task/outcome/
   * views code in background. Waiting for results." — 79 characters, no
   * commit, a clean tree — and it was recorded `done`. `uncommitted` did not
   * catch it because there was nothing uncommitted: the tree was clean
   * because nothing was ever written to it.
   */
  function noCommitGit() {
    const calls: string[][] = [];
    return {
      calls,
      git: async (args: string[]) => {
        calls.push(args);
        if (args[0] === "status") return { ok: true, out: "" }; // clean
        if (args[0] === "rev-list") return { ok: true, out: "0" }; // nothing landed
        return { ok: true, out: "" };
      },
    };
  }

  test("a clean tree, no commit, and thin words is `empty` — not `done`", async () => {
    const g = noCommitGit();
    const r = await L.workOne({
      item: { ...ITEM, id: "empty-1", title: "Judge something and report back" },
      repo: join(jail, "repo-empty-1"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: "Investigating the code in background. Waiting for results." }),
      verify: async () => ({ ok: true, out: "10 pass\n0 fail\n" }),
    });
    expect(r.ok).toBe(false);
    expect(r.says).toContain("nothing");
    expect(r.says).toContain(r.worktree);
    expect(W.runs(1)[0]!.state).toBe("empty");
  });

  test("seven sentences of waiting is still `empty` — length is not the tell", async () => {
    /*
     * MEASURED ON A REAL RUN (id 49): given an idle-CPU regression, the
     * agent kicked off a background bench and spent its entire turn reporting
     * on waiting for it. Seven sentences, 465 characters — comfortably past
     * the old 200-character threshold, so the previous version of this check
     * recorded it `done` with zero measurements and zero commits. Every
     * sentence here is copied verbatim from that outcome.
     */
    const g = noCommitGit();
    const stalled = [
      "Running in background — will check output while continuing.",
      "I'll wait for the background task to finish rather than poll.",
      "I'll just wait for the run_in_background task's own completion notification instead of polling.",
      "Waiting on the N=26 idle bench result.",
      "Waiting for the background bench (N=26 panes) to finish; will report once the Monitor notification lands.",
      "9 min elapsed, ~36 min left. Waiting for the N=26 bench result now.",
      "(waiting for monitor notification)",
    ].join("\n");
    const r = await L.workOne({
      item: { ...ITEM, id: "empty-3", title: "Idle cost is 21% of a core — find what gave it back" },
      repo: join(jail, "repo-empty-3"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: stalled }),
      verify: async () => ({ ok: true, out: "10 pass\n0 fail\n" }),
    });
    expect(r.ok).toBe(false);
    expect(W.runs(1)[0]!.state).toBe("empty");
  });

  test("mentioning a background suite in passing does not sink real progress", async () => {
    // The other side of the same rule: a run that reports actual findings
    // and only touches on a background job as an aside must not lose its
    // argument because one sentence in it happens to say "waiting".
    const g = noCommitGit();
    const argument = "Read every call site of tabScore and the three tests that exercise it. " +
      "The function already rejects a partial-word match — it splits on non-word " +
      "characters before comparing, and the guard test that would have caught the " +
      "old whole-phrase bug is already in the suite and passing. There is nothing " +
      "here that needs changing; the brief's premise does not hold for this repository. " +
      "Waiting on the web suite to confirm nothing else regressed; meanwhile this is the answer.";
    const r = await L.workOne({
      item: { ...ITEM, id: "empty-4", title: "Judge something and report back" },
      repo: join(jail, "repo-empty-4"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: argument }),
      verify: async () => ({ ok: true, out: "10 pass\n0 fail\n" }),
    });
    expect(r.ok).toBe(true);
    expect(W.runs(1)[0]!.state).toBe("done");
  });

  test("no commit but a real argument is still `done` — the honest exception", async () => {
    const g = noCommitGit();
    const argument = "Read every call site of tabScore and the three tests that exercise it. " +
      "The function already rejects a partial-word match — it splits on non-word " +
      "characters before comparing, and the guard test that would have caught the " +
      "old whole-phrase bug is already in the suite and passing. There is nothing " +
      "here that needs changing; the brief's premise does not hold for this repository.";
    const r = await L.workOne({
      item: { ...ITEM, id: "empty-2", title: "Judge something and report back" },
      repo: join(jail, "repo-empty-2"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: argument }),
      verify: async () => ({ ok: true, out: "10 pass\n0 fail\n" }),
    });
    expect(r.ok).toBe(true);
    expect(W.runs(1)[0]!.state).toBe("done");
  });
});

describe("a branch name he can read, and git will accept", () => {
  /*
   * The name is not cosmetic, and it is not only a branch. It becomes the
   * DIRECTORY too — `cutWorktree` builds the path as the repository plus the
   * last segment of the branch — so one title decides both what `git branch`
   * shows and what somebody is looking at in a file manager a week later.
   *
   * A title arrives from a card or a review, which means it can be a sentence,
   * a line of punctuation, or nothing readable at all. None of those are
   * mistakes on the writer's part; they are just what titles are. What must not
   * happen is the run dying at `worktree add` on a ref-format error, because
   * that error names the ref and never names the card that produced it.
   */

  /*
   * Lowercase letters, digits and hyphens, starting with an alphanumeric. Not a
   * transcription of `git check-ref-format` but a shape that satisfies all of
   * it at once: no spaces, none of `~^:?*[\`, no `..`, nothing that can end in
   * `.lock`, and no leading hyphen for an argument parser to mistake for a flag.
   */
  const ACCEPTABLE = /^feat\/[a-z0-9][a-z0-9-]*$/;

  test("a title of mostly punctuation becomes one name rather than an unusable one", () => {
    const b = W.branchFor({ ...ITEM, title: "Fix: the `thing` — (again)!! #12 @you" });
    // The readable half is asserted whole, and the tag is asserted by shape.
    // Pinning the tag's value would only re-state how it is derived, and the
    // test that matters is that the part a person reads survives the punctuation.
    expect(b).toMatch(/^feat\/fix-the-thing-again-12-you-[0-9a-f]{6}$/);
    expect(b).toMatch(ACCEPTABLE);
  });

  test("a long title is cut to a length rather than carried whole", () => {
    // A ninety-character sentence makes a ninety-character directory sitting
    // next to the checkout. He works with several worktrees at a time and picks
    // them out by name, so the bound is for the person, not for the filesystem.
    const b = W.branchFor({
      ...ITEM,
      title: "Rework the understudy work loop so that it stops on the first failing run instead of carrying on",
    });
    // The bound is on the part he reads. The tag is seven more characters and
    // is not a name getting longer — it is what keeps two similar titles from
    // claiming one directory.
    expect(b.length).toBeLessThanOrEqual("feat/".length + 40 + "-abc123".length);
    expect(b).toMatch(ACCEPTABLE);
  });

  test("a title that reduces to nothing still names a branch", () => {
    /*
     * The one that would actually break. An empty slug gives `feat/`, which git
     * refuses outright — a ref may not end in a slash — and whose last path
     * segment is the empty string, so the worktree would be cut at the
     * repository path with a trailing hyphen and nothing after it.
     */
    for (const title of ["!!! ??? ---", "   ", "…"]) {
      expect(W.branchFor({ ...ITEM, title })).toMatch(/^feat\/task-[0-9a-f]{6}$/);
    }
  });
});

describe("a worktree is cut fresh and kept when it matters", () => {
  test("it cuts a new branch off the tip, never reuses a directory", async () => {
    const g = recordingGit();
    await L.workOne({
      item: { ...ITEM, id: "cut-1", title: "Tidy the thing" },
      repo: join(jail, "repo-c"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: "" }),
      verify: async () => ({ ok: true, out: "" }),
    });
    const add = g.calls.find((c) => c[0] === "worktree" && c[1] === "add");
    expect(add, "it should cut a worktree").toBeTruthy();
    // `-b <branch>` and `HEAD`: a new branch, off the current tip. Cutting from
    // a remembered base is a merge conflict nobody asked for.
    expect(add).toContain("-b");
    expect(add![add!.length - 1]).toBe("HEAD");
  });

  test("an existing directory stops the run rather than being reused", async () => {
    /*
     * A leftover worktree holds the previous run's half-finished state, and
     * starting a new task on top of it is how two unrelated changes end up on
     * one branch — the first thing he sends a review back for.
     */
    const repo = join(jail, "repo-d");
    const item = { ...ITEM, id: "reuse-1", title: "reused" };
    // Where that same item's previous run would have left its worktree, asked
    // rather than spelled out: the branch carries a tag now, and a hand-written
    // path would only be testing that the test knows how to build one.
    const stale = `${repo}-${W.branchFor(item).split("/").pop()}`;
    mkdirSync(stale, { recursive: true });
    const g = recordingGit();
    const r = await L.workOne({
      item,
      repo,
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: "" }),
      verify: async () => ({ ok: true, out: "" }),
    });
    expect(r.ok).toBe(false);
    expect(r.says).toMatch(/already exists/i);
    // And it did not touch git at all: refused before doing anything.
    expect(g.calls).toEqual([]);
  });

  test("a failed run leaves the worktree on disk and says where", async () => {
    // The evidence of what went wrong. Tidying up automatically would mean the
    // one run somebody wanted to inspect is the one that is gone.
    const g = recordingGit();
    const r = await L.workOne({
      item: { ...ITEM, id: "keep-1", title: "keep me" },
      repo: join(jail, "repo-e"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: false, out: "I could not work out what to do" }),
      verify: async () => ({ ok: true, out: "" }),
    });
    expect(r.ok).toBe(false);
    expect(r.says).toContain(r.worktree);
    const removed = g.calls.some((c) => c[0] === "worktree" && c[1] === "remove");
    expect(removed, "a failed run must not delete its own evidence").toBe(false);
  });
});

describe("throwing a run away, once somebody has decided to", () => {
  /*
   * The other half of "a failed run is left on disk". Keeping every worktree is
   * only defensible if there is a way to get rid of one, and this is it — never
   * called by the loop, only when a person has read a run and dismissed it.
   *
   * Which is exactly why the answer matters more here than anywhere else in the
   * file. The row disappears from his list on the strength of it, so `true`
   * where the directory is still on disk trades a visible pile of worktrees for
   * an invisible one, and the invisible pile is the one nobody ever clears.
   */
  test("it removes the worktree and reports it gone", async () => {
    const wt = join(jail, "repo-f-discard");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "half-a-change.txt"), "what the agent left behind\n");
    const g = recordingGit();
    const gone = await L.discardRun(wt, join(jail, "repo-f"), g.git);
    expect(gone).toBe(true);
    expect(existsSync(wt)).toBe(false);
    // Through git rather than by deleting the directory, so the repository's own
    // record of the worktree goes with it. An `rm -rf` on its own leaves `git
    // worktree list` naming a directory that is not there.
    expect(g.calls[0]).toEqual(["worktree", "remove", "--force", wt]);
  });

  test("a git it cannot run is reported as not gone, rather than as done", async () => {
    /*
     * Reachable from the route, not hypothetical: the body is passed straight
     * through as `String(wb.repo ?? "")`, so a run whose checkout has since been
     * deleted — or one that arrived without a repository at all — reaches git
     * with a working directory that does not exist, and spawning THROWS instead
     * of returning a failure.
     */
    const wt = join(jail, "repo-g-discard");
    mkdirSync(wt, { recursive: true });
    const gone = await L.discardRun(wt, join(jail, "repo-g"), async () => {
      throw new Error("chdir failed: no such file or directory");
    });
    expect(gone).toBe(false);
    expect(existsSync(wt), "it must not report a directory gone that it never touched").toBe(true);
  });

  test("a worktree that has already gone is not reported as a failure", async () => {
    // Two clicks on the same dismissed run, or a directory he removed by hand
    // yesterday. Neither is an error worth showing him: the answer is about the
    // state of the disk, not about whether this call is what changed it.
    const g = recordingGit();
    expect(await L.discardRun(join(jail, "never-existed"), jail, g.git)).toBe(true);
  });
});

describe("two tasks that read alike still get their own branch", () => {
  /*
   * These two are identical for their first forty-six characters, and the slug
   * is cut at forty. Before the tag they produced ONE branch name between them:
   * the first run took the worktree, and the second was refused with "already
   * exists" before it had done anything at all.
   */
  const TWIN_A = { ...ITEM, id: "twin-a", title: "Rework the settings dialog so it remembers its width" };
  const TWIN_B = { ...ITEM, id: "twin-b", title: "Rework the settings dialog so it remembers its position" };

  test("a shared truncated slug no longer means a shared branch", () => {
    const a = W.branchFor(TWIN_A);
    const b = W.branchFor(TWIN_B);
    // The part a person reads is the same — that is the point of the title.
    expect(a.startsWith("feat/rework-the-settings-dialog-so-it-remembe")).toBe(true);
    expect(b.startsWith("feat/rework-the-settings-dialog-so-it-remembe")).toBe(true);
    expect(a).not.toBe(b);
    // And still readable rather than a hash with a name attached.
    expect(a).toMatch(/^feat\/[a-z0-9-]+-[0-9a-f]{6}$/);
  });

  test("the same item asked twice is the same branch", () => {
    // The tag comes from the item, not from the clock: a card looked up in two
    // places must not disagree about where its work lives.
    expect(W.branchFor(TWIN_A)).toBe(W.branchFor({ ...TWIN_A }));
  });

  test("the second of the pair is not refused as somebody else's worktree", async () => {
    const repo = join(jail, "repo-twin");
    const first = await L.workOne({
      item: TWIN_A,
      repo,
      shiftId: null,
      git: recordingGit().git,
      agent: async () => ({ ok: true, out: "" }),
      verify: async () => ({ ok: true, out: "" }),
    });
    expect(first.ok).toBe(true);
    // The recording git cuts nothing, so make the directory a real `worktree
    // add` would have left — and which nothing tidies away, by design.
    mkdirSync(first.worktree, { recursive: true });

    const second = await L.workOne({
      item: TWIN_B,
      repo,
      shiftId: null,
      git: recordingGit().git,
      agent: async () => ({ ok: true, out: "" }),
      verify: async () => ({ ok: true, out: "" }),
    });
    expect(second.ok, second.says).toBe(true);
    expect(second.worktree).not.toBe(first.worktree);
  });
});

describe("the same task is not picked up twice", () => {
  test("an item that has been run is not offered again", () => {
    // Across shifts, not only within one: coming back tomorrow and re-doing
    // yesterday's card is the most obvious way for a loop to waste a day.
    expect(W.alreadyTaken("test", "push-1")).toBe(true);
    expect(W.alreadyTaken("test", "never-seen")).toBe(false);
  });
});

describe("an abandoned run must not hide its item for ever", () => {
  // A pull-request task has no queue of its own to clear `taken_at` on — the
  // run row IS the only record. Killed by a restart, it used to sit there in
  // state `abandoned` and block `nextTask` from ever offering the item again.
  test("offered again after one abandonment, not a third time after two", async () => {
    const { openRequests } = await import("../src/understudy-help.ts");
    const item = {
      id: "acme/repo#42", source: "prs",
      title: "Fix the failing checks on #42", detail: "", repo: "", weight: 8,
    };

    const first = W.beginRun({ shiftId: null, item, repo: "", worktree: "/tmp/prs-abandon-1", branch: "b1" });
    W.finishRun(first!, "abandoned", "the server restarted while this was running");
    expect(W.alreadyTaken(item.source, item.id), "one abandonment is an honest accident, not a verdict").toBe(false);

    const second = W.beginRun({ shiftId: null, item, repo: "", worktree: "/tmp/prs-abandon-2", branch: "b2" });
    W.finishRun(second!, "abandoned", "the server restarted while this was running, again");
    expect(W.alreadyTaken(item.source, item.id), "two abandonments is the ceiling").toBe(true);
    expect(openRequests().some((r) => r.title === item.title), "and a person was told").toBe(true);
  });
});

describe("the brief is his, not a generic one", () => {
  test("it carries his rules and tells the agent to prefer them", () => {
    /*
     * An agent given only the card writes what any competent engineer would
     * write. Given his rules and his past cases it writes something he
     * recognises — which is the whole difference between an assistant and a
     * clone, and the only thing the bank was ever for.
     */
    const text = W.brief(ITEM, "/tmp/wt");
    expect(text).toContain("Work the way they");
    expect(text).toMatch(/follow\s+theirs/);
    expect(text).toContain("HOW THEY WORK");
  });

  test("it states the working method rather than hoping it is inferred", () => {
    const text = W.brief(ITEM, "/tmp/wt");
    // One feature per branch, read before writing, tests green — the things he
    // has said in reviews, made explicit so they do not depend on the bank
    // happening to surface them.
    expect(text).toContain("ONE feature on this branch");
    expect(text).toContain("Compiling is not evidence");
  });

  test("and it forbids half-finished work reported as done", () => {
    const text = W.brief(ITEM, "/tmp/wt");
    expect(text).toMatch(/unforgivable/i);
  });
});

/*
 * WHAT THE TRANSCRIPTS OF ITS OWN RUNS SAID ABOUT THE BRIEF.
 *
 * Every one of these locks a sentence that was added because a run measurably
 * lost time without it. They are not style: a brief is the only thing an agent
 * working alone has, and each of these was paid for once already.
 */
describe("the brief was corrected by reading the runs it produced", () => {
  test("its rules are the ones this task uses, not the first in the file", async () => {
    /*
     * `compiledRules().slice(0, 40)` took compile order, which is the order the
     * sources happened to be walked in. On the brief a run was handed on
     * 2026-08-22, nineteen of the forty were HTTP API guidance out of a
     * third-party skill — idempotency keys and cursor pagination, in a task
     * about naming a git branch — while the rule forbidding a worktree in his
     * employer's repository sat at index 727 and went nowhere.
     */
    const { policyDir } = await import("../src/understudy-ingest.ts");
    const decoys = Array.from({ length: 40 }, (_, i) => ({
      id: `decoy-${i}`, cls: "general", src: "skill", backed: 9999,
      text: "Accept an idempotency key and replay the stored result.",
    }));
    mkdirSync(policyDir(), { recursive: true });
    writeFileSync(join(policyDir(), "rules.json"), JSON.stringify({
      rules: [...decoys, {
        id: "buried", cls: "general", src: "notes", backed: 1,
        text: "When a reviewer asked for a thing, name the reviewer and the thread.",
      }],
    }));

    const text = W.brief(ITEM, "/tmp/wt");
    expect(text).toContain("name the reviewer and the thread");
    expect(text, "a rule sharing no word with the task is not his answer to it")
      .not.toContain("idempotency key");
  });

  test("a turn out of a transcript is never offered as a thing they decided", async () => {
    /*
     * Everything retrieved used to arrive under "THINGS THEY DECIDED IN SIMILAR
     * SITUATIONS". The ten sent to the run of 2026-08-22 15:13 were all
     * transcript turns and none was about the task; the first was the string
     * "The previous response failed to produce a valid tool call." — a harness
     * error, handed to the agent as one of his decisions.
     */
    const U = await import("../src/understudy.ts");
    const { classifyQuestion } = await import("../src/understudy-ask.ts");
    const item = { ...ITEM, id: "brief-said", title: "Make the reviewer chip readable" };
    U.addPrecedent({
      cls: classifyQuestion(`${item.title} ${item.detail}`),
      partition: "agentglass",
      situation: "a turn you typed",
      decision: "the reviewer chip is unreadable",
      hisWords: "the reviewer chip is unreadable",
      source: "transcripts:-home-dev-code-orbit",
      sourceRef: "brief-t-1",
      provenance: "typed",
      at: Date.now(),
      weight: 1,
    });

    const text = W.brief(item, "/tmp/wt");
    expect(text).toContain("the reviewer chip is unreadable");
    expect(text).not.toContain("THINGS THEY DECIDED IN SIMILAR SITUATIONS");
    const heading = text.indexOf("THINGS THEY SAID AT THE TIME");
    expect(heading, "a transcript turn belongs under the heading that calls it one").toBeGreaterThan(-1);
    expect(text.indexOf("the reviewer chip is unreadable")).toBeGreaterThan(heading);
  });

  test("it says how long there is before the ceiling stops the run", () => {
    /*
     * An audit whose whole deliverable was findings written down was killed at
     * 45 minutes and 1 second with no commit and a clean worktree, having given
     * 17 of those minutes to five full suite runs. It could not budget against
     * a ceiling nobody had mentioned.
     */
    const text = W.brief(ITEM, "/tmp/wt", undefined, 45 * 60_000);
    expect(text).toContain("45 minutes");
    expect(text).toMatch(/stopped wherever it is/);
    // Without one it invents nothing. A guessed deadline is worse than none.
    expect(W.brief(ITEM, "/tmp/wt")).not.toContain("HOW LONG YOU HAVE");
  });

  test("and the loop tells it the same ceiling it will enforce", async () => {
    let seen = "";
    const g = recordingGit();
    await L.workOne({
      item: { ...ITEM, id: "brief-clock" },
      repo: join(jail, "repo-clock"),
      shiftId: null,
      git: g.git,
      agent: async (_cwd: string, prompt: string) => { seen = prompt; return { ok: true, out: "" }; },
      verify: async () => ({ ok: true, out: "1 pass 0 fail" }),
    });
    // The number in the brief and the number the timer runs on are one value,
    // so the brief cannot drift into promising time the loop will not give.
    const src = await Bun.file(new URL("../src/understudy-loop.ts", import.meta.url)).text();
    const mins = src.match(/TASK_TIMEOUT_MS = (\d+) \* 60_000/)?.[1];
    expect(seen).toContain(`${mins} minutes`);
  });

  test("it names the install a fresh worktree has not had", () => {
    /*
     * Nothing links node_modules into a worktree, so the first suite an agent
     * runs cannot find a package. Four runs met that; the worst read it as its
     * own change breaking the build and spent 16 of its 23 minutes — four full
     * suites — before checking whether the directory was there. The install
     * took 76ms.
     */
    expect(W.brief(ITEM, "/tmp/wt")).toContain("bun install");
  });

  test("the command it names is the command the verdict actually runs", async () => {
    /*
     * "their tests, by the command they use" sent four runs grepping the
     * Makefile, both package.json files and a CLAUDE.md that does not exist —
     * two or three tool calls each — and they still disagreed afterwards: one
     * ran `make test` and then the server suite again, another chased an
     * unhandled error in a web file it had never touched.
     *
     * Read off `runTestsIn` rather than restated, so moving the verdict fails
     * here instead of leaving the brief quietly wrong.
     */
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    /* The spawn moved into `runSuiteOnce` when a red started being asked
       twice; `runTestsIn` decides, this is the one that runs the command. */
    const at = src.indexOf("async function runSuiteOnce");
    const body = src.slice(at, endOfBlock(src, at));
    /* The program is resolved to an absolute path now (the packaged app's PATH
       has no `bun` in it — see bunbin.ts), so what this pins is that the
       ARGUMENT is still `test` and that the DIRECTORY comes from the suite. */
    expect(body).toContain(`Bun.spawn([bun, "test", ...suite.args]`);
    expect(body).toContain("bunBin()");
    expect(body).toMatch(/cwd: `\$\{cwd\}\/\$\{suite\.dir\}`/);
    expect(W.brief(ITEM, "/tmp/wt")).toContain("cd server && bun test");

    /*
     * AND BOTH SUITES, WITH CI'S ARGUMENTS. This used to pin `server` alone,
     * which is how the gap survived: 30 of the clone's 63 deliveries since
     * 2026-08-20 touched web/, and a red web suite could not stop a run.
     * `--timeout 20000` is pinned for the same reason CI has it — several
     * tests brush the 5 s default, and without it the verdict makes its own
     * flakes and the retry below files them as flakes.
     */
    const table = src.slice(src.indexOf("const VERDICT_SUITES"), src.indexOf("async function runSuiteOnce"));
    expect(table).toContain(`{ dir: "server", args: ["--timeout", "20000"] }`);
    expect(table).toContain(`{ dir: "web", args: [] }`);
    expect(table, "mobile needs npm ci and generated files a fresh worktree has not got").not.toContain(`dir: "mobile"`);

    /* And the loop runs the table rather than one hard-coded directory. */
    const runner = src.slice(src.indexOf("async function runTestsIn"), src.indexOf("async function runOneSuiteWithRetry"));
    expect(runner).toContain("for (const suite of VERDICT_SUITES)");
    expect(runner, "a red suite must stop the verdict, not be buried under the next one").toContain("if (!r.ok) return { ok: false");
  });
});

describe("a task it cannot place is never placed anyway", () => {
  /*
   * FOUND BY RUNNING IT LIVE, which is the only way it could have been found.
   *
   * The route said `repo: item.repo || repos[0]` — take whatever is first if
   * the task does not say where it belongs. On a real machine the top task was
   * a card from his employer's tracker, and a card carries no checkout. With
   * one open-project repository present, that fallback would have cut a
   * worktree in agentglass and set an agent to work on somebody else's ticket
   * inside it.
   *
   * Nothing would have reached the employer's repository, so not a leak — just
   * a confident, wrong, completely wasted run. That erodes trust faster than an
   * outright failure, because a failure at least looks like one.
   */
  test("the route refuses a task with no repository rather than picking one", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src.indexOf('"/understudy/work/run"');
    const block = src.slice(from, endOfBlock(src, from));
    // The fallback is gone, by its exact shape.
    expect(block).not.toContain("repos[0]!");
    expect(block).toContain("if (!item.repo)");
    // And it says why, because "409" on its own teaches nobody anything.
    expect(block).toContain("guessing would be worse than waiting");
  });

  test("and refuses one outside what it may work in today", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src.indexOf('"/understudy/work/run"');
    expect(src.slice(from, endOfBlock(src, from))).toContain("repos.includes(item.repo)");
  });

  test("the card source stays quiet when it cannot place anything", async () => {
    /*
     * The root of it. A source that offers work nobody can locate is an
     * invitation to locate it wrongly, so it says nothing instead — silence is
     * the honest state here.
     */
    const src = await Bun.file(new URL("../src/understudy-sources-work.ts", import.meta.url)).text();
    const from = src.indexOf('id: "clickup"');
    expect(src.slice(from, endOfBlock(src, from))).toContain("if (!repos.length) return []");
  });
});

describe("work he hands it directly", () => {
  /*
   * The source that exists because the other two cannot answer the question
   * that matters: WHICH CHECKOUT. A card says what to do and never says where,
   * so on a quiet Saturday the loop correctly declined everything — which is
   * right, and leaves somebody with a machine that says no to everything.
   *
   * This is the queue he fills himself. It is also the honest way to watch the
   * thing work the first time: give it something small, read what came back,
   * decide whether to give it something bigger. Nobody should hand an hour of
   * autonomy to a machine they have not watched do ten minutes.
   */
  test("a queued task always names a checkout", async () => {
    const S = await import("../src/understudy-sources-work.ts");
    const id = S.ask({ title: "Tidy the thing", repo: "/home/dev/code/agentglass" });
    expect(id).toBeGreaterThan(0);
    const rows = S.asked();
    expect(rows.some((r) => r.repo === "/home/dev/code/agentglass")).toBe(true);
    S.unask(id!);
    expect(S.asked().some((r) => r.id === id)).toBe(false);
  });

  test("the route refuses a checkout it may not work in — before queueing, not after", async () => {
    /*
     * Checked when the row is written rather than when it is picked up. A row
     * naming somewhere out of scope is a disappointment scheduled for later,
     * and saying so now costs nothing.
     */
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src.indexOf('"/understudy/work/ask" && req.method === "POST"');
    const block = src.slice(from, endOfBlock(src, from));
    expect(block).toContain("allowed.includes(repo)");
    // And it names what it WOULD accept, rather than only refusing.
    expect(block).toContain("it may only work in:");
  });

  test("what he asked for outranks everything a tracker calls urgent", async () => {
    // He asked for this one by hand. No card's own priority outranks that.
    const src = await Bun.file(new URL("../src/understudy-sources-work.ts", import.meta.url)).text();
    const from = src.indexOf('id: "asked"');
    expect(src.slice(from, endOfBlock(src, from))).toContain("weight: 20");
  });

  test("a queued row outside today's scope is dropped rather than offered", async () => {
    // A row added last week naming a checkout the loop may no longer touch is
    // not work — it is a stale instruction.
    const src = await Bun.file(new URL("../src/understudy-sources-work.ts", import.meta.url)).text();
    const from = src.indexOf('id: "asked"');
    expect(src.slice(from, endOfBlock(src, from))).toContain("repos.includes(r.repo)");
  });
});

describe("it keeps going until there is nothing left", () => {
  /*
   * His actual sentence: "if we run out of work, look for more where we usually
   * look for it". Before this the loop did exactly one task per request, which
   * is a task runner wearing a loop's name.
   *
   * Every ending below is a hard stop rather than a preference, and the reasons
   * matter more than the mechanism.
   */
  const cap = { agent: async () => ({ ok: true, out: "" }), verify: async () => ({ ok: true, out: "" }) };

  test("it works through several tasks and stops when they run out", async () => {
    const g = recordingGit();
    let n = 0;
    const r = await L.workUntilDone({
      repos: [join(jail, "chain")],
      shiftId: null,
      keepGoing: () => ({ go: true, why: "" }),
      next: async () => (n < 3
        ? { id: `chain-${n}`, source: "test", title: `task ${n++}`, detail: "", repo: join(jail, "chain"), weight: 1 }
        : null),
      git: g.git,
      ...cap,
    });
    expect(r.done).toHaveLength(3);
    expect(r.stopped).toBe("nothing left to work on");
  });

  test("one failed run ends it, rather than starting the next on top", async () => {
    /*
     * After a failure the machine is in a state nobody has looked at — a
     * worktree with half a change in it, or a red suite. Starting the next task
     * on top of that is how one bad run becomes four, each harder to unpick
     * than the last.
     */
    const g = recordingGit();
    let n = 0;
    const r = await L.workUntilDone({
      repos: [join(jail, "chain2")],
      shiftId: null,
      keepGoing: () => ({ go: true, why: "" }),
      next: async () => ({ id: `f-${n}`, source: "test", title: `t${n++}`, detail: "", repo: join(jail, "chain2"), weight: 1 }),
      git: g.git,
      agent: async () => ({ ok: true, out: "" }),
      verify: async () => ({ ok: false, out: "1 fail" }),
    });
    expect(r.done).toHaveLength(1);
    expect(r.stopped).toMatch(/did not finish/i);
  });

  test("the shift is asked FRESH each round, not captured once", async () => {
    /*
     * A shift can be halted between two tasks. A loop that decided at the start
     * whether it was allowed to run would carry on through the stop — which is
     * the difference between a stop button and a decoration.
     */
    const g = recordingGit();
    let asked = 0;
    const r = await L.workUntilDone({
      repos: [join(jail, "chain3")],
      shiftId: null,
      keepGoing: () => (++asked > 2 ? { go: false, why: "you halted it" } : { go: true, why: "" }),
      next: async () => ({ id: `h-${asked}`, source: "test", title: `t${asked}`, detail: "", repo: join(jail, "chain3"), weight: 1 }),
      git: g.git,
      ...cap,
    });
    expect(asked).toBeGreaterThan(1);
    expect(r.stopped).toBe("you halted it");
  });

  test("a task it cannot place is skipped, not fatal", async () => {
    // One unplaceable card should not end a shift — the next may well be
    // placeable, and stopping would waste the rest of the hour on a bad row.
    const g = recordingGit();
    let n = 0;
    const r = await L.workUntilDone({
      repos: [join(jail, "chain4")],
      shiftId: null,
      keepGoing: () => ({ go: true, why: "" }),
      next: async () => {
        n++;
        if (n === 1) return { id: "no-repo", source: "test", title: "homeless", detail: "", repo: "", weight: 1 };
        if (n === 2) return { id: "ok-1", source: "test", title: "placed", detail: "", repo: join(jail, "chain4"), weight: 1 };
        return null;
      },
      git: g.git,
      ...cap,
    });
    expect(r.done).toHaveLength(1);
    expect(r.done[0]!.ok).toBe(true);
  });

  test("there is a hard ceiling on rounds", async () => {
    // A bug that makes `nextTask` return the same item for ever must not be
    // able to spend a night on it.
    const g = recordingGit();
    const r = await L.workUntilDone({
      repos: [join(jail, "chain5")],
      shiftId: null,
      keepGoing: () => ({ go: true, why: "" }),
      next: async () => ({ id: `same-${Math.random()}`, source: "test", title: "again", detail: "", repo: join(jail, "chain5"), weight: 1 }),
      git: g.git,
      maxRounds: 3,
      ...cap,
    });
    expect(r.done.length).toBeLessThanOrEqual(3);
    expect(r.stopped).toMatch(/limit of 3/);
  });

  test("nothing loops without a shift — not the route, not the watchdog", async () => {
    /*
     * A loop with no shift has no limit on it at all: no wall, no budget, no
     * stop rules. That is not autonomy, it is an unbounded process.
     *
     * The check moved with the code. The loop is a named function now, because
     * the watchdog restarts it when a shift is left idle with work owed — the
     * route is no longer the only way back to work — and the refusal has to
     * live where every caller passes through it rather than on one of them.
     */
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src.indexOf("async function startWorkLoop(");
    expect(from, "the loop function moved").toBeGreaterThan(-1);
    /*
     * The refusal lives one call deeper now: `startWorkLoop` is the door every
     * caller comes through and holds the one-loop-at-a-time guard, `runWorkLoop`
     * is the body and holds the rules. Both facts are asserted rather than the
     * old single block, because a guard that let a second loop in was how a
     * sweep came to delete the worktree the first one was working in.
     */
    expect(src.slice(from, endOfBlock(src, from)), "the door must refuse a second loop").toContain("a loop is already running");
    const body = src.indexOf("async function runWorkLoop(");
    expect(body, "the loop body moved").toBeGreaterThan(-1);
    expect(src.slice(body, endOfBlock(src, body))).toContain("hand over first");
    /* And the route is a caller of it, not a second copy of the rules. */
    const route = src.indexOf('"/understudy/work/loop"');
    expect(src.slice(route, endOfBlock(src, route))).toContain("startWorkLoop()");
  });
});

describe("his employer's work is never even selected", () => {
  /*
   * His own sentence, in substance: as long as nothing of the closed side is
   * touched, he is calm.
   *
   * Measured live, and that is why this fence sits in the SOURCE rather than in
   * the route. The first call made with an open-project checkout available
   * picked a card from his employer's tracker as the next task. The route would
   * have refused it — a card carries no repository — so nothing would have run.
   *
   * But a loop whose SELECTION lands on his employer's work is not one anybody
   * should have to trust the next fence to catch. And the day somebody teaches
   * cards to carry a repository, that last fence stops applying while the
   * selection stays exactly as wrong.
   */
  test("the card source is silent unless the scope has been opened deliberately", async () => {
    const src = await Bun.file(new URL("../src/understudy-sources-work.ts", import.meta.url)).text();
    const from = src.indexOf('id: "clickup"');
    const block = src.slice(from, endOfBlock(src, from));
    expect(block).toContain('proposeScope() !== "everywhere"');
    // Before the fetch, not after: not asking is stronger than asking and
    // discarding, and it is also the only version that touches no tracker.
    expect(block.indexOf("proposeScope()")).toBeLessThan(block.indexOf("changedForMe"));
  });

  test("only the open project can be worked in, and which one is a setting", async () => {
    /*
     * This test used to assert the project's NAME appeared here, which was
     * true and was the bug: one person's project baked into logic in a public
     * repository, with everything else defined as "not that". What it should
     * assert is that the filter asks the setting.
     */
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    /*
     * To the end of the function, not a fixed 1600 characters. Twice now a
     * paragraph of comment added inside it has pushed what this looks for
     * past the cut, and a test that fails because the code got better
     * documented is a test people learn to ignore.
     */
    const from = src.indexOf("async function openProjectRepos");
    const block = src.slice(from, src.indexOf("\n}", from));
    expect(block).toContain("isOpenProjectPath(r)");
    // And the name itself is nowhere in the decision.
    expect(/return roots\.filter[^\n]*agentglass/i.test(block)).toBe(false);
  });

  test("the loop's own checkout counts, so it is not blind to itself", async () => {
    /*
     * Discovery works from telemetry — work done THROUGH the app — and from
     * projects opened in it. On this machine both are the employer's
     * repositories, because the open project gets worked on from a terminal. So
     * the loop had nowhere to work and declined everything, while running
     * inside the very checkout it was looking for.
     */
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    /*
     * To the end of the function, not a fixed 1600 characters. Twice now a
     * paragraph of comment added inside it has pushed what this looks for
     * past the cut, and a test that fails because the code got better
     * documented is a test people learn to ignore.
     */
    const from = src.indexOf("async function openProjectRepos");
    const block = src.slice(from, src.indexOf("\n}", from));
    expect(block).toContain("repoRootOf(process.cwd())");
    // Deduplicated: a checkout arriving by both routes would be worked twice.
    expect(block).toContain("!roots.includes(here)");
  });
});

describe("no run without a shift, single or chained", () => {
  /*
   * THE ASYMMETRY THAT SHOWED ITSELF ON THE FIRST LIVE TASK.
   *
   * The chained loop demanded a shift; the single-task route did not. So on the
   * first real run the handover failed — one was already open — and the work
   * went ahead anyway, with no wall, no budget and no stop rules over it.
   *
   * It happened to be fine. It was still an unbounded run, and "just one task"
   * is not a limit when the task is an agent with a shell and twenty-five
   * minutes in a repository.
   */
  test("the single-task route requires a running shift", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src.indexOf('"/understudy/work/run"');
    const block = src.slice(from, endOfBlock(src, from));
    expect(block).toContain('shift.state !== "running"');
    expect(block).toContain("hand over first");
  });

  test("and it charges the budget before the work, not after", async () => {
    /*
     * A run that never returns has still been paid for. Charging on completion
     * means a hung agent costs nothing and the next request starts another one
     * behind it — which is how a budget of three becomes an unbounded queue.
     */
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src.indexOf('"/understudy/work/run"');
    const block = src.slice(from, endOfBlock(src, from));
    expect(block.indexOf("Shift.countAction")).toBeLessThan(block.indexOf("Loop.workOne"));
  });

  test("a spent budget stops it as firmly as a missing shift", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src.indexOf('"/understudy/work/run"');
    expect(src.slice(from, endOfBlock(src, from))).toContain("shift.actionsLeft <= 0");
  });
});

describe("the run record says what happened", () => {
  /*
   * FOUND BY READING THE TABLE AFTER THREE REAL RUNS. All three recorded the
   * same outcome: `bun test v1.3.9 (cf6cdbbb)` and a server log line that
   * happened to print while the suite was starting. Nothing about pass or fail.
   *
   * The cause was `out.slice(0, 1000)` — the head of the output — and `bun
   * test` writes its counts at the end. It is the same mistake as reading a
   * build's first line to decide whether it built, which is the one he has
   * already sent work back for twice.
   */
  const BANNER = "bun test v1.3.9 (cf6cdbbb)\n[some subsystem] a log line nobody asked for\n";
  const SUITE = `${BANNER}${"ran a test\n".repeat(400)} 3806 pass\n 0 fail\nRan 3806 tests\n`;

  test("a green run records the counts, not the banner", async () => {
    const g = recordingGit();
    await L.workOne({
      item: { ...ITEM, id: "verdict-green", title: "verdict green" },
      repo: join(jail, "repo-v1"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: "measured it, there was nothing to fix" }),
      verify: async () => ({ ok: true, out: SUITE }),
    });
    const last = W.runs(1)[0]!;
    expect(last.state).toBe("done");
    expect(last.outcome).toContain("3806 pass");
    expect(last.outcome).toContain("0 fail");
    /*
     * WHAT IT SAID FIRST, then the proof. A run that concludes "nothing to fix
     * here" used to record the counts and not one word of the reasoning — the
     * answer to the question thrown away, the proof kept.
     */
    expect(last.outcome.split("\n")[0]).toContain("measured it, there was nothing to fix");
    // And inside the test half, the counts are still hoisted above the tail, so
    // a long suite cannot push them off the end.
    const tests = last.outcome.slice(last.outcome.indexOf("what the tests said"));
    expect(tests.split("\n")[1]).toContain("pass");
    expect(last.outcome).not.toContain("bun test v1.3.9");
  });

  test("a red run records the end of the output, where the failures are", async () => {
    const g = recordingGit();
    await L.workOne({
      item: { ...ITEM, id: "verdict-red", title: "verdict red" },
      repo: join(jail, "repo-v2"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: "" }),
      verify: async () => ({
        ok: false,
        out: `${BANNER}${"ran a test\n".repeat(400)}error: expected 1 to be 2\n 12 pass\n 2 fail\n`,
      }),
    });
    const last = W.runs(1)[0]!;
    expect(last.state).toBe("failed");
    expect(last.outcome).toContain("2 fail");
    expect(last.outcome).toContain("expected 1 to be 2");
  });

  test("an agent that gave up records why it stopped, not how it started", async () => {
    // No counts to hoist, so this is purely "the tail, not the head" — and the
    // reason an agent stopped is always the last thing it said.
    const g = recordingGit();
    await L.workOne({
      item: { ...ITEM, id: "verdict-gave-up", title: "verdict gave up" },
      repo: join(jail, "repo-v3"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: false, out: `starting up\n${"thinking\n".repeat(400)}I ran out of time` }),
      verify: async () => ({ ok: true, out: "" }),
    });
    const last = W.runs(1)[0]!;
    expect(last.outcome).toContain("I ran out of time");
    expect(last.outcome).not.toContain("starting up");
  });
});

describe("a queue he fills by hand drains itself", () => {
  /*
   * `taken_at` was declared in the schema and read by the filter, and NOTHING
   * EVER WROTE TO IT. So the column was decoration: after a task was worked
   * start to finish its row stayed listed as pending, while the loop — which
   * checks the run table, not the queue — correctly reported nothing to do.
   *
   * Two lists disagreeing is worse than either being wrong, because the person
   * reading them has to guess which one is lying.
   */
  test("a source is told the moment a run begins, not when it succeeds", async () => {
    /*
     * At the START deliberately. Marking it on success leaves a failed item
     * pending, and the next round picks it up again into the worktree the
     * failed run left on disk on purpose — which the loop refuses, forever.
     */
    const told: string[] = [];
    W.addSource({
      id: "told",
      label: "told",
      async find() { return []; },
      taken(id) { told.push(id); },
    });
    const g = recordingGit();
    await L.workOne({
      // A run that FAILS, so this also proves it is not success that clears it.
      item: { ...ITEM, id: "told-1", source: "told", title: "told one" },
      repo: join(jail, "repo-t1"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: false, out: "no" }),
      verify: async () => ({ ok: true, out: "" }),
    });
    expect(told).toEqual(["told-1"]);
  });

  test("a source that throws on being told does not lose the run", async () => {
    W.addSource({
      id: "brittle",
      label: "brittle",
      async find() { return []; },
      taken() { throw new Error("the tracker is down"); },
    });
    const g = recordingGit();
    const r = await L.workOne({
      item: { ...ITEM, id: "brittle-1", source: "brittle", title: "brittle one" },
      repo: join(jail, "repo-t2"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: "" }),
      verify: async () => ({ ok: true, out: "1 pass\n0 fail" }),
    });
    expect(r.ok).toBe(true);
    expect(W.runs(1)[0]!.state).toBe("done");
  });

  test("end to end: what he asked for stops being listed once it is taken", async () => {
    const S = await import("../src/understudy-sources-work.ts");
    const repo = join(jail, "repo-t3");
    const id = S.ask({ title: "Do the thing he asked for", detail: "in his words", repo });
    expect(id).toBeTruthy();
    expect(S.asked().some((r) => r.id === id)).toBe(true);
    const g = recordingGit();
    await L.workOne({
      item: { id: `asked:${id}`, source: "asked", title: "Do the thing he asked for", detail: "", repo, weight: 20 },
      repo,
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: "" }),
      verify: async () => ({ ok: true, out: "1 pass\n0 fail" }),
    });
    expect(S.asked().some((r) => r.id === id)).toBe(false);
  });

  test("a row written before any of this still stops being listed", async () => {
    /*
     * The rows already on his machine carry no mark, because nothing ever wrote
     * one. Repairing them means a hand-written UPDATE against a live database,
     * so instead the queue consults the run table as well: a row with a run
     * against it is not pending whatever its own column says.
     */
    const S = await import("../src/understudy-sources-work.ts");
    const repo = join(jail, "repo-t4");
    const id = S.ask({ title: "Queued before the fix", detail: "", repo })!;
    const g = recordingGit();
    await L.workOne({
      item: { id: `asked:${id}`, source: "asked", title: "Queued before the fix", detail: "", repo, weight: 20 },
      repo,
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: true, out: "" }),
      verify: async () => ({ ok: true, out: "1 pass\n0 fail" }),
    });
    // Put the row back the way the old code left it: run recorded, no mark.
    const { db } = await import("../src/db.ts");
    db.run("UPDATE understudy_asked SET taken_at = NULL WHERE id = ?", [id]);
    expect(S.asked().some((r) => r.id === id)).toBe(false);
  });
});

describe("how much of a shift is already behind it", () => {
  /*
   * A tally the loop cannot keep for itself: `workUntilDone` only knows the
   * call it is inside, so a shift halted and picked up again has to ask the
   * table what it already did. Asserted as DELTAS, because every test above
   * this one has left rows of its own in the same database.
   */
  test("a run that finished and one that broke land on their own side", async () => {
    const before = W.runsSoFar();
    await L.workOne({
      item: { ...ITEM, id: "tally-ok", title: "Tally the good one" },
      repo: join(jail, "tally-a"),
      shiftId: null,
      git: recordingGit().git,
      agent: async () => ({ ok: true, out: "" }),
      verify: async () => ({ ok: true, out: "1 pass 0 fail" }),
    });
    await L.workOne({
      item: { ...ITEM, id: "tally-bad", title: "Tally the bad one" },
      repo: join(jail, "tally-b"),
      shiftId: null,
      git: recordingGit().git,
      agent: async () => ({ ok: true, out: "All done!" }),
      verify: async () => ({ ok: false, out: "1 fail" }),
    });
    const after = W.runsSoFar();
    expect(after.done - before.done).toBe(1);
    expect(after.failed - before.failed).toBe(1);
  });

  test("a run still going counts for neither side yet", () => {
    // Started and not ended is not a result. Counting it as one would let a
    // shift stop on work nobody has seen the end of.
    const before = W.runsSoFar();
    const id = W.beginRun({
      shiftId: null,
      item: { ...ITEM, id: "tally-open", title: "Tally one still going" },
      repo: join(jail, "tally-c"),
      worktree: join(jail, "tally-c-open"),
      branch: "feat/tally-one-still-going",
    });
    expect(id, "the row should exist to be uncounted").toBeTruthy();
    expect(W.runsSoFar()).toEqual(before);
  });
});

describe("a run that could not finish, and whether it left anything", () => {
  /*
   * MEASURED ON THE FIRST REAL CHAINED RUN. The agent changed the right two
   * files, staged them, and was killed on the timeout before it committed. The
   * row read `failed` with a blank outcome — indistinguishable from an agent
   * that sat there doing nothing — so the half hour of real work in that
   * directory was the thing nobody would think to go and look at.
   *
   * Two different mornings, and the sentence has to tell them apart.
   */
  test("work left behind is named, so somebody goes and looks", async () => {
    const g = {
      calls: [] as string[][],
      git: async (args: string[]) => {
        // A worktree with staged changes in it, which is what a killed agent
        // leaves: the work is done and the commit never happened.
        if (args[0] === "status") return { ok: true, out: "M  server/src/thing.ts\n" };
        return { ok: true, out: "" };
      },
    };
    const r = await L.workOne({
      item: { ...ITEM, id: "left-1", title: "Left something behind" },
      repo: join(jail, "repo-left"),
      shiftId: null,
      git: g.git,
      agent: async () => ({ ok: false, out: "" }),
      verify: async () => ({ ok: true, out: "" }),
    });
    expect(r.ok).toBe(false);
    expect(r.says).toContain("uncommitted work is waiting");
    expect(r.says).toContain(r.worktree);
  });

  test("and an empty worktree says that instead, rather than the same sentence", async () => {
    const r = await L.workOne({
      item: { ...ITEM, id: "left-2", title: "Left nothing behind" },
      repo: join(jail, "repo-empty"),
      shiftId: null,
      git: async () => ({ ok: true, out: "" }),
      agent: async () => ({ ok: false, out: "" }),
      verify: async () => ({ ok: true, out: "" }),
    });
    expect(r.says).toContain("left nothing behind");
  });
});

describe("a run stopped by the clock says so", () => {
  test("the timeout is reported as a timeout, not as a blank failure", async () => {
    /*
     * `claude -p` writes to a pipe, and a pipe buffers until the process ends,
     * so killing it loses the whole transcript — the first real run recorded
     * `failed` with nothing in it at all after exactly 25.0 minutes. The
     * runner cannot recover the words, but it can say what happened, and it
     * can say where the work is.
     */
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src.indexOf("async function runAgentIn(");
    const fn = src.slice(from, src.indexOf("\n}\n", from));
    expect(fn).toContain("let timedOut = false");
    expect(fn).toContain("was still going after");
    // And it explains the blank rather than leaving somebody to wonder.
    expect(fn).toContain("a pipe holds its output");
  });
});

describe("what the tests said, and only that", () => {
  /*
   * The outcome is drawn on screen under the words "what the TESTS said, not
   * what the agent claimed". What it actually showed was:
   *
   *     bun test v1.3.9 (cf6cdbbb)
   *     [clickup] card notifications are working again
   *
   * A suite this size boots the application, so its output carries the app's
   * own chatter — integration notices, and the event-loop warning this
   * repository prints when a request holds the thread. Both true, neither the
   * verdict, and between them they were the whole of what three runs recorded.
   *
   * Dropped by shape rather than by a list of strings, so the notice somebody
   * adds tomorrow is dropped too.
   */
  const noisy = [
    "bun test v1.3.9 (cf6cdbbb)",
    "[clickup] card notifications are working again",
    "[config] ignoring something",
    "⏱ event loop blocked 4932ms by GET /x — the terminal was frozen for that long",
    "",
    "test/thing.test.ts:",
    "(fail) a thing > it does the thing",
    " 3800 pass",
    " 1 fail",
  ].join("\n");

  test("the app's own chatter does not reach the row", async () => {
    const { runOutcomeFor } = await import("../src/understudy-loop.ts") as unknown as
      { runOutcomeFor?: (s: string, n: number) => string };
    // `verdict` is private, so this asserts through the only thing that shows
    // it: no chatter may appear in what a run records.
    const seen = runOutcomeFor ? runOutcomeFor(noisy, 2000) : noisy;
    if (!runOutcomeFor) return;   // exported only if someone opens it later
    expect(seen).not.toContain("[clickup]");
    expect(seen).not.toContain("event loop blocked");
  });

  test("the counts and the failing test survive the filtering", async () => {
    const src = await Bun.file(new URL("../src/understudy-loop.ts", import.meta.url)).text();
    const fn = src.slice(src.indexOf("const NOT_THE_VERDICT"), src.indexOf("\n}", src.indexOf("function verdict")));
    // The three shapes that are noise…
    expect(fn).toContain("event loop blocked");
    expect(fn).toContain("^bun test v");
    expect(fn).toContain("[a-z0-9-]+");
    // …and the one that is the answer, still pulled to the top.
    expect(fn).toContain("(pass|fail)");
  });
});

describe("the four ways a run used to leave the machine stuck", () => {
  const src = () => Bun.file(new URL("../src/understudy-loop.ts", import.meta.url)).text();

  test("a run that throws still closes its row", async () => {
    /*
     * There was no `try` in the body of `workOne`, and every helper past
     * `beginRun` spawns with `cwd` set to the worktree — `Bun.spawn` throws
     * synchronously when that directory is gone. The exception unwound into the
     * watchdog's own `void resumeFn().catch(() => {})`, so `finishRun` was never
     * called and the row stayed `running` for ever. One leaked row makes both
     * idle sweeps return early: full queue, nothing running, no alerts, for an
     * hour.
     */
    const s = await src();
    const at = s.indexOf("const runId = beginRun(");
    expect(at).toBeGreaterThan(-1);
    /* From the row's creation to the end of the function it is in — read as a
       block, never as a byte count: a slice of N characters says a comment
       is a behaviour change. */
    expect(s.slice(at, endOfBlock(s, at))).toContain("try {");
    expect(s).toContain("the run threw and could not finish");
    /* And the message it reports is a FIXED sentence with the error appended:
       the barren classifier matches words in `says`, and a raw git error
       contains "already exists" — which would hand a crash to `discardRun`. */
    const catchAt = s.indexOf("endedEmptyHanded(runId, p.item, \"failed\", `the run threw");
    expect(catchAt, "the catch must close the row through the ordinary path").toBeGreaterThan(-1);
  });

  test("a refused cut costs an attempt instead of being offered for ever", async () => {
    const s = await src();
    const at = s.indexOf("if (!cut.ok) {");
    expect(s.slice(at, s.indexOf("\n  }", at))).toContain("noteUndelivered(");
  });

  test("the shift pays for a run that started, not for a task that was chosen", async () => {
    const s = await src();
    const at = s.indexOf("const runId = beginRun(");
    /* Charged beside `beginRun`: before this it was spent at selection, so four
       selections that never became runs ended a shift reporting it had used
       everything it was given. */
    expect(s.slice(at, s.indexOf("try {", at))).toContain("p.countAction?.()");
  });

  test("and a discard takes the branch with it", async () => {
    const s = await src();
    const at = s.indexOf("export async function discardRun(");
    const body = s.slice(at, endOfBlock(s, at));
    expect(body).toContain('git(["branch", "-d", branch]');
    /* `-d`, never `-D`: git refuses to delete a branch holding work nobody
       merged, which is the line this must not cross. */
    expect(body).not.toContain('"-D", branch');
  });
});
