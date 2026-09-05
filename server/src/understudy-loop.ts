/*
 * One task, start to finish, without anybody watching.
 *
 * This is the part that makes the word "clone" mean something: take a card or a
 * pull request, cut a worktree, put an agent in it with every tool the person
 * has, wait, check the result, and leave a branch for them to look at.
 *
 * ISOLATION IS THE SAFETY PROPERTY, and it is the only one that survives giving
 * an agent Bash. Nothing here tries to make the agent's individual actions
 * reversible — it cannot be done and attempting it is what kept this feature
 * useless for a week. The worktree is disposable, so a run that goes wrong
 * costs a directory. That is the whole argument, and everything else in this
 * file follows from it:
 *
 *   the worktree is CUT FRESH for each task, off the tip, never reused;
 *   the agent's cwd is that worktree and nothing above it;
 *   a failed run leaves the worktree in place, because a person will want to
 *   look at what it did before it is thrown away;
 *   nothing is pushed, ever. This repository has a great deal of local work
 *   that has never gone to a remote, and pushing is not the machine's to
 *   decide.
 *
 * WHAT VERIFIES IT. Not the scorecard — that measures whether it guesses the
 * shape of his answers, which says nothing about whether a change is any good.
 * The check here is the one he uses himself: do his tests pass. A run whose
 * tests fail is reported as failed however confident the agent sounded, because
 * "it said it was finished" is not evidence and he has said so in those words.
 */
import { rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { brief, beginRun, branchFor, finishRun, runOwning, holdUntil, heldUntil, resetTimeFrom, type WorkItem } from "./understudy-work.ts";
import { seedFrom } from "./gitwork.ts";
import { seedSummary } from "./worktreeseed.ts";
import { noteUndelivered } from "./understudy-watchdog.ts";

/**
 * End a run that delivered nothing, and make sure the TASK does not vanish
 * with it.
 *
 * `finishRun` alone was the quiet failure: the run row was honest — failed,
 * empty, uncommitted — and the queued task stayed marked taken, so nothing
 * would ever offer it again. Measured over 108 runs, 26 ended this way and not
 * one of them said what it needed. Going through the watchdog gives the task
 * one more go, and turns the second failure into a question addressed to a
 * person instead of a row nobody reads.
 */
function endedEmptyHanded(
  runId: number | null, item: WorkItem,
  state: "failed" | "empty" | "uncommitted", outcome: string,
): void {
  if (runId) finishRun(runId, state, outcome);
  noteUndelivered({ itemId: item.id, title: item.title, state, why: outcome.slice(0, 400), runId });
}


/*
 * How long one task may take before it is abandoned.
 *
 * RAISED FROM 25 MINUTES BECAUSE 25 WAS NOT ENOUGH, and that is measured
 * rather than guessed. Of the four real tasks the understudy has been given,
 * three finished in 17.4, 20.1 and 27.6 minutes — the last already over the
 * limit for the agent's own share of it — and the fourth was killed at exactly
 * 25.0 with the right two files changed and staged, a commit away from done.
 *
 * A ceiling that ends most of its work just before the finish is worse than no
 * ceiling: it spends the whole cost and throws away the result. The shift is
 * what bounds a session — how long, how many tasks, stop on failure — and this
 * only exists so one wedged agent cannot hold a shift open for ever.
 */
const TASK_TIMEOUT_MS = 45 * 60_000;

/** How long the verification command gets. */
const VERIFY_TIMEOUT_MS = 10 * 60_000;

/*
 * How long `bun install` gets, before the run row exists.
 *
 * This runs in the window between cutting the worktree and `beginRun` —
 * `Work.runningRuns()` is empty for the whole span, so a watchdog sweep in
 * that window sees an idle shift and an idle queue and concludes nothing is
 * happening. Without a ceiling here, a hung install held that window open
 * for ever: not just the run, the whole shift, invisible to every sweep that
 * only checks for a running row.
 */
const INSTALL_TIMEOUT_MS = 5 * 60_000;

export interface RunOutcome {
  ok: boolean;
  runId: number | null;
  worktree: string;
  branch: string;
  /** What happened, in words a person reads first. */
  says: string;
}

/**
 * Cut a worktree for one task.
 *
 * Off the CURRENT TIP rather than a remembered base: he cuts from the latest
 * state of the working branch, and a worktree cut from something older is a
 * merge conflict he did not ask for.
 */
/** Exported for the test that drives the leftover-branch path: what it pins is
 *  a sequence of git calls, and going through a whole run to reach them would
 *  need an agent, a worktree and four minutes. */
export const __cutWorktree = (
  repo: string, branch: string,
  git: (args: string[], cwd: string) => Promise<{ ok: boolean; out: string }>,
) => cutWorktree(repo, branch, git);

/*
 * THE DIRECTORIES A LOOP IS STANDING IN, RIGHT NOW.
 *
 * The watchdog's sweeps decide from the run TABLE, and the table is a
 * description of a run that is written at its edges — begun, finished. In
 * between there is a live process holding a directory, and three times this
 * afternoon two sweeps in the same tick took it away:
 *
 *   1. `sweepVanishedRuns` sees the agent's tmux window is gone (which is
 *      TRUE — the agent exits the moment it has said its last word) and ends
 *      the row `failed`.
 *   2. `sweepEmptyWorktrees` now sees an ENDED row with no commits, and
 *      removes the directory.
 *   3. The loop, which is still in that directory running the test suite the
 *      agent's work has to pass, spawns into nothing and dies of
 *      `ENOENT … posix_spawn`.
 *
 * The row's state cannot answer this, because between the agent leaving and
 * the verdict being written the row is legitimately not `running` any more.
 * What can answer it is the loop itself, so it says so: a path is in this set
 * from the moment it is cut until the run returns, whatever the run returns.
 *
 * In-process on purpose. A loop in another process holds another machine's
 * directories, and one loop at a time is enforced elsewhere.
 */
const standingIn = new Set<string>();

/** Whether any loop in this process is currently working inside `path`. */
export function busyWorktree(path: string): boolean {
  const p = (path || "").trim();
  return !!p && standingIn.has(p);
}

/** For a test, and for a process that has just started with nothing in flight. */
export function __forgetStanding(): void { standingIn.clear(); }

/**
 * Whether the agent stopped because its own session was spent, and when it is
 * back.
 *
 * Not a failure of the task, and this matters because everything downstream
 * treats a run that produced nothing as evidence AGAINST the task: attempts are
 * counted, and after enough of them the register says "this task has been
 * started N times and has never finished. It needs a person to look before it
 * is worth trying again" — about a task nobody has actually tried yet.
 *
 * Measured on run #136: the whole of what the agent said was
 * `You've hit your session limit · resets 6:40pm (Europe/Madrid)`, and the row
 * read "it finished having produced nothing — and its own last words did not
 * say why". They said exactly why.
 *
 * Returns the reset time as the agent phrased it, or an empty string when it
 * said there was a limit but not when — both of which are "yes", so callers
 * test for `!== null`.
 */
export function ranOutOfSession(text: string): string | null {
  const t = text || "";
  if (!/(hit your|reached your|out of).{0,24}(session|usage) limit|session limit reached|usage limit reached/i.test(t)) return null;
  const m = /reset[s]?\s+(?:at\s+)?([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?(?:\s*\([^)]{1,40}\))?)/i.exec(t);
  return (m?.[1] ?? "").trim();
}

/**
 * What actually killed a run, given what the exception said and whether its
 * checkout is still there.
 *
 * `Bun.spawn` reports a missing WORKING DIRECTORY with the same sentence it
 * reports a missing program — measured both ways in one process, and the two
 * are indistinguishable. Four rows in this register have blamed `bun` for a
 * checkout that had been removed from under the run, and every one of them
 * sent somebody to check a binary that was there the whole time.
 */
export function whyItDied(message: string, worktree: string, checkoutExists: boolean): string {
  if (!/ENOENT/.test(message) || checkoutExists) return message;
  return `its checkout is gone — ${worktree} was removed while the run was in it `
    + `(the spawn blamed the program it was trying to start: ${message.slice(0, 200)})`;
}

async function cutWorktree(
  repo: string,
  branch: string,
  git: (args: string[], cwd: string) => Promise<{ ok: boolean; out: string }>,
): Promise<{ ok: boolean; path: string; says: string }> {
  const path = `${repo.replace(/\/+$/, "")}-${branch.split("/").pop()}`;
  if (existsSync(path)) {
    // Never reuse. A worktree left over from an earlier run holds that run's
    // half-finished state, and starting a new task on top of it is how two
    // unrelated changes end up on one branch.
    return { ok: false, path, says: `${path} already exists — the previous run's worktree is still there` };
  }
  const r = await git(["worktree", "add", "-b", branch, path, "HEAD"], repo);
  if (r.ok) return { ok: true, path, says: seedSummary(seedFrom(repo, path)) };

  /*
   * THE BRANCH FROM A RUN THAT DIED BADLY.
   *
   * Branch names are a hash of the item, so a task whose run left its branch
   * behind can never be cut again: every attempt answers "a branch named … 
   * already exists", the loop counts that as a failed round, and `shouldStop`
   * ends the SHIFT. Measured today — one run died of a missing directory, and
   * the deputy was then dead for the rest of the afternoon over an empty
   * branch nobody could see.
   *
   * So an existing branch is asked what it is holding, once. Nothing on it
   * beyond the base and no worktree using it: it is a leftover, and it is
   * removed and the cut retried. Anything else is somebody's work, and the cut
   * still fails — with a sentence that says what to look at instead of git's.
   */
  if (!/already exists/.test(r.out)) return { ok: false, path, says: r.out.slice(0, 400) };
  const used = await git(["worktree", "list", "--porcelain"], repo);
  if (used.ok && used.out.includes(`branch refs/heads/${branch}\n`)) {
    return { ok: false, path, says: `${branch} is checked out in another worktree — that run is still going or its directory is still there` };
  }
  const ahead = await git(["rev-list", "--count", `HEAD..${branch}`], repo);
  const commits = Number((ahead.out || "").trim()) || 0;
  if (commits) {
    return {
      ok: false, path,
      says: `${branch} already exists and holds ${commits} commit${commits === 1 ? "" : "s"} nobody has merged — `
        + "merge it or throw it away before this task is offered again",
    };
  }
  const gone = await git(["branch", "-D", branch], repo);
  if (!gone.ok) return { ok: false, path, says: `${branch} already exists and could not be removed: ${gone.out.slice(0, 200)}` };
  const again = await git(["worktree", "add", "-b", branch, path, "HEAD"], repo);
  return { ok: again.ok, path, says: again.ok ? "" : again.out.slice(0, 400) };
}

/**
 * A worktree with its dependencies in it, before anybody is asked to work there.
 *
 * `git worktree add` links no `node_modules`, so a fresh cut has no packages
 * and no `tsc`. The brief has told the agent to run `bun install` first for
 * some time now, and the paragraph explains itself by naming the four runs
 * that learned it the expensive way — one of them spent 16 minutes of a
 * 23-minute run reading `Cannot find package` as its own change breaking the
 * suite.
 *
 * A fifth one then did it again, differently: it never ran the install at all,
 * and the verdict ran against a tree with no packages. Six tests failed for
 * "node_modules is missing", the run was recorded as a failure, and — because
 * one failure ends a shift — the queue behind it stopped too.
 *
 * An instruction the agent can forget is the wrong shape for this. It is not a
 * step of the task, it is a precondition of the VERDICT meaning anything, so
 * the loop does it. Roughly 70ms off the shared cache, paid once per run,
 * against a whole shift.
 *
 * A failure here is not fatal: the agent is told, and can still install by
 * hand. The thing being prevented is the silent case where nobody did.
 */
async function installInto(
  path: string,
  install?: (cwd: string, timeoutMs: number) => Promise<{ ok: boolean; out: string }>,
): Promise<{ ok: boolean; says: string }> {
  if (!install) return { ok: true, says: "" };
  const r = await install(path, INSTALL_TIMEOUT_MS);
  return { ok: r.ok, says: r.ok ? "" : r.out.slice(-400) };
}

/**
 * What the run actually SAID, for the record.
 *
 * This was `out.slice(0, 1000)` — the HEAD of the output — and the three runs
 * on this machine all recorded the same thing: `bun test v1.3.9` and a server
 * log line that happened to print while the suite was starting. The one line
 * anybody wants is `N pass, M fail`, and `bun test` writes it at the END, so
 * the field said nothing about whether the run passed. Reading the head of a
 * log to find out how it ended is the same mistake as reading a build's first
 * line to find out whether it built.
 *
 * The tail, then, with any counted line hoisted above it so the verdict
 * survives the truncation that follows.
 */
/*
 * Lines a test run prints that are not about the tests.
 *
 * A suite this size boots the application, so its output carries the app's own
 * chatter: integration notices, and the event-loop warning this repository
 * prints when a request holds the thread. Both are true and neither is the
 * verdict — and the recorded outcome is drawn on screen under the words "what
 * the tests said", where "[clickup] card notifications are working again" is a
 * sentence with no business being.
 *
 * Dropped by SHAPE rather than by a list of strings, so a notice added
 * tomorrow is dropped too: bracketed source tags, and the timing warnings.
 */
const NOT_THE_VERDICT = [
  /^\s*\[[a-z0-9-]+\]/i,                       // [clickup] …, [config] …
  /event loop blocked/i,
  /the terminal was frozen/i,
  /^\s*⏱/,
  /^bun test v/i,                              // the banner, not a result
];

export function verdict(out: string, keep: number): string {
  const text = out
    .split("\n")
    .filter((l) => !NOT_THE_VERDICT.some((re) => re.test(l)))
    .join("\n")
    .trimEnd()
    // Blank runs left by the filtering, collapsed: the point was to remove
    // noise, not to replace it with the space where it used to be.
    .replace(/\n{3,}/g, "\n\n");
  const counts = text.split("\n").filter((l) => /\b\d+\s+(pass|fail)\b/.test(l)).slice(-3);
  /*
   * A CLEAN COUNT IS THE WHOLE ANSWER. `counts` was already hoisted above the
   * tail so the verdict survives truncation — but the tail below it is the
   * SAME output the counts came from, so a passing run said "40 pass, 0 fail"
   * once on its own line and then again inside 900-2000 more characters that
   * end in the same line. Nobody reads past a zero-fail count for what caused
   * it, because nothing did. A failing count is a different claim: which test
   * and why is IN that tail and nowhere else, so it stays.
   */
  const clean = counts.length > 0 && counts.every((l) => /\b0\s+fail\b/.test(l));
  if (clean) return counts.join("\n");
  const tail = text.length > keep ? `…\n${text.slice(-keep)}` : text;
  return counts.length ? `${counts.join("\n")}\n\n${tail}` : tail;
}

/*
 * PHRASES A STALLED RUN REACHES FOR — every one of these lifted from an actual
 * recorded outcome on this machine, not guessed. A sentence that says "I will
 * find out" instead of "I found" matches one of these and is dropped; a
 * sentence that reports what actually happened does not, no matter how the
 * background job it happened alongside is described.
 */
const STALL_TALK = [
  /\bwait(?:ing|ed)?\s+(?:for|on)\b/i,
  /\bi'll\s+wait\b/i,
  /\bwill\s+report\b/i,
  /\bwill\s+check\b/i,
  /\bstanding\s+by\b/i,
  /\bholding\s+for\b/i,
  /\bhold\s+here\b/i,
  /\bpick\s+back\s+up\b/i,
  /\bmonitor\s+notification\b/i,
  /\brather\s+than\s+poll\b/i,
  /\b(?:running|still\s+running)\s+in\s+background\b/i,
  /\bcontinuing\s+to\s+wait\b/i,
];

/**
 * What a run's own words argue for, once the sentences that only promise a
 * future check are taken out.
 *
 * Splitting on sentence boundaries rather than filtering the whole block as
 * one unit, because a run reporting real progress often mentions a background
 * job in passing ("waiting on the server suite; meanwhile, review the diff")
 * — that ONE sentence is stall talk, the rest of the paragraph is not, and a
 * whole-block match would have thrown the real progress out with it.
 */
export function stripStallTalk(text: string): string {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !STALL_TALK.some((re) => re.test(s)))
    .join(" ");
}

