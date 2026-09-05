/**
 * What keeps the understudy from stopping quietly.
 *
 * Two failures were measured over 108 runs, and this file is both of them:
 *
 *   1. Six runs died because the server restarted underneath them. The work was
 *      marked abandoned and then simply forgotten — the task he had queued was
 *      already marked taken, so nothing ever picked it up again. Installing a
 *      build was enough to lose a shift.
 *
 *   2. Five runs sat unfinished for over 45 minutes, the worst for 513 — eight
 *      and a half hours. The loop does enforce a 45-minute limit, but it does so
 *      from inside the process that is running the task, so when that process is
 *      the thing that died, nobody was left to enforce anything. The only event
 *      that ever noticed was the NEXT server start.
 *
 * The fix for both is the same shape: something outside the run has to look. On
 * startup we put back what the previous process dropped; on a timer we look for
 * runs nothing is driving any more. A task gets two goes, and then it stops
 * being retried and becomes a question addressed to a person — because a loop
 * that silently re-runs the same broken task all night is not autonomy, it is a
 * machine pretending to work.
 */
import { existsSync } from "node:fs";
import * as Work from "./understudy-work.ts";
import * as Shift from "./understudy-shift.ts";
import { requeue, MAX_ATTEMPTS, asked } from "./understudy-sources-work.ts";
import { raiseHand, clearHandsOfKind, hasOpenKind } from "./understudy-help.ts";
import { pushUnderstudyStuck } from "./alerts.ts";
import { bunBin, NO_BUN } from "./bunbin.ts";

/**
 * Whether `bun` can be found right now, asked so `settleAbandoned` can tell a
 * real cause of death from a theory about the branch.
 *
 * A slot, not a bare call: a test needs to say "there is no bun on this
 * machine" without actually uninstalling it, the same reason `setGitHook`
 * exists a few lines below.
 */
let bunCheckFn: () => string = () => bunBin();
export function setBunHook(fn: () => string): void { bunCheckFn = fn; }

/**
 * How long a run may sit `running` before something outside it steps in.
 *
 * The loop's own limit is 45 minutes. This is deliberately well past that: while
 * the loop is alive it kills its own task and records a real outcome, which is
 * always the better story. This number is for when the thing that should have
 * done the killing is gone, so it only has to be soon enough that a person is
 * not left staring at fictional work in flight — not soon enough to race the
 * loop's own bookkeeping.
 */
export const STALL_AFTER_MS = 60 * 60_000;

/** How often we look. Cheap: one indexed query over a table of hundreds. */
const SWEEP_EVERY_MS = 2 * 60_000;

export type Recovery = {
  /** Set when the run was still going and the row was simply put back. */
  adopted?: boolean;
  runId: number;
  title: string;
  requeued: boolean;
  askedForHelp: boolean;
  attempts: number;
};

/**
 * Put back everything the previous process was in the middle of.
 *
 * Called once at startup, and the reason an install no longer costs a shift.
 * A run whose source cannot be put back (a card, a pull request) is still
 * marked abandoned by the sweep — those sources re-offer their own work on the
 * next pass, which the hand-written queue does not.
 */
export async function recoverAfterRestart(): Promise<Recovery[]> {
  /*
   * THE ONES THAT ARE STILL RUNNING, ASKED BEFORE THEY ARE BURIED.
   *
   * A run is an agent in a tmux window, and that window outlives this process:
   * the server going down does not stop it. Measured this afternoon — the
   * recovery closed a row with "nobody was left to record how it ended" while
   * its agent went on running the suite, and with no row to see, the watchdog
   * started a SECOND attempt at the same task in a worktree beside it.
   *
   * So the window is asked first. If the agent is there, the row goes back to
   * running and nothing else happens to it: no verdict, no queue, no hand. If
   * the hook cannot answer (no tmux, no hook), nothing is adopted and the old
   * behaviour stands — which is the safe direction, since a row wrongly left
   * running blocks the install and the loop.
   */
  const alive = new Set<number>();
  if (aliveFn) {
    for (const r of Work.runs(50)) {
      if (r.state !== "running") continue;
      try { if (await aliveFn(r.title, r.paneId)) alive.add(r.id); } catch { /* unknown: not adopted */ }
    }
  }
  const orphans = Work.abandonOrphanedRuns();
  const out: Recovery[] = [];
  for (const o of orphans) {
    if (alive.has(o.id)) {
      Work.reopenRun(o.id);
      out.push({ runId: o.id, title: o.title, requeued: false, askedForHelp: false, attempts: 0, adopted: true });
      continue;
    }
    /*
     * WHAT IT LEFT BEHIND, BEFORE DECIDING TO DO IT AGAIN.
     *
     * Every one of these was killed mid-run by a server restart, and this used
     * to put all of them straight back on the queue. Measured on the real
     * ledger this morning: nineteen abandoned runs, and not one of them had
     * work that was still missing — two branches sat there already merged and
     * seventeen had been merged and deleted. Re-offering that is asking an
     * agent to spend twenty minutes redoing something that is already in the
     * tree, which is exactly what he said not to do: "if that work is already
     * done, we must not do it again".
     *
     * So the branch is asked first. Merged means the work landed — the row
     * says so instead of sitting on hold for ever, and nothing is queued.
     * Commits that are NOT merged are the case worth a person's attention:
     * that is real work nobody has looked at, and putting the task back would
     * quietly compete with it. Only a branch with nothing in it is genuinely
     * unstarted, and only that one goes back on the queue.
     */
    const left = await leftBehind(o.repo, o.branch, { id: o.id, tipSha: o.tipSha });
    if (left.kind !== "nothing") {
      Work.finishRun(o.id, "abandoned", left.says);
      if (left.kind === "unmerged") {
        raiseHand({
          runId: o.id, title: o.title, repo: o.repo,
          question: `A run of "${o.title}" was cut short by a restart and left ${left.commits} commit${left.commits === 1 ? "" : "s"} nobody has looked at.`,
          tried: `The work is on ${o.branch}. It has not been put back on the queue — doing it again would compete with what is already there. `
            + "Merge it, or throw the branch away and queue the task again.",
        });
      }
      out.push({ runId: o.id, title: o.title, requeued: false, askedForHelp: left.kind === "unmerged", attempts: 0 });
      continue;
    }
    const r = requeue({
      itemId: o.itemId,
      why: "the server restarted while it was running",
      runId: o.id,
    });
    out.push({
      runId: o.id, title: o.title,
      requeued: r.requeued, askedForHelp: r.askedForHelp, attempts: r.attempts,
    });
  }
  return out;
}

