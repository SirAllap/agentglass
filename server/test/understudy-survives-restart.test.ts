/**
 * The understudy must not lose work when the server goes away, and must not go
 * quiet when it cannot finish.
 *
 * Measured before this existed, over 108 real runs: 80 delivered a branch and
 * 26 delivered nothing. Six of those 26 died because the server restarted under
 * them — every one a task he had queued by hand, marked taken, and never
 * offered again. Five sat unfinished for over 45 minutes with nothing looking,
 * the worst for 513. Not one of the 26 said what it needed.
 *
 * Each test below fails against the code as it was.
 */
import { test, expect, beforeEach } from "bun:test";
import { db } from "../src/db.ts";
import * as Work from "../src/understudy-work.ts";
import { ask, asked, requeue, MAX_ATTEMPTS } from "../src/understudy-sources-work.ts";
import {
  recoverAfterRestart, sweepStalledRuns, STALL_AFTER_MS,
  sweepIdleShift, sweepUnfinishedQueue, setResumeHook, __forgetResumes, __setFence, setGitHook, settleAbandoned,
  sweepVanishedRuns, setAliveHook, VANISHED_GRACE_MS,
} from "../src/understudy-watchdog.ts";
import * as Shift from "../src/understudy-shift.ts";
import { openRequests, raiseHand, markAnswered, helpHistory } from "../src/understudy-help.ts";

const REPO = "/tmp/understudy-restart-probe";

beforeEach(() => {
  db.exec("DELETE FROM understudy_work");
  db.exec("DELETE FROM understudy_asked");
  db.exec("DELETE FROM understudy_help");
  db.exec("DELETE FROM understudy_shifts");
  /*
   * AND THE GIT HOOK, because it is a module global and the file next door
   * sets it.
   *
   * `recoverAfterRestart` asks git what an interrupted run left before
   * deciding whether to queue it again, so a neighbour's hook that answers
   * "this branch has commits" turns every requeue here into a hand raised
   * instead. Measured: these two tests passed alone and failed beside
   * `understudy-sweep-spares-commits.test.ts`, in either order — the shape
   * that costs an hour because each file is innocent on its own.
   *
   * A branch that does not exist is the state these tests are about: a run
   * killed with nothing left behind.
   */
  setGitHook(async () => ({ ok: false, out: "" }));
});

/** A queued task, and a run of it that is still going. */
function taskInFlight(title: string) {
  const askedId = ask({ title, detail: "what he wrote underneath", repo: REPO });
  expect(askedId).toBeGreaterThan(0);
  const runId = startRunFor(askedId!, title);
  return { askedId: askedId!, itemId: `asked:${askedId}`, runId };
}

/** Begin a run of an already-queued task, the way the loop does — `beginRun`
 *  tells the source it is taken, so nothing here has to fake that. */
function startRunFor(askedId: number, title: string): number | null {
  return Work.beginRun({
    shiftId: 1,
    item: {
      id: `asked:${askedId}`, source: "asked", title,
      detail: "what he wrote underneath", repo: REPO, weight: 20,
    },
    repo: REPO, worktree: `${REPO}/wt`, branch: "feat/probe",
  });
}

test("a task interrupted by a restart goes BACK ON THE QUEUE, not into the void", async () => {
  const t = taskInFlight("Something he queued by hand");

  // It is taken, so nothing would offer it again.
  expect(asked().some((r) => r.id === t.askedId)).toBe(false);

  const recovered = await recoverAfterRestart();

  expect(recovered.length).toBe(1);
  expect(recovered[0]!.requeued).toBe(true);
  const back = asked().find((r) => r.id === t.askedId);
  expect(back, "THE TASK WAS LOST: a restart marked it abandoned and nothing put it back").toBeTruthy();
  expect(back!.detail).toBe("what he wrote underneath");
});

test("the run itself is still recorded as abandoned — the history stays honest", async () => {
  const t = taskInFlight("Interrupted");
  await recoverAfterRestart();
  const run = Work.runs(10).find((r) => r.id === t.runId);
  expect(run!.state).toBe("abandoned");
  expect(Work.runningRuns().length).toBe(0);
});

test("a task that keeps dying stops being retried and becomes a QUESTION", async () => {
  const t = taskInFlight("The one that never works");

  // Two restarts: allowed.
  await recoverAfterRestart();
  expect(asked().some((r) => r.id === t.askedId)).toBe(true);

  startRunFor(t.askedId, "The one that never works");
  await recoverAfterRestart();
  expect(asked().some((r) => r.id === t.askedId)).toBe(true);

  // The third is not an accident any more.
  startRunFor(t.askedId, "The one that never works");
  const third = await recoverAfterRestart();

  expect(third[0]!.askedForHelp, "IT WOULD HAVE LOOPED FOR EVER on the same broken task").toBe(true);
  expect(third[0]!.requeued).toBe(false);

  const open = openRequests();
  expect(open.length).toBe(1);
  expect(open[0]!.title).toBe("The one that never works");
  expect(open[0]!.question).toContain("needs a person");
  expect(open[0]!.tried).toContain("what he wrote underneath");
});

test("a run nothing is driving is ended WITHOUT waiting for the next restart", () => {
  const t = taskInFlight("The one that hangs");
  const longAgo = Date.now() - (STALL_AFTER_MS + 60_000);
  db.exec("UPDATE understudy_work SET started_at = ? WHERE id = ?", [longAgo, t.runId]);

  const swept = sweepStalledRuns();

  expect(swept.length, "A HUNG RUN SAT FOR 513 MINUTES because only a restart ever looked").toBe(1);
  expect(Work.runningRuns().length).toBe(0);
  const run = Work.runs(10).find((r) => r.id === t.runId);
  expect(run!.state).toBe("abandoned");
  expect(run!.outcome).toContain("watchdog");
  expect(asked().some((r) => r.id === t.askedId)).toBe(true);
});