/**
 * Work one task through, and report honestly.
 *
 * `agent` and `git` are handed in rather than imported, for the same reason the
 * actuator takes a runner: this file must not be able to reach a shell or a
 * repository on its own. Everything it does, it does through something the
 * caller decided to give it.
 */
export async function workOne(p: {
  item: WorkItem;
  repo: string;
  shiftId: number | null;
  /** Run the person's own agent, with their tools, in a directory. */
  agent: (
    cwd: string, prompt: string, timeoutMs: number,
    /*
     * Where to open the window, what to call it, and where to publish the pane
     * once it exists.
     *
     * The run used to be a hidden `Bun.spawn`, which meant twenty-five minutes
     * with nothing on screen but "this takes as long as the task does". The
     * work is a pane now, so it can be watched while it happens — and the pane
     * id has to come back the moment tmux hands it over rather than at the end,
     * because a pane you learn about when the run is finished is a log.
     */
    show?: {
      root: string; label: string;
      /** The card body, so the model is chosen from the whole task. */
      detail?: string;
      onPane?: (paneId: string) => void;
      /** Why there is no pane, when there is not one. */
      onNoPane?: (why: string) => void;
    },
  ) => Promise<{ ok: boolean; out: string }>;
  git: (args: string[], cwd: string) => Promise<{ ok: boolean; out: string }>;
  /** The person's own test command, run in the worktree. */
  verify: (cwd: string, timeoutMs: number) => Promise<{ ok: boolean; out: string }>;
  /** Put the dependencies in a freshly cut worktree. Optional so a test can
   *  leave it out; in production leaving it out is what this exists to stop. */
  install?: (cwd: string, timeoutMs: number) => Promise<{ ok: boolean; out: string }>;
  /*
   * Where the app is, so the agent can read the same views the person looks at.
   * Optional: a run without it simply works blind to everything outside its
   * worktree, which is what every run did before.
   */
  api?: { url: string };
  /** What is left of the plan allowance, so the run can pace what it spends. */
  usage?: { weekRemaining: number } | null;
  /** Told as soon as there is a pane to watch, so a person can go and look. */
  onPane?: (runId: number | null, paneId: string) => void;
  onNoPane?: (runId: number | null, why: string) => void;
  /** Charged when the run BEGINS — see the note where it is called. */
  countAction?: () => void;
}): Promise<RunOutcome> {
  const branch = branchFor(p.item);

  /* When this run began, so a deliverable can be checked for being written BY
     it rather than merely existing — see the check at the end. Taken before
     the worktree is cut, which is the earliest moment anything is ours. */
  const startedAt = Date.now();
  const cut = await cutWorktree(p.repo, branch, p.git);
  if (!cut.ok) {
    /*
     * A REFUSED CUT COSTS AN ATTEMPT, or the same task is offered for ever.
     *
     * This returned before `beginRun`, so there was no row, `taken()` never
     * fired, `noteUndelivered` was never called and the queue's `attempts`
     * column never moved: the item came back at weight 20 on the next round,
     * and the round after that, with nothing on screen saying why. And the
     * branch name is a deterministic hash of the item, so a leftover branch
     * from the last attempt made every future attempt fail the same way —
     * a loop that cannot end and cannot explain itself.
     */
    noteUndelivered({
      itemId: p.item.id, title: p.item.title, state: "failed",
      why: `could not cut a worktree for it: ${cut.says}`.slice(0, 400), runId: null,
    });
    return { ok: false, runId: null, worktree: cut.path, branch, says: cut.says };
  }

  /*
   * The worktree's HEAD right after the cut, before the agent has touched
   * anything — so later we can ask git "did anything land on this branch"
   * instead of asking the agent. `worktree add -b branch path HEAD` gives the
   * new branch the same tip as the repo it was cut from, so this sha IS that
   * tip, read back from the worktree itself rather than assumed.
   */
  const baseSha = (await p.git(["rev-parse", "HEAD"], cut.path)).out.trim();

  const installed = await installInto(cut.path, p.install);

  const runId = beginRun({ shiftId: p.shiftId, item: p.item, repo: p.repo, worktree: cut.path, branch });
  /* The shift pays for a run that STARTED. Charged here rather than at
     selection, and never at completion: an agent that wedges must still cost
     its action, or one bad task is free to be retried until the clock runs
     out. */
  p.countAction?.();

  /*
   * FROM HERE, NOTHING LEAVES BY THROWING.
   *
   * There was no `try` in this body, and every helper past this line spawns
   * with `cwd` set to the worktree — `Bun.spawn` throws SYNCHRONOUSLY when that
   * directory is gone, which is a thing that happens: a sweep removed it, a
   * person deleted it, a second loop cut over it. The exception unwound through
   * `workUntilDone` and `startWorkLoop` into the watchdog's own
   * `void resumeFn().catch(() => {})`, so `finishRun` was never called and the
   * row stayed `running` for ever.
   *
   * One leaked `running` row is not a small thing: both `sweepIdleShift` and
   * `sweepUnfinishedQueue` return early while anything is running, so the
   * deputy goes blind — full queue, nothing actually running, no alerts — until
   * `sweepStalledRuns` picks it up an hour after it started.
   */
  standingIn.add(cut.path);
  try {

  /*
   * From here the worktree exists, so every exit has to say what it left
   * behind. A run that returns without mentioning the directory it created is
   * how somebody ends up with fourteen worktrees and no idea which is which.
   */
  /* The one case where the agent still has to know: the install was attempted
     and did not work, so `Cannot find package` in the next four minutes is the
     environment rather than its own change. Silence here is what cost a run
     16 of its 23 minutes. */
  const envNote = installed.ok ? "" : `\n\nHEADS UP: \`bun install\` was run for you in this worktree and FAILED:\n${installed.says}\nA missing package is that, not your change. Fix the install first.\n`;
  const said = await p.agent(cut.path, brief(p.item, cut.path, p.api, TASK_TIMEOUT_MS, p.usage) + envNote, TASK_TIMEOUT_MS, {
    // The repository, not the worktree: the engine keeps one session per
    // project, and a session per run would leave one behind for every task.
    root: p.repo,
    label: p.item.title,
    // The title names the work, the body says what kind of work it is. Both
    // go to the chooser or it picks a tier from one line.
    detail: p.item.detail,
    onPane: (paneId) => p.onPane?.(runId, paneId),
    onNoPane: (why) => p.onNoPane?.(runId, why),
  });
  if (!said.ok) {
    /*
     * WHETHER IT LEFT ANYTHING, because "it could not finish" describes two
     * very different mornings.
     *
     * Measured on the first real run: the agent had changed the right two
     * files and staged them, and was killed on the timeout before it could
     * commit. The row said `failed` with a blank outcome, which reads exactly
     * like an agent that sat there and did nothing — so the useful half hour
     * of work in that directory was the thing nobody would go and look at.
     */
    /* Untracked files still count HERE, and deliberately: on the failure path
       the question is "is there anything in that directory worth opening",
       and a new file the agent wrote and never staged is exactly that. The
       success path asks a stricter question and uses -uno; see there. */
    const dirty = await p.git(["status", "--porcelain"], cut.path);
    const left = dirty.ok && dirty.out.trim().length > 0;
    endedEmptyHanded(runId, p.item, "failed", verdict(said.out, 2000));
    return {
      ok: false,
      runId,
      worktree: cut.path,
      branch,
      says: left
        ? `it could not finish, but it had started — uncommitted work is waiting at ${cut.path} on ${branch}`
        : `it could not finish and left nothing behind — the worktree is at ${cut.path} if you want to look`,
    };
  }

  /*
   * THE ONLY VERDICT THAT COUNTS. The agent saying it is done is not evidence;
   * his own words on this are "compiling is not evidence", after a session that
   * reported success on a build nobody had run. So the tests run, and their
   * result is the outcome regardless of how confident the transcript sounded.
   */
  const checked = await p.verify(cut.path, VERIFY_TIMEOUT_MS);
  /*
   * WHAT IT SAID, AND THEN WHAT THE TESTS SAID. In that order, and both.
   *
   * The outcome used to be the test output alone, so a run that decided
   * "measured, there is nothing to fix here" recorded 3900 pass / 0 fail and
   * not one word of the reasoning — the answer to the question it was asked
   * was thrown away and the proof was kept. Three times in one afternoon the
   * only way to find out what a run had concluded was to go digging through
   * transcripts in /tmp.
   *
   * The words first, because that is what a person opens the row for; the
   * verdict under them, because it is what makes the words trustworthy.
   */
  const both = (words: string, tests: string, keep: number) =>
    `${verdict(words, keep)}\n\n--- what the tests said ---\n${verdict(tests, 900)}`;
  if (!checked.ok) {
    endedEmptyHanded(runId, p.item, "failed", both(said.out, `tests failed:\n${checked.out}`, 1600));
    return {
      ok: false,
      runId,
      worktree: cut.path,
      branch,
      says: `it finished but the tests do not pass — left at ${cut.path} on ${branch}`,
    };
  }

  /*
   * TESTS GREEN IS NOT THE SAME FACT AS COMMITTED. `verify` runs against the
   * WORKING TREE, so an agent that made every right change and then ended its
   * turn without committing — three of them did, one of them twice, the last
   * one saying it was "holding for a monitor notification" that nothing was
   * ever going to send — passes this exact check and used to be recorded
   * `done`. The row said "nothing pushed" as if the only thing missing was a
   * remote, when the truth was nothing had even reached the branch.
   *
   * This is the one place that fact can be caught for certain, because it does
   * not depend on the agent having said anything honest about it: the tree
   * either has a commit or it does not. A shift stops here the same way it
   * stops on a failed run — the next task would otherwise start on a worktree
   * with unrecorded work sitting one directory over, which is not a clean
   * slate either.
   */
  /*
   * TRACKED changes only — `-uno`.
   *
   * Measured on run 75: the agent had committed the fix, the suite was green,
   * and the shift still stopped with "tests pass but it never committed"
   * because a tool that is not ours had left a `.impeccable/` directory in the
   * worktree. Plain --porcelain counts untracked files, so anything that
   * writes a dot-directory into the tree — a linter's cache, an editor, a
   * skill — reads here as unrecorded work and throws away a finished shift.
   *
   * The question this guard is asking is "did it commit what it changed", and
   * only tracked paths can answer that: a file git has never seen is not work
   * this run failed to record, it is litter. Untracked leftovers are reported
   * further down instead, where they cost a sentence rather than the shift.
   */
  /* Set when the net below had to commit for it — carried to the outcome so
     the row says who recorded the work, not just that it was recorded. */
  let rescuedByLoop = false;
  const dirty = await p.git(["status", "--porcelain", "-uno"], cut.path);
  if (dirty.ok && dirty.out.trim().length > 0) {
    /*
     * THE NET, because telling it to commit has now failed three times.
     *
     * The brief already says COMMIT BEFORE YOUR TURN ENDS in capitals and
     * spends a paragraph on why. Runs 87, 89 and 90 read that and still ended
     * with finished, green, uncommitted work on disk — all three for the same
     * reason, and it is not disobedience: they were waiting for a suite they
     * had started, in a turn that had no next one. The instruction is correct
     * and does not work, so the loop stops relying on it.
     *
     * Committing here is safe in the only way that matters: `checked.ok` is
     * true a few lines up, which means the tests passed against THIS working
     * tree. The choice is not between a good commit and a bad one, it is
     * between a commit and a branch nobody will ever come back for.
     *
     * It is recorded as the net's commit, not the agent's, and the run says so
     * in its own words. A clone that quietly gets credit for work it did not
     * record is a clone whose failures stop being visible — and the failure is
     * real, it just no longer costs the work.
     */
    const rescue = await p.git(["add", "-A"], cut.path);
    const message = [
      `${p.item.title}`,
      "",
      "Committed by the run loop, not by the agent: the tests passed against",
      "this working tree and the turn ended before anything reached the branch.",
      "The change is the agent's; only the recording is not.",
      "",
      "Its own last words:",
      "",
      verdict(said.out, 600).split("\n").map((l) => `  ${l}`).join("\n"),
    ].join("\n");
    const saved = rescue.ok && (await p.git(["commit", "-q", "-m", message], cut.path)).ok;
    if (saved) {
      /*
       * And then it carries on down the ordinary path — it does NOT declare
       * `done` here. Committing is the only thing this branch fixes; every
       * other question the loop asks of a finished run still has to be asked,
       * and the deliverable check in particular lives further down. Returning
       * a verdict from here skipped it, and a task whose whole point was to
       * write a file would have been recorded done without anyone looking for
       * the file. A test caught that within the hour.
       */
      rescuedByLoop = true;
    } else {
      endedEmptyHanded(runId, p.item, "uncommitted", both(said.out, checked.out, 1600));
      return {
        ok: false,
        runId,
        worktree: cut.path,
        branch,
        says: `tests pass but it never committed — the work is waiting, not lost, at ${cut.path} on ${branch}`,
      };
    }
  }

  /*
   * CLEAN AND UNCOMMITTED ARE NOT THE ONLY WAY TO DELIVER NOTHING. `uncommitted`
   * above catches the run that did the work and never recorded it. This catches
   * the other half: a branch with no commits at all, on a tree that is clean
   * because nothing was ever written to it — the shape of a run that spent its
   * whole turn "investigating" and stopped there, or the shape of a run that
   * spent its whole turn waiting on a background job. Measured against it: run
   * 41, judging a compression task, whose entire recorded outcome was
   * "Investigating brief/task/outcome/views code in background. Waiting for
   * results." — 79 characters, no commit, a clean tree, and it was still
   * recorded `done`.
   *
   * The honest exception is real: a run whose correct answer is "there is
   * nothing to change here" also leaves no commit, and that answer is worth
   * having. What tells the two apart is not the missing commit, it is whether
   * the agent's own words carry an ARGUMENT for it — and length alone does not
   * find that line. Run 49, given an idle-CPU regression, spent its whole turn
   * kicking off a background bench and reporting on its own waiting for it:
   * seven sentences, 465 characters, zero measurements, zero commits, and a
   * plain character count called that `done` because seven sentences about
   * waiting are longer than the threshold the previous version of this check
   * used. Length was never the property that mattered; a stalled run is not
   * SHORT, it is EMPTY OF CLAIMS. It reports what it is ABOUT to do, never
   * what it found.
   *
   * So `STALL_TALK` is stripped out first, and the argument is judged on what
   * is left. Every phrase in it was lifted from an actual stalled run on this
   * machine ("waiting for", "will report once", "standing by", "monitor
   * notification", "rather than poll", "running in background", "still
   * running", "hold here", "holding for", "pick back up") — a run reporting
   * an ordinary background test suite mid-turn ("waiting on the server
   * suite... meanwhile, review the diff") loses that one sentence and keeps
   * the rest, because the rest is still there to keep. A run with nothing but
   * that vocabulary — run 41, run 49 — has nothing left after stripping it,
   * regardless of how many ways it found to say the same non-answer.
   */
  const words = verdict(said.out, 1600).trim();
  const claims = stripStallTalk(words);
  const ARGUMENT_MIN_CHARS = 150;
  if (claims.length < ARGUMENT_MIN_CHARS) {
    const ahead = await p.git(["rev-list", "--count", `${baseSha}..HEAD`], cut.path);
    // Fail OPEN on a git error: we could not confirm there is nothing on the
    // branch, so this is not the place to guess. A run wrongly kept as `done`
    // costs a second look; a real answer wrongly demoted to `empty` costs
    // somebody's trust in the state.
    const commits = ahead.ok ? Number.parseInt(ahead.out.trim(), 10) || 0 : -1;
    if (commits === 0) {
      /*
       * UNLESS IT NEVER GOT A TURN.
       *
       * "Left nothing" is a judgement on the work, and everything downstream
       * reads it that way — the attempt is counted, and after enough of them
       * the register tells a person the TASK needs looking at. When the whole
       * of what the agent said is that its session is spent, the task has not
       * been tried at all, and saying so is both truer and cheaper.
       */
      const spent = ranOutOfSession(said.out);
      if (spent !== null) {
        const back = spent ? ` — it comes back at ${spent}` : "";
        /* Sleep until then, and nobody pays for the same answer again. */
        const until = resetTimeFrom(spent);
        /* The reason only: the screen prints the hour beside it, so the hour
           in here would be said twice on one line. */
        holdUntil(until, spent ? "the agent's session limit is spent" : "the agent's session limit is spent and no reset hour was given, so an hour");
        endedEmptyHanded(runId, p.item, "empty",
          `the agent had no session left${back}, so this task was never started`);
        return {
          ok: false,
          runId,
          worktree: cut.path,
          branch,
          says: `the agent had no session left${back} — nothing was attempted, so ${branch} is empty on purpose`,
        };
      }
      endedEmptyHanded(runId, p.item, "empty", both(said.out, checked.out, 1600));
      return {
        ok: false,
        runId,
        worktree: cut.path,
        branch,
        says: `it finished but left nothing — no commit on ${branch}, and its own last words were too thin to count as an answer: ${cut.path}`,
      };
    }
  }

  /*
   * AND THE FILE IT OWED, when it owed a file.
   *
   * Everything above judges a run by its commit and its tests, which is right
   * for a run that writes code and blind to a run that writes a REPORT. A
   * study or a design legitimately leaves the repository untouched, so a clean
   * tree is the expected outcome and not evidence of anything.
   *
   * Measured on the task-provider design run: it spawned two subagents, sat
   * waiting for notifications that never came, wrote no file, and recorded
   * itself `done` with the suite green — because the suite was green, and
   * nothing else was being asked.
   *
   * So a task may name what it owes, and the check is that the file exists AND
   * was written during this run. Existence alone would pass on a file left by
   * an earlier attempt, which is the exact case this is for: the second run of
   * a task whose first run half-finished.
   */
  if (p.item.deliverable) {
    const owed = p.item.deliverable.replace(/^~(?=\/|$)/, homedir());
    let wroteIt = false;
    try {
      const st = statSync(owed);
      wroteIt = st.isFile() && st.mtimeMs >= startedAt;
    } catch { /* not there at all */ }
    if (!wroteIt) {
      endedEmptyHanded(runId, p.item, "empty", both(said.out, checked.out, 1600));
      return {
        ok: false,
        runId,
        worktree: cut.path,
        branch,
        says: `tests pass and it owed a file it did not write: ${p.item.deliverable} is ${existsSync(owed) ? "older than this run" : "not there"}`,
      };
    }
  }

  if (runId) finishRun(runId, "done", both(
    rescuedByLoop
      ? `${verdict(said.out, 1200)}\n\n--- the loop committed this ---\nIt ended its turn with the work green and unrecorded; the loop committed it rather than leave it on disk.`
      : said.out,
    checked.out, rescuedByLoop ? 1800 : 1600));
  return {
    ok: true,
    runId,
    worktree: cut.path,
    branch,
    says: `done, tests green — ${branch} at ${cut.path}, nothing pushed`,
  };
  } catch (e) {
    /*
     * The row is closed and the item is put back the ordinary way, so the
     * queue and the register agree about what happened.
     *
     * `says` is a FIXED sentence with the error appended after it, and that
     * matters: `workUntilDone` classifies a barren round by matching words in
     * `says`, and a raw git error contains "already exists" — which would send
     * this straight to `discardRun`, whose job is `worktree remove --force`
     * plus `rm -rf`. A crash must not be able to delete the evidence of itself.
     */
    /*
     * NAME THE THING THAT IS ACTUALLY MISSING.
     *
     * `Bun.spawn` reports a missing WORKING DIRECTORY with the same sentence
     * it reports a missing program — measured, both give
     * `ENOENT: no such file or directory, posix_spawn '/…/bun'`. Four rows in
     * this register have blamed `bun` for a checkout that had been removed
     * from under the run, and every one of them sent somebody to check a
     * binary that was there the whole time.
     *
     * So when the spawn says ENOENT, the directory is asked whether it is
     * still there, and the row says which of the two it was.
     */
    const why = whyItDied(String((e as Error)?.message ?? e).slice(0, 600), cut.path, existsSync(cut.path));
    endedEmptyHanded(runId, p.item, "failed", `the run threw and could not finish: ${why}`);
    return {
      ok: false,
      runId,
      worktree: cut.path,
      branch,
      says: `the run threw and could not finish — ${branch} at ${cut.path} is as the agent left it. Error: ${why}`,
    };
  } finally {
    /* Released however this ended — a return, a throw, a `Halt`. A path left
       in the set for ever would make the sweep that keeps the checkout list
       readable stop working, quietly. */
    standingIn.delete(cut.path);
  }
}