/**
 * EVERY INTERRUPTED RUN GETS A VERDICT, not just the fresh ones.
 *
 * The register read twelve rows of ON HOLD — "the server restarted while this
 * was running, nobody was left to record how it ended" — for work that had
 * been finished, merged and tidied hours earlier. It looks like a machine that
 * left everything half done: "it feels like something was left half done".
 *
 * Nothing was half done. What was missing was the second half of the sentence,
 * which git can answer at any time and nobody was asking: is the work on that
 * branch in the tree, is it still only on the branch, or is there no branch at
 * all. So every abandoned row is settled — once, and then it stays settled,
 * because the state stops being `abandoned` when the answer is known.
 *
 * The date is not touched. A register entry is dated the day the work
 * happened, not the day somebody worked out what became of it.
 */
export type Settled = { runId: number; title: string; verdict: "landed" | "waiting" | "nothing" };

/**
 * The row's own words, when it has any worth keeping.
 *
 * `RESTART_PLACEHOLDER` is written the moment a run is orphaned, before
 * anything has looked at git — it is a stand-in for "unknown", not a cause.
 * Anything else already sitting in `outcome` — a stall the watchdog itself
 * timed, an ENOENT the run threw, an interactive prompt nobody answered, a
 * branch another run still had checked out — is the actual reason this run
 * died, measured closer to the failure than a branch diff ever gets. That is
 * the sentence a person needs first; the branch is at most a second fact.
 */
function concreteCause(outcome: string): string {
  const t = (outcome || "").trim();
  return t && t !== Work.RESTART_PLACEHOLDER ? t : "";
}

/** Lead with the real cause when there is one, and only then — as a second
 *  clause, not a replacement — say what the branch shows. */
function leadWithCause(cause: string, branchTheory: string): string {
  if (!cause) return branchTheory;
  const rest = branchTheory.charAt(0).toLowerCase() + branchTheory.slice(1);
  return `${cause} — and ${rest}`;
}

export async function settleAbandoned(): Promise<Settled[]> {
  if (!gitFn) return [];
  const out: Settled[] = [];
  let rows: Work.WorkRun[] = [];
  try { rows = Work.runs(200).filter((r) => r.state === "abandoned"); } catch { return []; }
  for (const r of rows) {
    if (!r.repo || !r.branch) continue;
    const left = await leftBehind(r.repo, r.branch, { id: r.id, tipSha: r.tipSha });
    const cause = concreteCause(r.outcome);
    if (left.kind === "merged") {
      Work.restampRun(r.id, "done", leadWithCause(cause, left.says));
      out.push({ runId: r.id, title: r.title, verdict: "landed" });
    } else if (left.kind === "unmerged") {
      /* This one really is waiting, and ON HOLD is the right word for it. The
         outcome says how much is waiting and where, which the original never
         could — it was written before anybody looked. */
      Work.restampRun(r.id, "abandoned", leadWithCause(cause, left.says));
      out.push({ runId: r.id, title: r.title, verdict: "waiting" });
    } else {
      /*
       * Nothing to build from — and two ways to arrive here, so the row says
       * which one. Either the branch is gone (merged and tidied, swept as
       * empty, or thrown away), or it is still there and nothing was ever
       * committed on it, which `leftBehind` now tells apart by the reflog. The
       * old text asserted the first one every time, so a register entry for a
       * run that died before its first commit read as if somebody had already
       * merged it.
       *
       * AND A THIRD WAY, checked first: a run that never got the chance to
       * write anything down, because the tool it needed to run tests or
       * install packages was not on this machine. Measured: a run threw
       * `ENOENT: no such file or directory, posix_spawn 'bun'`, its worktree
       * was empty because it died before its first commit, and the row that
       * came out the other end of this exact branch said the branch was
       * gone — three sentences, none of which named `bun`. Asking whether
       * `bun` is reachable right now is a real answer to "what killed this",
       * not a theory, and it beats the branch guess whenever it fires.
       */
      const missingBun = !bunCheckFn();
      const theory = left.says
        || (missingBun
          ? `\`bun\` — which a run needs for \`bun install\` and \`bun test\` — could not be found on this machine: ${NO_BUN()}`
          /* NO LONGER "the server restarted". This settles rows abandoned for
             any reason, and it asserted a crash for every one it could not
             explain — including runs that ended on their own with nothing
             committed, whose empty branch the barren sweep had just removed.
             Measured on three rows in a row this afternoon, while the server
             had been up the whole time: the sentence sent me looking for a
             restart that never happened. What is known here is that the
             branch is gone. */
          : `the branch it worked on (${r.branch}) is gone — merged and tidied, swept as empty, or thrown away. There is nothing left to build from and nothing was queued again.`);
      Work.restampRun(r.id, "empty", leadWithCause(cause, theory));
      out.push({ runId: r.id, title: r.title, verdict: "nothing" });
    }
  }
  return out;
}

/** What an interrupted run's branch is holding: nothing, work that has already
 *  landed, or commits still only on that branch. */