test("a run still inside its time is left completely alone", () => {
  const t = taskInFlight("Working away right now");
  expect(sweepStalledRuns().length).toBe(0);
  expect(Work.runningRuns().length).toBe(1);
  const run = Work.runs(10).find((r) => r.id === t.runId);
  expect(run!.state).toBe("running");
});

test("raising the same hand twice is one question, not a counter climbing", () => {
  const a = raiseHand({ title: "Same problem", question: "I need the token", repo: REPO });
  const b = raiseHand({ title: "Same problem", question: "I need the token", repo: REPO });
  expect(a).toBe(b);
  expect(openRequests().length).toBe(1);
});

test("the same hand raised again takes the NEWER wording, keeping its date", () => {
  /*
   * Dedupe used to return the existing id without writing, so the second,
   * richer question was thrown away: "The deputy cannot start work" kept its
   * first, vaguest sentence all night while every later run knew more.
   */
  const a = raiseHand({ title: "The deputy cannot start work", question: "it will not start", tried: "looked at the log", repo: REPO });
  const b = raiseHand({
    title: "The deputy cannot start work",
    question: "no shift is open and the queue holds two tasks",
    tried: "restarted the work loop, read the ledger",
    repo: REPO,
  });

  expect(b).toBe(a);
  const firstAt = openRequests()[0]!.at;
  const open = openRequests();
  expect(open.length, "still ONE question, not two").toBe(1);
  expect(open[0]!.question, "THE NEWER TEXT WAS DROPPED").toBe("no shift is open and the queue holds two tasks");
  expect(open[0]!.tried).toContain("read the ledger");
  expect(open[0]!.at, "raised when it was first raised").toBe(firstAt);
});

test("a repeat with nothing to add does not wipe what the first one tried", () => {
  const id = raiseHand({ title: "Same problem", question: "I need the token", tried: "read the env", repo: REPO })!;
  raiseHand({ title: "Same problem", question: "I still need the token", repo: REPO });
  const open = openRequests();
  expect(open[0]!.id).toBe(id);
  expect(open[0]!.question).toBe("I still need the token");
  expect(open[0]!.tried, "the only evidence a person can act on").toBe("read the env");
});

test("an answered question is not refreshed — a new one is asked instead", () => {
  const id = raiseHand({ title: "Closed one", question: "first ask", repo: REPO })!;
  markAnswered(id);
  const again = raiseHand({ title: "Closed one", question: "second ask", repo: REPO })!;
  expect(again).not.toBe(id);
  expect(openRequests().length).toBe(1);
});

test("an answered question stops being open but stays in the history", () => {
  const id = raiseHand({ title: "Answer me", question: "which database?", repo: REPO })!;
  markAnswered(id);
  expect(openRequests().length).toBe(0);
  expect(helpHistory().some((h) => h.id === id && h.answeredAt !== null)).toBe(true);
});

test("a source that cannot be put back says so instead of pretending", () => {
  const r = requeue({ itemId: "clickup:12345", why: "the server restarted" });
  expect(r.requeued).toBe(false);
  expect(r.askedForHelp).toBe(false);
});

test("the attempt limit is the one the queue and the watchdog both mean", () => {
  expect(MAX_ATTEMPTS).toBe(2);
});

/*
 * IDLE WITH WORK OWED — the stall that nothing was watching.
 *
 * Measured, and watched happen for forty minutes: a server restart killed two
 * runs at 16:30:02, `recoverAfterRestart` correctly marked them abandoned and
 * put both tasks back on the queue, and then NOTHING picked them up. The shift
 * stayed `running` with three tasks waiting, no run in flight, and no hand
 * raised — because every watcher in that file looks at RUNS, and there were
 * none left to look at.
 *
 * "We entrust it with a task and it has to be able to finish it. And if it
 * can't because it got stuck, it should say so." Both halves are here: it
 * goes back to work by itself first, and only when it cannot does it say so.
 */
test("a shift sitting idle with work queued starts the loop again by itself", () => {
  __forgetResumes();
  const shift = Shift.start("probe", 30, 5);
  expect(shift.ok).toBe(true);
  const id = (shift as { shift: { id: number } }).shift.id;
  ask({ title: "something to do", detail: "", repo: REPO });

  let resumed = 0;
  setResumeHook(async () => { resumed++; });

  /* Nothing has moved since the shift began, and nothing is running. That is
     the state a restart leaves behind. */
  const soon = sweepIdleShift(Date.now() + 30_000);
  expect(soon.kind, "half a minute is not a stall, it is a pause").toBe("busy");
  expect(resumed).toBe(0);

  const later = sweepIdleShift(Date.now() + 5 * 60_000);
  expect(later.kind).toBe("resumed");
  expect(resumed, "it went back to work without anybody pressing anything").toBe(1);
  expect(Shift.current()?.state).toBe("running");
  Shift.stop(id, "probe over");
  setResumeHook(null);
});

test("a run in flight is not idle, however long it has been going", () => {
  __forgetResumes();
  const shift = Shift.start("probe", 30, 5);
  const id = (shift as { shift: { id: number } }).shift.id;
  const t = taskInFlight("in flight");
  expect(t.runId).toBeGreaterThan(0);
  let resumed = 0;
  setResumeHook(async () => { resumed++; });
  /* `sweepStalledRuns` owns this case and ends it with a real outcome. Starting
     a second loop on top of a live one is how two agents end up in one
     worktree. */
  expect(sweepIdleShift(Date.now() + 60 * 60_000).kind).toBe("busy");
  expect(resumed).toBe(0);
  Shift.stop(id, "probe over");
  setResumeHook(null);
});