/**
 * Keep going until there is nothing left, or the shift says stop.
 *
 * THIS IS THE SENTENCE HE ACTUALLY SAID: "if we run out of work, look for more
 * where we usually look for it". Until now the loop did exactly one task per
 * request, which is a task runner with a loop's name on it.
 *
 * WHAT ENDS IT, and every one of these is a hard stop rather than a preference:
 *
 *   no task left — the honest ending, and the common one;
 *   a run that failed — the next task would be started on a machine in a state
 *   nobody has looked at, and "carry on and hope" is how one bad run becomes
 *   four;
 *   the shift out of time or budget, asked FRESH each round rather than
 *   remembered, because a shift can be halted between two tasks and the loop
 *   must find out;
 *   a hard ceiling on rounds, so a bug that makes `nextTask` return the same
 *   item for ever cannot spend a night on it.
 *
 * It does not tidy up after itself. Every worktree it leaves is one somebody
 * needs to look at — a success to review, or a failure to diagnose.
 */
export async function workUntilDone(p: {
  repos: string[];
  shiftId: number | null;
  /*
   * Fresh each round: the shift may have been halted since the last one, and
   * it is told whether the round before this one failed.
   *
   * The stop rules live on the shift and one of them is "a failure ends it" —
   * a failed run means the world was not what it predicted, and whatever comes
   * next was chosen against that same wrong picture. Only the loop knows how
   * the last round went, so only the loop can ask that question properly.
   */
  keepGoing: (lastFailed: boolean) => { go: boolean; why: string };
  next: () => Promise<WorkItem | null>;
  /** Charged when a run BEGINS, not when a task is chosen — see `workOne`. */
  countAction?: () => void;
  /** Read once for the whole loop: the meter moves slowly against one task. */
  usage?: { weekRemaining: number } | null;
  onPane?: (runId: number | null, paneId: string) => void;
  onNoPane?: (runId: number | null, why: string) => void;
  agent: (
    cwd: string, prompt: string, timeoutMs: number,
    /*
     * Where to open the window, what to call it, and where to publish the pane
     * once it exists.
     *
     * The run used to be a hidden `Bun.spawn`, which meant twenty-five minutes
     * with nothing on screen but "this takes as long as the task does". The
     * work is a pane now, so it can be watched while it happens — and the pane
     * id has to come back the moment tmux hands it over rather than at the end,
     * because a pane you learn about when the run is finished is a log.
     */
    show?: {
      root: string; label: string;
      /** The card body, so the model is chosen from the whole task. */
      detail?: string;
      onPane?: (paneId: string) => void;
      /** Why there is no pane, when there is not one. */
      onNoPane?: (why: string) => void;
    },
  ) => Promise<{ ok: boolean; out: string }>;
  git: (args: string[], cwd: string) => Promise<{ ok: boolean; out: string }>;
  verify: (cwd: string, timeoutMs: number) => Promise<{ ok: boolean; out: string }>;
  /** Put the dependencies in each freshly cut worktree. Passed through. */
  install?: (cwd: string, timeoutMs: number) => Promise<{ ok: boolean; out: string }>;
  /** Passed straight through, so every task in a loop can read the views too. */
  api?: { url: string };
  maxRounds?: number;
}): Promise<{ done: RunOutcome[]; stopped: string }> {
  const done: RunOutcome[] = [];
  const cap = Math.max(1, Math.min(20, p.maxRounds ?? 8));
  /** Whether the run just before this one was swept — see the note below for
   *  why two barren failures in a row stop the loop anyway. */
  let sweptLast = false;
  let swept = 0;

  for (let round = 0; round < cap; round++) {
    const check = p.keepGoing(done.length > 0 && !done[done.length - 1]!.ok);
    if (!check.go) return { done, stopped: check.why };
    /* Asleep: the agent's session limit was hit and the CLI said when it
       resets. Nothing is taken until then — see Work.holdUntil. */
    const nap = heldUntil();
    if (nap) {
      const at = new Date(nap.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return { done, stopped: `asleep until ${at}: ${nap.why}` };
    }

    const item = await p.next();
    if (!item) {
      return { done, stopped: done.length ? "nothing left to work on" : "nothing to work on right now" };
    }
    if (!item.repo || !p.repos.includes(item.repo)) {
      // Same rule as the single-task route: a task nobody can place is not
      // placed anyway. Skipping rather than stopping, because the NEXT one may
      // well be placeable and one unplaceable card should not end a shift.
      continue;
    }

    const res = await workOne({
      item,
      repo: item.repo,
      shiftId: p.shiftId,
      agent: p.agent,
      usage: p.usage,
      onPane: p.onPane,
      onNoPane: p.onNoPane,
      countAction: p.countAction,
      git: p.git,
      verify: p.verify,
      install: p.install,
      api: p.api,
    });
    done.push(res);

    if (!res.ok) {
      /*
       * HEAL, or stop — and the difference is whether there is anything to
       * look at.
       *
       * This used to stop on ANY failure, and the reasoning was sound for one
       * kind: a worktree with half a change in it is a state nobody has seen,
       * and starting the next task on top of it is how one bad run becomes
       * four. That is still true and it still stops.
       *
       * But most of a day's failures leave NOTHING — a pane that never
       * started, a clock that ran out before the first edit, a delegate that
       * never came back. There is no half-finished change to protect, and
       * stopping means the queue sits still until somebody notices and
       * restarts it by hand. Measured today: five stops, none of which had a
       * single line of work behind them, and each one waiting on a person.
       *
       * So a failure with an empty tree and no commit is swept and the loop
       * carries on. `discardRun` is the same delete the Throw it away button
       * uses, so nothing is removed here that could not be removed there.
       *
       * Twice in a row stops anyway. Two empty failures back to back is not
       * bad luck, it is something broken upstream of the work — and a loop
       * that keeps cutting worktrees against a broken CLI is worse than one
       * that stops and says so.
       */
      /*
       * A SPENT SESSION ENDS THE ROUND, NOT THE TASK.
       *
       * Before anything below classifies this: no agent on this machine can
       * run until the reset, so cutting another worktree would produce another
       * empty branch and another attempt counted against a task nobody has
       * tried. The item is already back on the queue; the loop just stops and
       * says when to come back.
       */
      if (/had no session left/.test(res.says)) {
        return { done, stopped: res.says };
      }
      const barren = /never became ready|never landed|already exists|could not write the brief|left nothing behind/.test(res.says);
      if (barren && !sweptLast) {
        sweptLast = true;
        swept++;
        /*
         * NOT A DIRECTORY SOMEBODY IS WORKING IN.
         *
         * "already exists" is in the list above, and it is the one message
         * that can mean the worktree belongs to a run that is STILL GOING —
         * two loops, the same item, the second refused. Sweeping there is
         * `worktree remove --force` plus `rm -rf` on the first one's work
         * while its agent is mid-edit. The HTTP discard route has refused
         * exactly this with a 409 since it was written; this caller never
         * asked. One loop at a time makes it improbable; asking makes it
         * impossible.
         */
        const owner = runOwning(res.worktree);
        if (owner?.state === "running") {
          /* Left alone, and the round still counts as swept so two of these in
             a row stop the loop — which is the right end for "something is
             cutting the same task twice". */
        } else {
          await discardRun(res.worktree, item.repo, p.git, res.branch).catch(() => { /* leave it for a person */ });
        }
        continue;
      }
      return {
        done,
        stopped: barren
          ? `stopped after two runs in a row that never got started: ${res.says}`
          : `stopped after a run that did not finish: ${res.says}`,
      };
    }
    sweptLast = false;
  }
  return {
    done,
    stopped: `reached the limit of ${cap} tasks in one go${swept ? ` (${swept} run${swept === 1 ? "" : "s"} swept and carried on)` : ""}`,
  };
}

/**
 * Throw a run away.
 *
 * Only ever called on a run a person has looked at and dismissed. The loop does
 * not tidy up after itself: a failed worktree is the evidence of what went
 * wrong, and deleting it automatically would mean the one run somebody wanted
 * to inspect is the one that is gone.
 */
export async function discardRun(worktree: string, repo: string,
  git: (args: string[], cwd: string) => Promise<{ ok: boolean; out: string }>,
  branch?: string): Promise<boolean> {
  try {
    await git(["worktree", "remove", "--force", worktree], repo);
    if (existsSync(worktree)) await rm(worktree, { recursive: true, force: true });
    /*
     * AND THE BRANCH, or the next attempt at the same task cannot start.
     *
     * A branch name is a deterministic hash of the item, so the orphan left
     * here made every future cut fail with "a branch named … already exists" —
     * and `sweepEmptyWorktrees` skips any run whose worktree is gone, so
     * nothing would ever come back for it. `-d` and not `-D`: git refuses to
     * delete a branch holding work nobody merged, which is exactly the line
     * this must not cross.
     */
    if (branch) await git(["branch", "-d", branch], repo);
    return !existsSync(worktree);
  } catch {
    return false;
  }
}