async function leftBehind(repo: string, branch: string, run?: { id: number; tipSha?: string }):
  Promise<{ kind: "nothing" | "merged" | "unmerged"; commits: number; says: string }> {
  const nothing = { kind: "nothing" as const, commits: 0, says: "" };
  if (!repo || !branch || !gitFn) return nothing;
  const git = gitFn;
  try {
    const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
    if (!exists.ok) {
      /*
       * THE BRANCH IS GONE, AND THAT IS NOT THE SAME AS UNSTARTED.
       *
       * Measured today: a run's branch was merged by hand and then deleted —
       * `git branch -d`, which refuses anything unmerged — and the next sweep
       * read "no branch" as "nothing left to build from", stamped the row
       * `empty` and queued the task again. An agent then spent a shift redoing
       * work that was already in the tree.
       *
       * Whatever the branch pointed at was written down every time anything
       * looked at it. If HEAD contains that commit, the work landed.
       */
      const tip = run?.tipSha ?? "";
      if (tip) {
        const inHead = await git(["merge-base", "--is-ancestor", tip, "HEAD"], repo).catch(() => ({ ok: false, out: "" }));
        if (inHead.ok) {
          return {
            kind: "merged", commits: 0,
            says: `${branch} was merged and then deleted — its work is in the branch it was cut from (${tip.slice(0, 8)}), so nothing was queued again`,
          };
        }
      }
      return nothing;
    }
    /* Where it points now, so the answer survives the branch itself. */
    if (run?.id) Work.rememberTip(run.id, (exists.out || "").trim());
    const ahead = await git(["rev-list", "--count", `HEAD..${branch}`], repo);
    const commits = Number((ahead.out || "").trim()) || 0;
    if (!commits) {
      /*
       * NOTHING AHEAD IS TWO DIFFERENT ANSWERS, AND ONE OF THEM DROPS THE TASK.
       *
       * A branch level with the branch it was cut from is either work that has
       * already been merged, or a run that was killed before it committed
       * anything. Counting commits cannot tell them apart — and calling both
       * of them "merged" is how a task disappears: run 120 was cut short fifty
       * seconds in, its branch was empty because nothing had been written yet,
       * and the row was stamped "nothing was lost" while the task it came from
       * was never queued again. From the outside the queue simply emptied.
       *
       * The reflog is the record of whether the branch ever moved. A branch
       * nobody committed on has exactly one entry — the one `git worktree add`
       * wrote when it created it. That branch is unstarted work, and unstarted
       * work goes back on the queue.
       *
       * An unreadable reflog keeps the old answer on purpose: re-offering
       * merged work is the mistake this whole function exists to avoid, so the
       * uncertain case stays on the side that never redoes anything.
       */
      const moved = await git(["reflog", "show", "--format=%gd", branch], repo).catch(() => ({ ok: false, out: "" }));
      const entries = moved.ok ? (moved.out || "").split("\n").filter((l) => l.trim()).length : 0;
      /* EXACTLY one entry, not "at most one": a reflog that answers with
         nothing at all is not evidence of anything — reflogs can be disabled,
         expired, or unavailable in a worktree — and the unknown case belongs on
         the side that never redoes merged work. */
      if (entries === 1) {
        return {
          kind: "nothing", commits: 0,
          says: `the server restarted while this was running, before it had committed anything — ${branch} is empty, so the task went back on the queue`,
        };
      }
      return {
        kind: "merged", commits: 0,
        says: `the server restarted while this was running, and the work on ${branch} is already in the branch it was cut from — nothing was lost and nothing was queued again`,
      };
    }
    return {
      kind: "unmerged", commits,
      says: `the server restarted while this was running, and it left ${commits} commit${commits === 1 ? "" : "s"} on ${branch} that nobody has merged — the task was NOT queued again, because doing it twice competes with what is already there`,
    };
  } catch {
    return nothing;
  }
}

/**
 * One pass of the timer: find runs nothing is driving, end them, put them back.
 *
 * Exported so a test can run exactly one pass against a clock it controls,
 * rather than waiting two minutes to find out whether the timer works.
 */
export function sweepStalledRuns(now = Date.now()): Recovery[] {
  const out: Recovery[] = [];
  for (const s of Work.stalledRuns(STALL_AFTER_MS, now)) {
    const mins = Math.round((now - s.startedAt) / 60_000);
    Work.finishRun(
      s.id, "abandoned",
      `nothing was driving this any more — it sat unfinished for ${mins} minutes, ` +
      `past the ${Math.round(STALL_AFTER_MS / 60_000)}-minute limit, so the watchdog ended it`,
    );
    const r = requeue({
      itemId: s.itemId,
      why: `it stopped responding and sat unfinished for ${mins} minutes`,
      runId: s.id,
    });
    out.push({
      runId: s.id, title: s.title,
      requeued: r.requeued, askedForHelp: r.askedForHelp, attempts: r.attempts,
    });
  }
  return out;
}

/**
 * IDLE WITH WORK OWED, which is the stall nothing was watching.
 *
 * Measured, and it is what a person watched happen for forty minutes: two runs
 * were killed by a server restart at 16:30:02, `recoverAfterRestart` correctly
 * marked them abandoned and put both tasks back on the queue — and then nothing
 * picked them up. The shift stayed `running` with three tasks waiting and no run
 * in flight, and no hand was raised, because every watcher in this file looks at
 * RUNS and there were none to look at.
 *
 * "We entrust it with a task and it has to be able to finish it" — so the first
 * answer to being idle is not to report it, it is to go back to work.
 */
const IDLE_AFTER_MS = 90_000;

/**
 * How many times a shift may be restarted before the machine admits it cannot.
 *
 * Not zero, because the common cause is a restart and going back to work is the
 * whole point. Not unbounded, because a loop that cannot start dying and being
 * revived every ninety seconds all night is the same silence with more CPU in
 * it. Three, then it says so out loud.
 */
const MAX_RESUMES = 3;

/** Resumes spent, per shift, with what was blocking when they were spent.
 *  Held in memory on purpose: a process restart is itself a fresh start, and
 *  the shift gets its three tries again. */
const resumes = new Map<number, { tries: number; at: number; blocker: string }>();

/**
 * How the watchdog gets the loop going again.
 *
 * A slot rather than an import: the loop is assembled in the route with a dozen
 * closures over the server's own helpers, and reaching for it from here would
 * be a module cycle — which this app has already paid for once, with a window
 * that came up black.
 */
/*
 * And it ANSWERS. The slot was `Promise<unknown>` called as
 * `void resumeFn().catch(...)`, so the loop's own sentence — "no open-project
 * checkout to work in", "hand over a shift first" — was thrown away at the one
 * moment somebody needed it. Worse, `{ ok: false }` RESOLVES, so the `.catch`
 * never ran and a refusal looked exactly like a success.
 *
 * Structural, not imported: the type belongs to the loop and importing it here
 * is the module cycle this slot exists to avoid.
 */