test("and after three goes it stops pretending and asks out loud — with the shift still open", () => {
  __forgetResumes();
  const shift = Shift.start("probe", 30, 5);
  const id = (shift as { shift: { id: number } }).shift.id;
  ask({ title: "the one it cannot start", detail: "", repo: REPO });
  setResumeHook(async () => { /* a loop that starts and does nothing */ });

  /*
   * A CLOCK THAT MOVES, because the tries are backed off now: the first waits
   * out the idle window, the second twice that, the third four times. Three
   * tries back to back used to burn the whole budget in four minutes of a
   * sixty-minute shift, which is why a shift could give up before anybody had
   * a chance to answer it.
   */
  let t = Date.now() + 30 * 60_000;
  const step = () => (t += 8 * 60_000);
  expect(sweepIdleShift(step()).kind).toBe("resumed");
  expect(sweepIdleShift(step()).kind).toBe("resumed");
  expect(sweepIdleShift(step()).kind).toBe("resumed");

  const gave = sweepIdleShift(step());
  expect(gave.kind, "three tries is the budget").toBe("gaveup");

  /* It asked, in a way a person can answer. */
  const open = openRequests();
  expect(open.length).toBe(1);
  expect(open[0]!.question).toContain("queued");
  expect(open[0]!.tried, "and it says what it already tried").toContain("restarted the work loop");

  /*
   * AND THE SHIFT STAYS OPEN. It used to be stopped here, and that is the line
   * that cost a night: `Shift.current()` is null afterwards, so every later
   * sweep returns `busy` and the deputy cannot come back even when the thing
   * blocking it is fixed five minutes later. Measured on the real app — a shift
   * that gave up at 21:54 was still given up at 09:00, holding two tasks, with
   * the cause long gone.
   *
   * Nothing is lost by leaving it: a shift is bounded by its own wall clock and
   * its action budget. What it buys is the way back.
   */
  const now = Shift.current();
  expect(now?.id, "the shift was ended and there is no route back").toBe(id);
  expect(now?.state).toBe("running");
  setResumeHook(null);
});

test("and it tries again by itself when what was blocking it changes", () => {
  /*
   * The whole point of the budget being spent against a SIGNATURE. A person
   * points the fence, or queues something that can actually be placed, and the
   * next sweep starts over — no timer, no button, no restart.
   */
  __forgetResumes();
  const shift = Shift.start("probe", 30, 5);
  const id = (shift as { shift: { id: number } }).shift.id;
  ask({ title: "the one it cannot start", detail: "", repo: REPO });
  let resumed = 0;
  setResumeHook(async () => { resumed++; return { ok: false, error: "no open-project checkout to work in" }; });

  let t = Date.now() + 30 * 60_000;
  const step = () => (t += 8 * 60_000);
  sweepIdleShift(step()); sweepIdleShift(step()); sweepIdleShift(step());
  expect(sweepIdleShift(step()).kind, "budget spent").toBe("gaveup");
  expect(resumed).toBe(3);

  /* Something changes: another task arrives, so the blocker is not what it was. */
  ask({ title: "a second one", detail: "", repo: REPO });
  expect(sweepIdleShift(step()).kind, "it did not try again when the ground moved").toBe("resumed");
  expect(resumed).toBe(4);

  Shift.stop(id, "probe over");
  setResumeHook(null);
});

test("work queued outside the fence never spends a resume", () => {
  /*
   * It used to: `owed()` counted every queued row and the queue source filters
   * by the fence, so three tries went in four minutes on work that could not
   * be handed out by anything. And then the shift gave up on all of it.
   */
  __forgetResumes();
  const shift = Shift.start("probe", 30, 5);
  const id = (shift as { shift: { id: number } }).shift.id;
  ask({ title: "somewhere else entirely", detail: "", repo: "/nowhere/near/the/fence" });
  let resumed = 0;
  setResumeHook(async () => { resumed++; });
  __setFence(["/home/someone/code/inside"]);

  expect(sweepIdleShift(Date.now() + 30 * 60_000).kind).toBe("busy");
  expect(resumed, "it spent a try on work it could never place").toBe(0);

  __setFence(null);
  Shift.stop(id, "probe over");
  setResumeHook(null);
});

test("with nothing queued, an idle shift is just an idle shift", () => {
  __forgetResumes();
  const shift = Shift.start("probe", 30, 5);
  const id = (shift as { shift: { id: number } }).shift.id;
  let resumed = 0;
  setResumeHook(async () => { resumed++; });
  expect(sweepIdleShift(Date.now() + 60 * 60_000).kind).toBe("busy");
  expect(resumed, "nothing to do is not a stall").toBe(0);
  Shift.stop(id, "probe over");
  setResumeHook(null);
});

/*
 * THE SHIFT ENDED AND THE WORK IS STILL SITTING THERE.
 *
 * The commonest silence of all, and it was still uncovered after the idle
 * detector went in — found by watching the real thing, not by reading it. A
 * shift is bounded by a wall clock. It runs out of time, gets marked `stopped`,
 * and any task still queued stays queued forever, because every other watcher
 * requires a shift that is RUNNING and there is no longer one.
 *
 * Measured on the real database: three tasks queued at 16:24, the shift's
 * ninety minutes expired at 17:54, and at 18:06 the queue still held all three
 * with no run, no shift, and no hand raised. Nothing was broken. It had simply
 * stopped, quietly, holding work somebody was waiting on.
 */
test("a shift that runs out of time with work queued says so", () => {
  __forgetResumes();
  const shift = Shift.start("probe", 30, 5);
  expect(shift.ok, JSON.stringify(shift)).toBe(true);
  const id = (shift as { shift: { id: number } }).shift.id;
  expect(Shift.current()?.state, 'the probe shift must be running').toBe('running');
  ask({ title: "still waiting", detail: "", repo: REPO });

  /* While it is running, this is not its business — the idle sweep owns that. */
  expect(sweepUnfinishedQueue(Date.now() + 60 * 60_000).kind).toBe("quiet");

  Shift.stop(id, "the shift ran out of time");
  /* And not the instant it stops: the next shift is often seconds away, and an
     alert in that gap is noise. */
  expect(sweepUnfinishedQueue(Date.now() + 5_000).kind).toBe("quiet");

  const told = sweepUnfinishedQueue(Date.now() + 10 * 60_000);
  expect(told.kind).toBe("told");
  const open = openRequests();
  expect(open.length).toBe(1);
  expect(open[0]!.question).toContain("still waiting");
  expect(open[0]!.question, "and it says WHY it stopped").toContain("ran out of time");
});

test("it says it once, not once every two minutes all night", () => {
  __forgetResumes();
  const shift = Shift.start("probe", 30, 5);
  Shift.stop((shift as { shift: { id: number } }).shift.id, "the shift ran out of time");
  ask({ title: "one thing", detail: "", repo: REPO });
  const far = () => Date.now() + 20 * 60_000;
  expect(sweepUnfinishedQueue(far()).kind).toBe("told");
  expect(sweepUnfinishedQueue(far()).kind, "the second sweep is silent").toBe("quiet");
  expect(sweepUnfinishedQueue(far()).kind).toBe("quiet");
  expect(openRequests().length, "and one hand, not thirty").toBe(1);
});

test("nothing queued after a shift ends is not a failure", () => {
  __forgetResumes();
  const shift = Shift.start("probe", 30, 5);
  Shift.stop((shift as { shift: { id: number } }).shift.id, "done");
  expect(sweepUnfinishedQueue(Date.now() + 60 * 60_000).kind).toBe("quiet");
  expect(openRequests().length).toBe(0);
});

test("a run whose work is already merged is not queued again", async () => {
  /*
   * "If that work is already done... we must not do it again."
   *
   * Measured on the real ledger: nineteen runs killed by a restart, and not one
   * had work still missing — two branches sat there already merged, seventeen
   * had been merged and deleted. Putting those back on the queue asks an agent
   * to spend twenty minutes redoing what is already in the tree.
   */
  const item = { source: "asked", id: "asked:9001", title: "already landed", detail: "", repo: REPO, weight: 1 };
  ask({ title: item.title, detail: "", repo: REPO });
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-x`, branch: "feat/landed" });
  expect(run).toBeGreaterThan(0);

  /* A branch that exists and is level with HEAD: merged, nothing ahead. */
  setGitHook(async (args) => {
    if (args[0] === "rev-parse") return { ok: true, out: "abc123" };
    if (args[0] === "rev-list") return { ok: true, out: "0\n" };
    return { ok: true, out: "" };
  });

  const before = asked().length;
  const recovered = await recoverAfterRestart();
  expect(recovered.some((r) => r.runId === run), "the run was not recovered at all").toBe(true);
  expect(recovered.find((r) => r.runId === run)?.requeued, "it queued work that is already done").toBe(false);
  expect(asked().length, "the queue grew").toBe(before);

  setGitHook(async () => ({ ok: true, out: "" }));
});

test("and one that left commits nobody merged raises a hand instead", async () => {
  const item = { source: "asked", id: "asked:9002", title: "left work behind", detail: "", repo: REPO, weight: 1 };
  ask({ title: item.title, detail: "", repo: REPO });
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-y`, branch: "feat/unmerged" });

  setGitHook(async (args) => {
    if (args[0] === "rev-parse") return { ok: true, out: "def456" };
    if (args[0] === "rev-list") return { ok: true, out: "3\n" };
    return { ok: true, out: "" };
  });

  const recovered = await recoverAfterRestart();
  const mine = recovered.find((r) => r.runId === run);
  /* Not queued — doing it twice competes with what is already on the branch —
     and not silent either, because three commits nobody has looked at is
     exactly the thing a person needs told. */
  expect(mine?.requeued).toBe(false);
  expect(mine?.askedForHelp).toBe(true);
  expect(openRequests().some((r) => (r.tried || "").includes("feat/unmerged"))).toBe(true);

  setGitHook(async () => ({ ok: true, out: "" }));
});