export type ResumeAnswer = { ok?: boolean; error?: string; stopped?: string };
let resumeFn: (() => Promise<ResumeAnswer | unknown>) | null = null;
export function setResumeHook(fn: (() => Promise<ResumeAnswer | unknown>) | null): void { resumeFn = fn; }

/*
 * THE FENCE, as the watchdog can see it.
 *
 * A slot for the same reason as `resumeFn`: resolving it lives in the route
 * file and importing that here is the cycle that once shipped a black window.
 * The value is refreshed by the timer and read synchronously by the sweeps, so
 * a sweep never waits on the filesystem — and `null` means "not known yet",
 * which is treated as "do not second-guess the queue".
 */
/** Why the loop last refused to start, so the hand that goes up can say it. */
let lastRefusal = "";

let fenceFn: (() => Promise<string[]>) | null = null;
let fence: string[] | null = null;
export function setFenceHook(fn: (() => Promise<string[]>) | null): void { fenceFn = fn; }
/** Test seam: set what the fence is without a filesystem behind it. */
export function __setFence(roots: string[] | null): void { fence = roots; }

/** Is this path one the deputy may work in? Unknown fence answers yes: the
 *  queue is the authority until something better is known. */
function insideFence(repo: string): boolean {
  if (!fence) return true;
  return fence.some((r) => r === repo || repo.startsWith(`${r}/`));
}

/**
 * What is owed, split by whether anything could actually take it.
 *
 * `owed()` was `asked().length` and never consulted the fence, while the queue
 * source filters by it — so a task queued for a checkout that has fallen out of
 * the fence was permanently owed and permanently unofferable. Every sweep then
 * saw "idle with work" and spent the whole resume budget on work nobody could
 * hand out, which is how a shift burns its three tries in four minutes and
 * gives up on work it was never going to place.
 */
function owedSplit(): { placeable: number; unplaceable: number } {
  try {
    const rows = asked();
    let placeable = 0, unplaceable = 0;
    for (const r of rows) (insideFence(r.repo) ? placeable++ : unplaceable++);
    return { placeable, unplaceable };
  } catch { return { placeable: 0, unplaceable: 0 }; }
}

/** Whether anything is owed that the fence could actually place. */
function owed(): number {
  return owedSplit().placeable;
}

/** When the shift last did anything — the newest run it started or finished. */
function lastMovedAt(shiftId: number): number {
  let at = 0;
  try {
    for (const r of Work.runs(40)) {
      if (r.shiftId !== shiftId) continue;
      at = Math.max(at, r.startedAt ?? 0, r.finishedAt ?? 0);
    }
  } catch { /* no runs yet */ }
  return at;
}

export type IdleVerdict =
  | { kind: "busy" }
  | { kind: "asleep"; shiftId: number; until: number; why: string }
  | { kind: "woke"; shiftId: number }
  | { kind: "resumed"; shiftId: number; owed: number; try: number }
  | { kind: "gaveup"; shiftId: number; owed: number; asked: string };

/**
 * One pass: is a shift sitting idle with work owed, and what to do about it.
 *
 * Exported so a test can drive it against a clock it controls rather than
 * waiting three minutes to find out whether the timer works.
 */
/** The hand raised when this sweep gives up. Cleared only from the one place
 *  that proves the condition it names is over — see below. */
const IDLE_CANNOT_START_KIND = "idle-cannot-start";