test("an interrupted run gets a verdict from git, not a shrug for ever", async () => {
  /*
   * The register read twelve rows of ON HOLD — "the server restarted while
   * this was running, nobody was left to record how it ended" — for work
   * finished, merged and tidied hours earlier: "it gives the impression that
   * something is half done". Nothing was half done; the second half of the sentence was
   * never written, and git could answer it at any time.
   */
  const item = { source: "asked", id: "asked:9100", title: "landed long ago", detail: "", repo: REPO, weight: 1 };
  const landed = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-a`, branch: "feat/settled-merged" });
  const item2 = { source: "asked", id: "asked:9101", title: "still on its branch", detail: "", repo: REPO, weight: 1 };
  const waiting = Work.beginRun({ shiftId: 1, item: item2, repo: REPO, worktree: `${REPO}-b`, branch: "feat/settled-unmerged" });
  const item3 = { source: "asked", id: "asked:9102", title: "branch is gone", detail: "", repo: REPO, weight: 1 };
  const gone = Work.beginRun({ shiftId: 1, item: item3, repo: REPO, worktree: `${REPO}-c`, branch: "feat/settled-gone" });
  for (const id of [landed, waiting, gone]) Work.finishRun(id!, "abandoned", "the server restarted while this was running");

  setGitHook(async (args, _cwd) => {
    const ref = String(args[args.length - 1] ?? "");
    if (args[0] === "rev-parse") return { ok: !ref.includes("settled-gone"), out: ref.includes("settled-gone") ? "" : "sha" };
    if (args[0] === "rev-list") return { ok: true, out: ref.includes("unmerged") ? "2\n" : "0\n" };
    return { ok: true, out: "" };
  });

  const settled = await settleAbandoned();
  const by = (id: number | null) => settled.find((s) => s.runId === id)?.verdict;
  expect(by(landed), "merged work still reading as pending").toBe("landed");
  expect(by(waiting), "work still only on its branch is the one case that IS pending").toBe("waiting");
  expect(by(gone), "a branch that is gone left nothing to build from").toBe("nothing");

  const rows = Work.runs(50);
  expect(rows.find((r) => r.id === landed)?.state, "landed work should read as approved").toBe("done");
  expect(rows.find((r) => r.id === waiting)?.state).toBe("abandoned");
  expect(rows.find((r) => r.id === gone)?.state).toBe("empty");

  setGitHook(async () => ({ ok: true, out: "" }));
});

test("and settling a row does not move the date it is filed under", async () => {
  const item = { source: "asked", id: "asked:9103", title: "old work", detail: "", repo: REPO, weight: 1 };
  const id = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-d`, branch: "feat/settled-date" });
  Work.finishRun(id!, "abandoned", "the server restarted while this was running");
  const before = Work.runs(50).find((r) => r.id === id)?.finishedAt;

  setGitHook(async (args) => (args[0] === "rev-parse" ? { ok: true, out: "sha" } : { ok: true, out: "0\n" }));
  await settleAbandoned();
  /* A register entry is dated the day the work happened, not the day somebody
     worked out what became of it. */
  expect(Work.runs(50).find((r) => r.id === id)?.finishedAt).toBe(before);

  setGitHook(async () => ({ ok: true, out: "" }));
});

/*
 * "THE DEPUTY CANNOT START WORK" IS PERMANENT UNTIL SOMETHING CLEARS IT.
 *
 * `markAnswered` has exactly one caller — a person, clicking — and
 * `raiseHand` returns the SAME open row untouched on every later raise. So
 * the first time this hand went up, it stayed up: a person answering it did
 * nothing, because nothing ever raised it again to notice the answer had
 * landed, and nothing else was watching for the condition it named to end.
 *
 * The one place that PROVES the condition is over is `sweepIdleShift`'s own
 * busy branch, the moment it finds a run genuinely going — not a give-up
 * path, and not a title match, because a requeue's give-up hand is filed
 * under the user's OWN task title and a title match would land on it by
 * accident.
 */
test("a run actually going clears \"the deputy cannot start work\" by itself", () => {
  __forgetResumes();
  const shift = Shift.start("probe", 30, 5);
  const id = (shift as { shift: { id: number } }).shift.id;
  ask({ title: "the one it cannot start", detail: "", repo: REPO });
  setResumeHook(async () => { /* a loop that starts and does nothing */ });

  let t = Date.now() + 30 * 60_000;
  const step = () => (t += 8 * 60_000);
  sweepIdleShift(step()); sweepIdleShift(step()); sweepIdleShift(step());
  const gave = sweepIdleShift(step());
  expect(gave.kind).toBe("gaveup");
  expect(openRequests().some((r) => r.title === "The deputy cannot start work")).toBe(true);

  // A run is now actually going — the one thing that proves the hand's
  // question is no longer true.
  const runId = startRunFor(-1, "unrelated work now in flight");
  expect(runId).toBeGreaterThan(0);

  const now = sweepIdleShift(step());
  expect(now.kind, "a run in flight is busy, not idle").toBe("busy");
  expect(
    openRequests().some((r) => r.title === "The deputy cannot start work"),
    "THE HAND STAYED UP after the condition it named was already over",
  ).toBe(false);
  expect(helpHistory().some((r) => r.title === "The deputy cannot start work" && r.answeredAt !== null)).toBe(true);

  Work.finishRun(runId!, "done", "");
  Shift.stop(id, "probe over");
  setResumeHook(null);
});

test("a give-up hand is never cleared by a run starting elsewhere", () => {
  /*
   * `requeue`'s give-up hand is filed under the TASK's own title, and it is a
   * question only a person gets to close — the task really has failed twice,
   * and a run of something else going does not change that. It must not share
   * a `kind` with the auto-cleared hand above.
   */
  const t = taskInFlight("keeps dying");
  requeue({ itemId: t.itemId, why: "broke again", runId: t.runId });
  requeue({ itemId: t.itemId, why: "broke again" });
  const gaveUp = requeue({ itemId: t.itemId, why: "broke a third time" });
  expect(gaveUp.askedForHelp).toBe(true);
  expect(openRequests().some((r) => r.title === "keeps dying")).toBe(true);

  const runId = startRunFor(-2, "something else entirely");
  const shift = Shift.start("probe", 30, 5);
  sweepIdleShift(Date.now());
  expect(
    openRequests().some((r) => r.title === "keeps dying"),
    "a give-up hand was cleared by an unrelated run — it is not this sweep's to close",
  ).toBe(true);

  Work.finishRun(runId!, "done", "");
  Shift.stop((shift as { shift: { id: number } }).shift.id, "probe over");
});

/*
 * ANSWERING "YOUR WORK IS STILL QUEUED" USED TO SILENCE IT FOR EVER.
 *
 * `toldAbout` remembered only the queue's SIZE, so once a person answered the
 * hand it stayed quiet for as long as the queue held the same count — a
 * person clearing it saw nothing come back, which reads as the deputy having
 * stopped noticing rather than having been answered.
 */