export function sweepIdleShift(now = Date.now()): IdleVerdict {
  const open = Shift.current();
  if (!open || open.state !== "running") return { kind: "busy" };
  /* Something IS running: not idle, whatever else may be wrong with it. That is
     what `sweepStalledRuns` above is for. And it is the one place that PROVES
     the last "I could not get a run going" hand is no longer true — a run is
     not merely queued or hoped for, it is actually going. Clearing it here,
     and nowhere else, is what makes "the deputy cannot start work" mean
     something again the next time it is said, instead of describing whatever
     was true hours ago. */
  if (Work.runningRuns().length) {
    clearHandsOfKind(IDLE_CANNOT_START_KIND);
    return { kind: "busy" };
  }
  /* Asleep on purpose: the session limit was hit and the loop is holding
     until the reset the CLI announced. Not a stall, not a try spent. And the
     moment the hold lapses, the loop is resumed at once — no idle wait, no
     backoff — which is the "and resume" half of sleeping. */
  const napping = Work.heldUntil(now);
  if (napping) return { kind: "asleep", shiftId: open.id, until: napping.until, why: napping.why };
  if (Work.holdLapsed(now) && resumeFn) {
    Work.clearHold(now);
    resumes.delete(open.id);
    void Promise.resolve(resumeFn())
      .then((r) => { const a = (r ?? {}) as ResumeAnswer; lastRefusal = a.ok === false ? String(a.error || a.stopped || "the loop refused and said nothing") : ""; })
      .catch((e) => { lastRefusal = String((e as Error)?.message ?? e).slice(0, 200); });
    return { kind: "woke", shiftId: open.id };
  }
  const { placeable, unplaceable } = owedSplit();
  /*
   * Work it may not place is not work it can be idle ON. Spending the resume
   * budget here is how three tries went in four minutes on tasks queued for a
   * checkout outside the fence — and then the shift gave up on everything.
   * `sweepUnfinishedQueue` says so out loud instead; silence here would turn
   * two wrong alerts into none.
   */
  if (!placeable) return { kind: "busy" };
  const since = lastMovedAt(open.id) || open.startedAt;
  if (now - since < IDLE_AFTER_MS) return { kind: "busy" };

  /*
   * WHAT IS BLOCKING, as a value that can be compared.
   *
   * The budget was three tries and then silence for ever: a shift that gave up
   * at 21:54 was still giving up at 09:00, with the thing that blocked it fixed
   * hours earlier and nothing left that would ever look again. So the tries are
   * spent against a SIGNATURE — how much is owed, how wide the fence is, and
   * the reason the loop last refused — and when that signature changes, the
   * budget starts over. That is the whole of "when what blocked me is gone,
   * carry on", and it needs no timer of its own.
   */
  const blocker = `${placeable}:${fence ? fence.length : "?"}:${lastRefusal}`;
  const spent = resumes.get(open.id);
  const tries = spent && spent.blocker === blocker ? spent.tries : 0;
  /* And a resume that produced a run costs nothing: `lastMovedAt` moving is the
     shift working, which is the opposite of the state this is counting. */
  const moved = spent ? since > spent.at : false;
  const budget = moved ? 0 : tries;

  if (budget < MAX_RESUMES && resumeFn) {
    /*
     * Backed off, so the three tries cover an hour instead of four minutes.
     * IDLE_AFTER_MS, then twice that, then four times.
     */
    const waitFor = IDLE_AFTER_MS * 2 ** budget;
    if (spent && !moved && now - spent.at < waitFor) return { kind: "busy" };
    resumes.set(open.id, { tries: budget + 1, at: now, blocker });
    /* Not awaited: the loop runs for as long as the work takes, and a watchdog
       that waits for it is a watchdog that has stopped watching. The ANSWER is
       kept, because the loop knows why it refused and nothing was reading it. */
    void Promise.resolve(resumeFn())
      .then((r) => {
        const a = (r ?? {}) as ResumeAnswer;
        lastRefusal = a.ok === false ? String(a.error || a.stopped || "the loop refused and said nothing") : "";
      })
      .catch((e) => { lastRefusal = String((e as Error)?.message ?? e).slice(0, 200); });
    return { kind: "resumed", shiftId: open.id, owed: placeable, try: budget + 1 };
  }

  /*
   * IT CANNOT, AND IT SAYS SO WHERE A PERSON WILL SEE IT.
   *
   * Not another grey row behind a bell. `pushUnderstudyStuck` goes out at the
   * urgency freedesktop keeps ON SCREEN until it is dismissed, and it reaches
   * `notify-send` when no window is even open — the same path an approval
   * request uses, because this is the same kind of event: a machine that is
   * stopped until a person does something.
   *
   * THE SHIFT IS LEFT RUNNING, and that is a change from what this did. It
   * used to call `Shift.stop`, after which `Shift.current()` is null and every
   * later sweep returns `busy` — so the deputy could not come back even when
   * the blocker was cleared five minutes later. The shift is already bounded by
   * its own wall clock and its action budget; ending it here bought nothing and
   * cost the only route back. What replaces it is the signature above: point
   * the fence, or queue something placeable, and the next sweep tries again.
   */
  const question = placeable === 1
    ? "One task is queued and I could not get a run going for it."
    : `${placeable} tasks are queued and I could not get a run going for any of them.`;
  const because = lastRefusal ? ` The loop said: ${lastRefusal}` : "";
  const tried = `restarted the work loop ${tries} time${tries === 1 ? "" : "s"} over ` +
    `${Math.round((now - since) / 60_000)} minutes; nothing picked the work up.${because}` +
    " The shift is still open — fix what is blocking it and it will try again on its own.";
  raiseHand({ runId: null, title: "The deputy cannot start work", question, tried, repo: "", kind: IDLE_CANNOT_START_KIND });
  pushUnderstudyStuck("cannot start work", question, tried);
  return { kind: "gaveup", shiftId: open.id, owed: placeable, asked: question };
}

/**
 * A machine that cannot finish what it was given has exactly one obligation
 * left, and it is to say so.
 */
export type OwedVerdict =
  | { kind: "quiet" }
  | { kind: "told"; owed: number; why: string }
  | { kind: "unplaceable"; owed: number; why: string };

/** The hand raised by the branch below. Whether it is still worth saying
 *  again is read from the open record itself — see the comment where it is
 *  checked — not from a counter that has no way to hear that it was
 *  answered. */
const QUEUE_LEFT_BEHIND_KIND = "queue-left-behind";

let toldUnplaceable = 0;

export function sweepUnfinishedQueue(now = Date.now()): OwedVerdict {
  const { placeable, unplaceable } = owedSplit();

  /*
   * WORK QUEUED FOR SOMEWHERE IT MAY NOT GO, which is a different sentence and
   * used to be no sentence at all.
   *
   * The fence is what the queue is filtered by, so a task named against a
   * checkout outside it is owed for ever and offerable never. Counting it with
   * the rest produced "2 tasks are queued and I could not get a run going" —
   * true, useless, and unfixable by anything the reader could do. Said on its
   * own, it names the one action that helps.
   *
   * Reported whether or not a shift is running: this one is not about being
   * idle, it is about work that cannot be reached from where the fence is
   * pointed.
   */
  if (unplaceable && toldUnplaceable !== unplaceable) {
    toldUnplaceable = unplaceable;
    const question = unplaceable === 1
      ? "One task you queued names a checkout I may not work in."
      : `${unplaceable} tasks you queued name checkouts I may not work in.`;
    const tried = "the fence is pointed somewhere else, so nothing can pick them up — point it at that project, "
      + "or queue the work against a checkout inside it";
    raiseHand({ runId: null, title: "Queued work is outside the fence", question, tried, repo: "" });
    pushUnderstudyStuck("queue outside fence", question, tried);
    return { kind: "unplaceable", owed: unplaceable, why: "outside the fence" };
  }
  if (!unplaceable) toldUnplaceable = 0;

  if (Shift.current()) return { kind: "quiet" };
  if (Work.runningRuns().length) return { kind: "quiet" };
  const n = placeable;
  if (!n) return { kind: "quiet" };
  /*
   * The shift that JUST ended, which `current()` cannot hand back — it answers
   * only while one is running, and returns null the moment one stops. Reading
   * it from `current()` was the first version of this and it lost both the
   * reason the shift ended and the moment it did, which are the two things
   * this has to say. Found by running it, not by reading it.
   */
  const last = Shift.recent(1)[0] ?? null;
  /* Only once the dust has settled: a shift ends and the next one is often
     seconds away, and an alert in that gap is noise. */
  const since = last?.stoppedAt || lastMovedAt(last?.id ?? -1) || 0;
  if (since && now - since < IDLE_AFTER_MS) return { kind: "quiet" };
  /*
   * Read from the open record, not a counter that remembered `n` and nothing
   * else. A counter equal to `n` cannot tell "already said, still true" from
   * "was said, then answered, and is true again" — so once a person cleared
   * the hand it stayed silenced for as long as the queue held the same
   * count, which reads as the deputy no longer noticing. An open row is the
   * one thing that means "already said and still unanswered"; the moment
   * it is closed, the next sweep is a fresh silence and says so again.
   */
  if (hasOpenKind(QUEUE_LEFT_BEHIND_KIND)) return { kind: "quiet" };

  const why = last?.stoppedReason
    ? `the shift ended (${last.stoppedReason})`
    : "there is no shift running";
  const question = n === 1
    ? `One task you queued is still waiting, and ${why}.`
    : `${n} tasks you queued are still waiting, and ${why}.`;
  const tried = "the work is untouched and nothing is running — hand over another shift and it will pick it up";
  raiseHand({ runId: null, title: "Your work is still queued", question, tried, repo: "", kind: QUEUE_LEFT_BEHIND_KIND });
  pushUnderstudyStuck("queue left behind", question, tried);
  return { kind: "told", owed: n, why };
}

/**
 * WORKTREES OF RUNS THAT ENDED WITH NOTHING IN THEM.
 *
 * A run gets a worktree and a branch of its own, and an abandoned one kept
 * both for ever — nothing removed the directory. A day of interrupted runs
 * left a checkout list nobody could read: "I keep seeing more wt here". It is
 * the same shape the loop already worries about in as many words, "how
 * somebody ends up with fourteen worktrees and no idea which is which".
 *
 * ONLY THE EMPTY ONES, and empty is asked of git rather than inferred from the
 * outcome: a run marked abandoned can still have committed before it died, and
 * one of them did exactly that today. A branch with a commit on it is
 * somebody's work whatever its run said, so it stays — with its worktree,
 * because a branch nobody can check out is not much of a keepsake.
 */
let gitFn: ((args: string[], cwd: string) => Promise<{ ok: boolean; out: string }>) | null = null;
export function setGitHook(fn: typeof gitFn): void { gitFn = fn; }

/*
 * WHETHER THE AGENT IS STILL THERE, asked of tmux by the caller that can.
 *
 * A run is an agent in a tmux window that outlives this process. When that
 * window goes — the agent exited, somebody closed it, a halt cut it off — the
 * row stayed `running` until `sweepStalledRuns` reached it an hour later.
 * Measured today: a task was recorded as being worked on for forty-five
 * minutes after its window had closed, and while a row says `running` the
 * install refuses, the loop will not start, and the screen says the deputy is
 * busy. An hour of "it is working on it" for a thing that stopped.
 *
 * A hook rather than a tmux call in here, for the same reason as `gitFn`: this
 * module is driven by tests and must not need a tmux socket to be tested.
 */
let aliveFn: ((title: string, paneId?: string) => Promise<boolean>) | null = null;
export function setAliveHook(fn: typeof aliveFn): void { aliveFn = fn; }

/*
 * WHETHER A LOOP IS STANDING IN THAT DIRECTORY RIGHT NOW.
 *
 * Every sweep below decides from the run TABLE, which is written at a run's
 * edges. In between there is a live process holding a checkout, and the table
 * cannot describe it: between the agent leaving and the verdict being written
 * the row is legitimately no longer `running`.
 *
 * Measured three times in one afternoon, in one watchdog tick: the agent's
 * window is gone (true — it exits the moment it has said its last word), so
 * `sweepVanishedRuns` ends the row, `sweepEmptyWorktrees` then sees an ended
 * row with no commits and removes the directory, and the loop — still in there
 * running the suite the work has to pass — dies of `ENOENT … posix_spawn`.
 *
 * A hook, like the others: this module must stay testable without a loop.
 * Unset means "nobody is telling me", which leaves every sweep as it was.
 */
let busyFn: ((worktree: string) => boolean) | null = null;
export function setBusyHook(fn: typeof busyFn): void { busyFn = fn; }
const loopIsIn = (worktree: string) => { try { return !!busyFn?.(worktree); } catch { return true; } };

/** Long enough that a window still being opened is never mistaken for one that
 *  closed: the worktree is cut and the dependencies installed before the agent
 *  starts, and that has taken over a minute on this machine. */
export const VANISHED_GRACE_MS = 3 * 60_000;

/**
 * Runs whose window is gone, ended now instead of in an hour.
 *
 * Fails CLOSED in the only direction that matters: an unreadable tmux, a hook
 * that throws, or no hook at all leaves every row exactly as it is. Declaring a
 * live agent dead would take its worktree out from under it.
 */
export async function sweepVanishedRuns(now = Date.now()): Promise<Recovery[]> {
  if (!aliveFn) return [];
  const out: Recovery[] = [];
  let rows: Work.WorkRun[] = [];
  try { rows = Work.runs(50).filter((r) => r.state === "running"); } catch { return []; }
  for (const r of rows) {
    if (now - r.startedAt < VANISHED_GRACE_MS) continue;
    /* The agent's window really is gone and the loop is still working in its
       checkout — running the suite, reading the diff, writing the verdict.
       Ending the row here is what starts the chain that deletes it. */
    if (loopIsIn(r.worktree)) continue;
    let alive = true;
    try { alive = await aliveFn(r.title, r.paneId); } catch { alive = true; }
    if (alive) continue;
    const mins = Math.round((now - r.startedAt) / 60_000);
    const left = await leftBehind(r.repo, r.branch, { id: r.id, tipSha: r.tipSha });
    if (left.kind === "unmerged") {
      /* Commits nobody has merged: the same answer a restart gets. Not queued
         again — doing it twice competes with what is already on the branch. */
      Work.finishRun(r.id, "abandoned",
        `its window closed after ${mins} minutes and it left ${left.commits} commit${left.commits === 1 ? "" : "s"} on ${r.branch} that nobody has merged`);
      raiseHand({
        runId: r.id, title: r.title, repo: r.repo,
        question: `The agent working on "${r.title}" is gone, and left ${left.commits} commit${left.commits === 1 ? "" : "s"} nobody has looked at.`,
        tried: `The work is on ${r.branch}. Merge it, or throw the branch away and queue the task again.`,
      });
      out.push({ runId: r.id, title: r.title, requeued: false, askedForHelp: true, attempts: 0 });
      continue;
    }
    if (left.kind === "merged") {
      Work.finishRun(r.id, "done",
        `its window closed after ${mins} minutes, and the work on ${r.branch} is already in the branch it was cut from`);
      out.push({ runId: r.id, title: r.title, requeued: false, askedForHelp: false, attempts: 0 });
      continue;
    }
    Work.finishRun(r.id, "failed", `its window closed after ${mins} minutes without committing anything`);
    const q = requeue({ itemId: r.itemId, why: `the agent's window closed after ${mins} minutes with nothing committed`, runId: r.id });
    out.push({ runId: r.id, title: r.title, requeued: q.requeued, askedForHelp: q.askedForHelp, attempts: q.attempts });
  }
  return out;
}