test("answering \"your work is still queued\" re-arms the telling", () => {
  __forgetResumes();
  const shift = Shift.start("probe", 30, 5);
  Shift.stop((shift as { shift: { id: number } }).shift.id, "the shift ran out of time");
  ask({ title: "one thing", detail: "", repo: REPO });
  const far = () => Date.now() + 20 * 60_000;

  const first = sweepUnfinishedQueue(far());
  expect(first.kind).toBe("told");
  expect(sweepUnfinishedQueue(far()).kind, "still open — said once, not twice").toBe("quiet");

  const openId = openRequests().find((r) => r.title === "Your work is still queued")!.id;
  markAnswered(openId);

  const again = sweepUnfinishedQueue(far());
  expect(again.kind, "THE COUNTER STAYED SILENT because the queue size had not changed").toBe("told");
  expect(openRequests().some((r) => r.title === "Your work is still queued" && r.id !== openId)).toBe(true);
});

/*
 * MEASURED, 27 Aug: run 120 started, the app restarted fifty seconds later, and
 * the row was stamped "the work is already in the branch it was cut from —
 * nothing was lost and nothing was queued again". Nothing had been committed:
 * the branch was level with its base because the agent had not written a line
 * yet. The task was never queued again and the queue simply emptied — the exact
 * shape of "el clon no funciona" from outside.
 *
 * Commits ahead cannot tell "merged" from "never started". The reflog can.
 */
test("a run cut short before its first commit goes back on the queue", async () => {
  const askedId = ask({ title: "never got going", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "never got going", detail: "", repo: REPO, weight: 1 };
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-n`, branch: "feat/never-committed" });

  setGitHook(async (args) => {
    if (args[0] === "rev-parse") return { ok: true, out: "sha" };
    if (args[0] === "rev-list") return { ok: true, out: "0\n" };
    // One entry: what `git worktree add -b` writes, and nothing since.
    if (args[0] === "reflog") return { ok: true, out: "feat/never-committed@{0}\n" };
    return { ok: true, out: "" };
  });

  const recovered = await recoverAfterRestart();
  const mine = recovered.find((r) => r.runId === run);
  expect(mine?.requeued, "an unstarted task was dropped instead of queued again").toBe(true);
  expect(mine?.askedForHelp).toBe(false);

  setGitHook(async () => ({ ok: true, out: "" }));
});

test("but a branch that was merged and tidied is still not done twice", async () => {
  const askedId = ask({ title: "landed already", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "landed already", detail: "", repo: REPO, weight: 1 };
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-m`, branch: "feat/already-merged" });

  setGitHook(async (args) => {
    if (args[0] === "rev-parse") return { ok: true, out: "sha" };
    if (args[0] === "rev-list") return { ok: true, out: "0\n" };
    // Created, then committed on: the branch moved before it was merged.
    if (args[0] === "reflog") return { ok: true, out: "feat/already-merged@{0}\nfeat/already-merged@{1}\n" };
    return { ok: true, out: "" };
  });

  const recovered = await recoverAfterRestart();
  expect(recovered.find((r) => r.runId === run)?.requeued, "merged work must never be offered again").toBe(false);

  setGitHook(async () => ({ ok: true, out: "" }));
});


/*
 * THE RUN WHOSE AGENT IS NO LONGER THERE.
 *
 * Measured today: a run's tmux window closed and the row said `running` for
 * three quarters of an hour — the install refuses while a run is going, the
 * loop will not start another, and the screen says the deputy is busy. The
 * hour-long stall sweep was the only thing that would ever notice.
 *
 * Every case here drives the sweep against a hook that answers the way tmux
 * would, because the bug is entirely about what happens when the answer is no.
 */
const away = (id: number, minutes: number) =>
  db.query("UPDATE understudy_work SET started_at = ? WHERE id = ?").run(Date.now() - minutes * 60_000, id);

test("a run whose window is gone with nothing committed goes back on the queue", async () => {
  const askedId = ask({ title: "window closed, nothing done", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "window closed, nothing done", detail: "", repo: REPO, weight: 1 };
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-v1`, branch: "feat/vanished-empty" })!;
  away(run, 10);
  setGitHook(async (args) => {
    if (args[0] === "rev-parse") return { ok: true, out: "sha" };
    if (args[0] === "rev-list") return { ok: true, out: "0\n" };
    if (args[0] === "reflog") return { ok: true, out: "feat/vanished-empty@{0}\n" };
    return { ok: true, out: "" };
  });
  setAliveHook(async () => false);

  const gone = await sweepVanishedRuns();
  expect(gone.find((g) => g.runId === run)?.requeued, "a dead run's task was neither finished nor queued again").toBe(true);
  expect(Work.runs(20).find((r) => r.id === run)?.state).toBe("failed");

  setAliveHook(null); setGitHook(async () => ({ ok: true, out: "" }));
});

test("one that left commits raises a hand instead, and is not done twice", async () => {
  const askedId = ask({ title: "window closed, work left", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "window closed, work left", detail: "", repo: REPO, weight: 1 };
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-v2`, branch: "feat/vanished-work" })!;
  away(run, 10);
  setGitHook(async (args) => {
    if (args[0] === "rev-parse") return { ok: true, out: "sha" };
    if (args[0] === "rev-list") return { ok: true, out: "2\n" };
    return { ok: true, out: "" };
  });
  setAliveHook(async () => false);

  const gone = await sweepVanishedRuns();
  expect(gone.find((g) => g.runId === run)?.requeued).toBe(false);
  expect(gone.find((g) => g.runId === run)?.askedForHelp).toBe(true);
  expect(openRequests().some((r) => (r.tried || "").includes("feat/vanished-work"))).toBe(true);

  setAliveHook(null); setGitHook(async () => ({ ok: true, out: "" }));
});

test("an agent that IS there is left alone, and so is one that has just started", async () => {
  const askedId = ask({ title: "still going", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "still going", detail: "", repo: REPO, weight: 1 };
  const live = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-v3`, branch: "feat/still-going" })!;
  away(live, 10);
  const askedId2 = ask({ title: "just started", detail: "", repo: REPO })!;
  const item2 = { source: "asked", id: `asked:${askedId2}`, title: "just started", detail: "", repo: REPO, weight: 1 };
  const young = Work.beginRun({ shiftId: 1, item: item2, repo: REPO, worktree: `${REPO}-v4`, branch: "feat/just-started" })!;

  setAliveHook(async (title) => title === "still going");
  const gone = await sweepVanishedRuns();
  expect(gone.some((g) => g.runId === live), "a live agent was declared dead").toBe(false);
  /* The young one's window may not exist YET — the worktree is cut and the
     dependencies installed before the agent starts. */
  expect(gone.some((g) => g.runId === young), "a run inside its grace period was swept").toBe(false);
  expect(VANISHED_GRACE_MS).toBeGreaterThanOrEqual(60_000);

  setAliveHook(null);
});

test("and a hook that cannot answer changes nothing at all", async () => {
  const askedId = ask({ title: "tmux is unreachable", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "tmux is unreachable", detail: "", repo: REPO, weight: 1 };
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-v5`, branch: "feat/unknown" })!;
  away(run, 10);
  setAliveHook(async () => { throw new Error("no socket"); });

  expect(await sweepVanishedRuns()).toEqual([]);
  expect(Work.runs(20).find((r) => r.id === run)?.state, "an unreachable tmux killed a row").toBe("running");

  setAliveHook(null);
});

/*
 * MERGED, THEN TIDIED AWAY.
 *
 * Measured today: a run's branch was merged by hand and deleted with
 * `git branch -d` — which refuses anything unmerged, so the deletion is itself
 * proof the work landed. The next sweep saw no branch, read that as "nothing
 * left to build from", and queued the task again. An agent then started
 * redoing work that was already in the tree, which is the one thing he has
 * said twice must never happen.
 *
 * The tip is written down every time anything reads the branch, so the answer
 * outlives the branch.
 */
test("a branch that was merged and then deleted is landed work, not unstarted", async () => {
  const askedId = ask({ title: "merged and tidied", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "merged and tidied", detail: "", repo: REPO, weight: 1 };
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-t`, branch: "feat/tidied" })!;

  // First look: the branch is still there, two commits on it.
  setGitHook(async (args) => {
    if (args[0] === "rev-parse") return { ok: true, out: "abcdef1234\n" };
    if (args[0] === "rev-list") return { ok: true, out: "2\n" };
    return { ok: true, out: "" };
  });
  Work.finishRun(run, "abandoned", "the server restarted while this was running");
  await settleAbandoned();
  expect(Work.runs(20).find((r) => r.id === run)?.tipSha, "nothing wrote down where the branch pointed").toBe("abcdef1234");

  // Now it is merged and gone: rev-parse fails, and HEAD contains that commit.
  const asked_ = new Set<string>();
  setGitHook(async (args) => {
    if (args[0] === "rev-parse") return { ok: false, out: "" };
    if (args[0] === "merge-base") { asked_.add(args.join(" ")); return { ok: true, out: "" }; }
    return { ok: true, out: "" };
  });
  await settleAbandoned();

  const row = Work.runs(20).find((r) => r.id === run);
  expect(row?.state, "merged work was filed as if nobody had started it").toBe("done");
  expect([...asked_].some((a) => a.includes("abcdef1234")), "the recorded tip was never used").toBe(true);
  expect(asked().some((a) => a.title === "merged and tidied"), "merged work went back on the queue").toBe(false);

  setGitHook(async () => ({ ok: true, out: "" }));
});

/*
 * A FAILED RUN USED TO HIDE ITS TASK FOR EVER.
 *
 * Measured today, in his database: two rows in `understudy_asked` with
 * `taken_at` cleared — the queue's own word for "pending again" — while the
 * screen showed an empty queue and nothing was running. Their runs had failed,
 * and the "is this spoken for" count treated a failed run as somebody working
 * on it. Putting a task back is always deliberate, so the count has no business
 * contradicting it.
 */
test("a task put back after a failed run is offered again", async () => {
  const askedId = ask({ title: "failed once, still wanted", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "failed once, still wanted", detail: "", repo: REPO, weight: 1 };
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-f`, branch: "feat/failed-once" })!;
  expect(asked().some((a) => a.id === askedId), "a running task is not offered twice").toBe(false);

  Work.finishRun(run, "failed", "its window closed without committing anything");
  const r = requeue({ itemId: item.id, why: "the window closed", runId: run });
  expect(r.requeued).toBe(true);

  expect(asked().some((a) => a.id === askedId), "put back, and still invisible: nothing would ever work on it").toBe(true);
});

/*
 * THE RUN THAT OUTLIVED THE SERVER.
 *
 * A run is an agent in a tmux window, and that window does not care that the
 * server restarted. Measured this afternoon: the recovery closed the row —
 * "nobody was left to record how it ended" — while the agent went on running
 * the suite in its worktree, and with no row to see, the watchdog started a
 * SECOND attempt at the same task in a worktree beside it. Two agents, one
 * task, and a register that showed neither.
 */