export type SweptTree = {
  runId: number; worktree: string; branch: string;
  /** Set when the directory went but its commits did not: the branch that
   *  still holds them, so the line printed says where the work is. */
  kept?: string;
};

/**
 * The line `sweepEmptyWorktrees` writes into a spared row's outcome, and the
 * only place that knows its own shape — `commitsSpared` below reads it back,
 * and the web panel's discard tooltip reads it back the same way. Kept to one
 * line so it survives sitting above whatever the run already said about
 * itself, and re-derived every sweep rather than trusted stale, so a branch
 * that gains or loses commits between passes gets the current number.
 */
function sparedLine(branch: string, commits: number): string {
  return `Left ${commits} commit${commits === 1 ? "" : "s"} on ${branch} that nobody has merged — the sweep kept the worktree because of them.`;
}
const SPARED_LINE_RE = /^Left \d+ commits? on \S+ that nobody has merged.*$/m;

/** How many commits a previous sweep found still sitting on a spared row's
 *  branch, read back from the line it left in the outcome — 0 if the sweep
 *  never said so, whether because there were none or it hasn't looked yet. */
export function commitsSpared(outcome: string): number {
  const m = /^Left (\d+) commits? on \S+ that nobody has merged/m.exec(outcome || "");
  return m ? Number(m[1]) : 0;
}

export async function sweepEmptyWorktrees(): Promise<SweptTree[]> {
  const git = gitFn;
  if (!git) return [];
  const out: SweptTree[] = [];
  for (const r of Work.endedRunsWithWorktrees()) {
    if (!r.worktree || !r.repo || !existsSync(r.worktree)) continue;
    /*
     * NOT IF SOMEBODY IS IN IT.
     *
     * The path is derived from the branch, which is derived from the task, so
     * the same task cut twice gets the same directory — and this row, ENDED,
     * points at the one the NEW attempt is working in. Measured: the sweep
     * removed it seconds after the cut and the live run died of
     * `ENOENT … posix_spawn 'bun'`, blaming a program that was there all
     * along.
     */
    if (Work.liveRunIn(r.worktree) || loopIsIn(r.worktree)) continue;
    /* Its own commits, counted against the branch it was cut from. `@{u}` is
       not it — these branches have no upstream — so the base is the repo's
       current HEAD, which is where `worktree add … HEAD` put them. */
    const n = await git(["rev-list", "--count", `HEAD..${r.branch}`], r.repo).catch(() => ({ ok: false, out: "" }));
    if (!n.ok) continue;
    const commits = Number(n.out.trim()) || 0;
    /*
     * WHAT THE BRANCH DOES NOT HOLD, ASKED BEFORE ANYTHING IS REMOVED.
     *
     * This question used to be asked only of a branch that HAD commits. A run
     * that wrote code and never committed any of it — the ordinary shape of an
     * agent that ran out of turn, and of every row this register calls
     * `empty` — went down the other path, which asked git nothing and ran
     * `worktree remove --force`. Force is precisely the flag that removes a
     * dirty tree, so the tidy-up deleted the only copy of that work.
     *
     * Both halves of "we must not leave WT that are already finished... but
     * without losing work they have done" are satisfiable, and this is the half
     * with no branch to fall back on: a dirty tree is the only copy, and the
     * only copy is never swept. A `status` that cannot be read is treated as
     * dirty, because the cost of being wrong runs one way.
     */
    const dirty = await git(["status", "--porcelain"], r.worktree).catch(() => ({ ok: false, out: "x" }));
    if (!dirty.ok || dirty.out.trim()) continue;
    if (commits > 0) {
      /* Spared, not ignored: this is the only place that has ever asked git
         how much is on the branch, and the row used to say nothing more than
         "on hold" — the discard tooltip on a `failed` row even claimed there
         was nothing to lose, which this number was already proof against. */
      const line = sparedLine(r.branch, commits);
      const rest = r.outcome.replace(SPARED_LINE_RE, "").trimEnd();
      const outcome = rest ? `${rest}\n${line}` : line;
      if (outcome !== r.outcome) Work.restampRun(r.id, r.state, outcome);

      /*
       * THE DIRECTORY GOES, THE WORK STAYS.
       *
       * A finished run's worktree used to sit there for ever the moment it had
       * a single commit, and after a busy day the checkout list is a screen of
       * names nobody can read — reported twice: "I keep seeing more wt here", and
       * "we must not leave WT that are already finished... but without losing
       * work they have done".
       *
       * Both halves are satisfiable, because git already holds the work: the
       * BRANCH keeps every commit whether or not a directory points at it, and
       * `git worktree add` recreates the directory in a second if anybody wants
       * to look. What a directory holds that the branch does not is
       * UNCOMMITTED work — so that is exactly the test, and it is now asked
       * above, of every row, because the run that never committed anything is
       * the one with no branch to fall back on.
       */
      const freed = await git(["worktree", "remove", "--force", r.worktree], r.repo).catch(() => ({ ok: false, out: "" }));
      if (freed.ok || !existsSync(r.worktree)) {
        out.push({ runId: r.id, worktree: r.worktree, branch: r.branch, kept: r.branch });
      }
      continue;
    }
    const gone = await git(["worktree", "remove", "--force", r.worktree], r.repo).catch(() => ({ ok: false, out: "" }));
    if (!gone.ok && existsSync(r.worktree)) continue;
    /* And the branch, which is now a name for the base commit and nothing
       else. Failure here is not worth a retry: an empty branch is untidy, a
       worktree is the thing that fills a screen. */
    await git(["branch", "-D", r.branch], r.repo).catch(() => ({ ok: false, out: "" }));
    out.push({ runId: r.id, worktree: r.worktree, branch: r.branch });
  }
  return out;
}