test("a run whose agent survived the restart keeps its row instead of being buried", async () => {
  const askedId = ask({ title: "still going after the restart", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "still going after the restart", detail: "", repo: REPO, weight: 1 };
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-alive`, branch: "feat/still-alive" })!;

  setAliveHook(async (title) => title === "still going after the restart");
  const recovered = await recoverAfterRestart();

  const mine = recovered.find((r) => r.runId === run);
  expect(mine?.adopted, "the surviving agent's row was buried").toBe(true);
  expect(mine?.requeued, "and its task was offered to a second agent").toBe(false);
  expect(Work.runs(20).find((r) => r.id === run)?.state).toBe("running");
  expect(asked().some((a) => a.id === askedId)).toBe(false);

  setAliveHook(null);
});

test("but one whose window is gone is recovered exactly as before", async () => {
  const askedId = ask({ title: "gone with the restart", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "gone with the restart", detail: "", repo: REPO, weight: 1 };
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-gone`, branch: "feat/gone-with-it" })!;

  setGitHook(async () => ({ ok: false, out: "" }));   // no branch: nothing was left
  setAliveHook(async () => false);
  const recovered = await recoverAfterRestart();

  expect(recovered.find((r) => r.runId === run)?.adopted).toBeFalsy();
  expect(recovered.find((r) => r.runId === run)?.requeued).toBe(true);

  setAliveHook(null); setGitHook(async () => ({ ok: true, out: "" }));
});

test("and with no way to ask, nothing is adopted — the old behaviour stands", async () => {
  const askedId = ask({ title: "cannot ask about this one", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "cannot ask about this one", detail: "", repo: REPO, weight: 1 };
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-noask`, branch: "feat/no-ask" })!;

  setAliveHook(null);
  setGitHook(async () => ({ ok: false, out: "" }));
  const recovered = await recoverAfterRestart();
  expect(recovered.find((r) => r.runId === run)?.adopted).toBeFalsy();

  setGitHook(async () => ({ ok: true, out: "" }));
});

/*
 * THE NAME WAS NOT AN IDENTITY.
 *
 * Aliveness was asked as "is there a tmux window called `understudy: <title>`".
 * tmux renames a window when the program inside sets a title, so one rename
 * turned a working agent into a dead one: the row was ended, the empty-worktree
 * sweep deleted the directory under it, and the run died of
 * `ENOENT … posix_spawn 'bun'` sixteen minutes in — blaming a program that was
 * there all along. Twice, on two different tasks.
 *
 * The pane id is written down when the run starts and survives every rename.
 */
test("aliveness is asked of the pane, not of a window name that can change", async () => {
  const askedId = ask({ title: "renamed by its own program", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "renamed by its own program", detail: "", repo: REPO, weight: 1 };
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-p`, branch: "feat/renamed" })!;
  Work.rememberPane(run, "%42");
  db.query("UPDATE understudy_work SET started_at = ? WHERE id = ?").run(Date.now() - 10 * 60_000, run);

  /* The hook is handed the pane and answers on it. The title it is also given
     no longer matches anything, which is exactly the case that used to kill it. */
  const asked_: { title: string; pane?: string }[] = [];
  setAliveHook(async (title, paneId) => { asked_.push({ title, pane: paneId }); return paneId === "%42"; });

  expect(await sweepVanishedRuns()).toEqual([]);
  expect(Work.runs(20).find((r) => r.id === run)?.state, "a live agent was swept because its window had been renamed").toBe("running");
  expect(asked_.some((a) => a.pane === "%42"), "the pane id never reached the check").toBe(true);

  setAliveHook(null);
});

test("a run from before pane ids were recorded still falls back to the name", async () => {
  const askedId = ask({ title: "no pane on record", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "no pane on record", detail: "", repo: REPO, weight: 1 };
  const run = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-q`, branch: "feat/no-pane" })!;
  db.query("UPDATE understudy_work SET started_at = ? WHERE id = ?").run(Date.now() - 10 * 60_000, run);

  const seen: (string | undefined)[] = [];
  setAliveHook(async (_title, paneId) => { seen.push(paneId); return true; });
  await sweepVanishedRuns();
  expect(seen.some((p) => !p), "an old row must still be asked about, by name").toBe(true);

  setAliveHook(null);
});

/*
 * THE DIRECTORY UNDER A LIVE RUN.
 *
 * A worktree's path is derived from the branch, which is derived from the
 * task, so the same task cut twice gets the SAME directory. The ended row of
 * the first attempt therefore points at the directory the second attempt is
 * working in — and the sweep, reading that old row, removed it seconds after
 * the cut. The live run then died of
 *
 *     ENOENT: no such file or directory, posix_spawn '…/bun'
 *
 * sixty-five seconds in, blaming a program that was there all along. Twice, on
 * the same task, on two different days.
 */
test("a worktree with a run still in it is not swept, however old the other row is", async () => {
  const askedId = ask({ title: "cut twice", detail: "", repo: REPO })!;
  const item = { source: "asked", id: `asked:${askedId}`, title: "cut twice", detail: "", repo: REPO, weight: 1 };
  const shared = `${REPO}-cut-twice`;

  /* The first attempt: ended, and still pointing at that path. */
  const first = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: shared, branch: "feat/cut-twice" })!;
  Work.finishRun(first, "failed", "it threw");
  /* The second: running, in the same directory, because the name is a hash of
     the task. */
  const second = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: shared, branch: "feat/cut-twice" })!;

  expect(Work.liveRunIn(shared)?.id, "the sweep has no way to see the live run").toBe(second);
  expect(Work.liveRunIn(`${REPO}-somewhere-else`)).toBeNull();

  /* And an ended row on its own is still sweepable — the guard must not turn
     into "never sweep anything". */
  Work.finishRun(second, "done", "finished");
  expect(Work.liveRunIn(shared)).toBeNull();
});