/** For a test, and for a shift that ends: forget what it spent. */
export function __forgetResumes(): void { resumes.clear(); }

let timer: ReturnType<typeof setInterval> | null = null;

/** Start looking. Idempotent: calling it twice does not double the sweep. */
export function startUnderstudyWatchdog(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      /* The fence, refreshed for the sweeps that read it synchronously. Not
         awaited: a watchdog that waits on the filesystem is a watchdog that
         has stopped watching, and a value one tick old is the right answer for
         a decision made every thirty seconds. */
      if (fenceFn) void fenceFn().then((r) => { fence = Array.isArray(r) ? r : null; }).catch(() => { /* keep the last one */ });
      for (const r of sweepStalledRuns()) {
        if (r.askedForHelp) {
          console.log(`   Deputy      → "${r.title}" stalled again and is now waiting on you (${MAX_ATTEMPTS} tries)`);
        } else if (r.requeued) {
          console.log(`   Deputy      → "${r.title}" stalled; put back on the queue (try ${r.attempts + 1})`);
        }
      }
      /* And the other shape of stopping: nothing running at all, with work
         owed. Same pass, because a watchdog with two timers is two things that
         can be switched off. */
      /* And the run whose agent is no longer there. Awaited by nobody, for the
         same reason as the worktree sweep below: this asks tmux, and a
         watchdog that waits on a socket has stopped watching. */
      void sweepVanishedRuns().then((gone) => {
        for (const g of gone) {
          console.log(g.askedForHelp
            ? `   Deputy      → "${g.title}" — its window is gone and it left work nobody has merged; waiting on you`
            : `   Deputy      → "${g.title}" — its window is gone; ${g.requeued ? "put back on the queue" : "closed off"}`);
        }
      }).catch(() => { /* a sweep that throws must not stop the tick */ });
      const idle = sweepIdleShift();
      if (idle.kind === "resumed") {
        console.log(`   Deputy      → idle with ${idle.owed} queued; started the loop again (try ${idle.try})`);
      } else if (idle.kind === "gaveup") {
        console.log(`   Deputy      → STUCK: ${idle.asked} — asked for help; the shift stays open and it will try again when something changes`);
      }
      /* And the quietest failure of all: no shift at all, work still queued. */
      /* And the directories the ended ones left behind. Awaited by nobody: a
         sweep that blocks the watchdog is a watchdog that has stopped. */
      void sweepEmptyWorktrees().then((swept) => {
        for (const t of swept) {
          console.log(t.kept
            ? `   Deputy      → freed the worktree of run #${t.runId}; its commits are on ${t.kept}`
            : `   Deputy      → removed the empty worktree of run #${t.runId} (${t.branch})`);
        }
      }).catch(() => { /* the next sweep tries again */ });
      /* And the rows nobody ever went back to: settled once, from git, so the
         register stops showing finished work as though it were pending. */
      void settleAbandoned().then((settled) => {
        for (const s2 of settled) {
          if (s2.verdict === "waiting") console.log(`   Deputy      → #${s2.runId} "${s2.title}" left work on its branch that nobody has merged`);
        }
      }).catch(() => { /* the next sweep tries again */ });
      const owedNow = sweepUnfinishedQueue();
      if (owedNow.kind === "told") {
        console.log(`   Deputy      → ${owedNow.owed} task(s) still queued and ${owedNow.why} — said so`);
      } else if (owedNow.kind === "unplaceable") {
        console.log(`   Deputy      → ${owedNow.owed} task(s) queued for checkouts outside the fence — said so`);
      }
    } catch { /* a watchdog that can throw is one more thing that can stop */ }
  }, SWEEP_EVERY_MS);
  timer.unref?.();
}

export function stopUnderstudyWatchdog(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * The understudy itself saying it cannot, in the middle of a task.
 *
 * Re-exported here so the loop has one obvious place to reach for when the
 * answer is "I do not know" — the alternative it used to take was to finish
 * quietly with nothing, which reads identically to success from outside.
 */
export { raiseHand };

/**
 * A run that ended having delivered nothing, and where a person chose none of it.
 *
 * `failed`, `empty` and `uncommitted` are all judged endings — the loop was
 * alive and wrote a real verdict — but the task itself came out the other side
 * exactly as undone as one killed by a restart, AND it stays marked taken, so
 * nothing was ever going to offer it again. That is the shape of "it stopped
 * half way and said nothing": the run row is honest, and the work silently
 * evaporates.
 *
 * So the same rule applies as everywhere else here: one more go, and then it
 * becomes a question. The judged outcome is what goes in the question, because
 * a person reading "the tests failed twice, here is what it said" can act on it
 * without opening anything.
 */
export function noteUndelivered(p: {
  itemId: string;
  title: string;
  state: "failed" | "empty" | "uncommitted";
  why: string;
  runId?: number | null;
}): Recovery {
  const said = {
    failed: "it finished, but what it produced did not pass",
    empty: "it finished without producing anything",
    uncommitted: "it left work in the worktree that was never committed",
  }[p.state];
  const r = requeue({ itemId: p.itemId, why: `${said}: ${p.why}`, runId: p.runId ?? null });
  return {
    runId: p.runId ?? 0, title: p.title,
    requeued: r.requeued, askedForHelp: r.askedForHelp, attempts: r.attempts,
  };
}
