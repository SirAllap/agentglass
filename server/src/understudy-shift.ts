/*
 * A shift: standing in, for a bounded while.
 *
 * Everything else in this feature is per-decision, and per-decision is not what
 * "cover for me for an hour" means. A stand-in has to know what it is doing,
 * how long it has, how much it may do, and — the part that decides whether any
 * of this is safe — when to stop and wait rather than carry on being
 * confidently wrong.
 *
 * THE LIMITS ARE WRITTEN DOWN BEFORE IT STARTS, not consulted as it goes. An
 * end time, a budget of actions, and a scope, all fixed at the moment the
 * person hands over. A stand-in that can extend its own shift is not a
 * stand-in; and a policy it evaluates each time is a policy it can be reasoned
 * around by whatever writes the next version of the reasoning.
 *
 * WHY IT STOPS IS RECORDED. Not as a nicety: the first question anybody asks on
 * coming back is "what did it do and why did it quit", and a shift that cannot
 * answer the second half is one nobody can audit. Every exit here writes a
 * reason, including the boring ones.
 */
import { existsSync } from "node:fs";
import { db } from "./db.ts";
import { isHalted, proposeScope } from "./understudy.ts";
import { failedRuns } from "./understudy-work.ts";

export interface Shift {
  id: number;
  goal: string;
  startedAt: number;
  endsAt: number;
  maxActions: number;
  actions: number;
  state: "running" | "done" | "stopped";
  stoppedAt: number | null;
  stoppedReason: string;
  scope: string;
  /** Derived, so the panel never has to do this arithmetic itself. */
  msLeft: number;
  actionsLeft: number;
}

/*
 * The ceiling on a shift, and it is short on purpose.
 *
 * Four hours, ten actions. Not because longer is technically hard but because
 * the evidence for going longer does not exist yet: nothing has watched this
 * thing act unsupervised for any length of time at all. The number should move
 * when there is a reason to move it, and the reason will be a record of shifts
 * that went well — not somebody's confidence on the afternoon they built it.
 */
export const MAX_SHIFT_MS = 4 * 3_600_000;
export const MAX_SHIFT_ACTIONS = 25;

const rowToShift = (r: {
  id: number; goal: string; started_at: number; ends_at: number; max_actions: number;
  actions: number; state: string; stopped_at: number | null; stopped_reason: string; scope: string;
}): Shift => ({
  id: r.id,
  goal: r.goal,
  startedAt: r.started_at,
  endsAt: r.ends_at,
  maxActions: r.max_actions,
  actions: r.actions,
  state: r.state as Shift["state"],
  stoppedAt: r.stopped_at,
  stoppedReason: r.stopped_reason,
  scope: r.scope,
  msLeft: Math.max(0, r.ends_at - Date.now()),
  actionsLeft: Math.max(0, r.max_actions - r.actions),
});

const runningQ = db.query<Parameters<typeof rowToShift>[0], []>(
  "SELECT * FROM understudy_shifts WHERE state = 'running' ORDER BY id DESC LIMIT 1",
);
const oneQ = db.query<Parameters<typeof rowToShift>[0], [number]>(
  "SELECT * FROM understudy_shifts WHERE id = ?",
);
const recentQ = db.query<Parameters<typeof rowToShift>[0], [number]>(
  "SELECT * FROM understudy_shifts ORDER BY id DESC LIMIT ?",
);

/**
 * The shift in progress, if there is one — and it expires itself.
 *
 * The wall is checked on READ rather than by a timer. A timer that has to fire
 * for a limit to hold is a limit that does not hold when the process was asleep,
 * restarted, or busy; asking "is it still within its window" every time anybody
 * looks cannot be missed the same way.
 */
export function current(): Shift | null {
  let r;
  try { r = runningQ.get(); } catch { return null; }
  if (!r) return null;
  const s = rowToShift(r);
  if (s.msLeft <= 0) {
    stop(s.id, "the shift ran out of time");
    return rowToShift(oneQ.get(s.id)!);
  }
  if (s.actionsLeft <= 0) {
    stop(s.id, "it used everything it was given");
    return rowToShift(oneQ.get(s.id)!);
  }
  return s;
}

export function recent(limit = 10): Shift[] {
  try { return recentQ.all(Math.max(1, Math.min(50, limit))).map(rowToShift); } catch { return []; }
}

const startQ = db.query<{ id: number }, [string, number, number, number, string]>(
  `INSERT INTO understudy_shifts (goal, started_at, ends_at, max_actions, scope)
   VALUES (?, ?, ?, ?, ?) RETURNING id`,
);

/**
 * Hand over, for a stated while.
 *
 * Refuses when one is already running. Two concurrent shifts would mean two
 * budgets and two walls over one queue, which is not a limit at all — it is two
 * halves of a limit that add up to more than either.
 */
export function start(goal: string, minutes: number, maxActions: number): { ok: true; shift: Shift } | { ok: false; error: string } {
  /*
   * And no new shift while the stop is pulled.
   *
   * Refusing at the actuator alone would let somebody hand over, watch the
   * queue fill with drafts and nothing act, and have no idea why. The refusal
   * belongs where the handover happens, in the words that say how to lift it.
   */
  if (isHalted()) {
    return { ok: false, error: "you halted it — switch the clone on again before handing over" };
  }
  /*
   * A shift that is `running`, not merely one `current()` handed back.
   *
   * `current()` closes an expired shift and RETURNS IT — deliberately, so the
   * screen can say why it ended rather than showing nothing. `if (current())`
   * read that as "one is already running", so the moment a shift ran out of
   * time no further shift could ever be opened: the loop refuses without one,
   * and the tab offers nothing to stop because nothing is running.
   *
   * Measured: three stopped shifts in the table, none running, and every
   * attempt to hand over answering "a shift is already running — stop that one
   * first". A dead end with instructions that cannot be followed.
   *
   * This is also, almost certainly, the "the handover failed because a shift
   * was already open" that a previous change explained as a missing guard on
   * the single-task route. It was this.
   */
  const live = current();
  if (live && live.state === "running") {
    return { ok: false, error: "a shift is already running — stop that one first" };
  }
  /*
   * NaN WALKS THROUGH Math.min AND Math.max UNCHANGED, and that made a shift
   * that never ended.
   *
   * `Number("abc")` is NaN, `Math.min(MAX, NaN)` is NaN, `Math.max(60_000,
   * NaN)` is NaN — so `endsAt` became NaN, `msLeft` became NaN, and every stop
   * rule asks `msLeft <= 0`, which is FALSE for NaN. Same for the budget. A
   * shift opened with `{"minutes": "abc"}` had no wall and no ceiling: the two
   * things that bound the whole feature, gone, from a request body.
   *
   * Clamping is not validating. A number that is not a number has to be
   * replaced before it reaches arithmetic that treats it as one.
   */
  const asMinutes = Number.isFinite(minutes) ? minutes : 30;
  const asActions = Number.isFinite(maxActions) ? maxActions : 5;
  const ms = Math.max(60_000, Math.min(MAX_SHIFT_MS, Math.round(asMinutes * 60_000)));
  const budget = Math.max(1, Math.min(MAX_SHIFT_ACTIONS, Math.round(asActions)));
  const now = Date.now();
  try {
    const r = startQ.get(goal.slice(0, 400), now, now + ms, budget, proposeScope());
    const s = r ? rowToShift(oneQ.get(r.id)!) : null;
    return s ? { ok: true, shift: s } : { ok: false, error: "could not open a shift" };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}

const stopQ = db.query<never, [string, number, string, number]>(
  "UPDATE understudy_shifts SET state = ?, stopped_at = ?, stopped_reason = ? WHERE id = ? AND state = 'running'",
);

export function stop(id: number, reason: string, state: "done" | "stopped" = "stopped"): void {
  try { stopQ.run(state, Date.now(), reason.slice(0, 400), id); } catch { /* already stopped, then */ }
}

const bumpQ = db.query<never, [number]>(
  "UPDATE understudy_shifts SET actions = actions + 1 WHERE id = ? AND state = 'running'",
);

export function countAction(id: number): void {
  try { bumpQ.run(id); } catch { /* the shift is over; the count no longer matters */ }
}

/*
 * ── when it must stop and wait ─────────────────────────────────────────────
 *
 * The rules that end a shift early, and every one of them is a case where
 * carrying on would mean acting with less evidence than the shift was opened
 * on. They are deliberately blunt: a stand-in that decides for itself whether a
 * stop condition really applies is one that will eventually decide it does not.
 */
export interface StopCheck {
  stop: boolean;
  reason: string;
}

export function shouldStop(s: Shift, opts: { lastFailed?: boolean; pending?: number } = {}): StopCheck {
  if (s.msLeft <= 0) return { stop: true, reason: "the shift ran out of time" };
  if (s.actionsLeft <= 0) return { stop: true, reason: "it used everything it was given" };
  /*
   * One failure ends it. Not three, not a rate — one.
   *
   * A failed action means the world was not what it predicted, and everything
   * queued behind it was drafted against that same wrong picture. Continuing is
   * not resilience, it is compounding a mistake nobody is watching.
   */
  if (opts.lastFailed) return { stop: true, reason: "something it did failed, and the rest was drafted on the same assumption" };
  /*
   * And it stops when nobody is reading what it leaves behind.
   *
   * THE RULE IS THE OLD ONE; ITS SOURCE IS NOT. It used to count unread
   * proposals, from a queue that has never held a single row — so a rule that
   * reads as a safeguard could not fire, whatever happened. What it was
   * guarding against does happen, though, and now has somewhere real to look:
   * a failed run keeps its worktree on purpose, because the worktree is the
   * evidence. Five of those means five directories nobody has opened, and
   * cutting a sixth is talking to an empty room.
   *
   * Counted by whether the worktree is still THERE, not by the row's state.
   * The row says "failed" forever — nothing ever moves it — but the worktree
   * is the evidence, and removing it is how a person already says "read, done
   * with this". A count that trusted the row instead would only ever climb,
   * and the fifth one would brick every shift after it for good, with no
   * button anywhere to bring it back down.
   */
  const pending = opts.pending ?? failedRuns().filter((r) => existsSync(r.worktree)).length;
  if (pending >= 5) return { stop: true, reason: "five failed runs are still on disk and nobody has looked at them" };
  return { stop: false, reason: "" };
}

/**
 * Move a shift's end, so a test can reach the moment one expires.
 *
 * The failure this exists for cannot be provoked any other way: `current()`
 * closes an expired shift and returns it, and `start()` used to read that as
 * "one is already running" — so the first expiry blocked every handover after
 * it, for ever. Waiting out a real shift in a test is not an option, and the
 * minimum is a minute.
 *
 * `__` is this repository's convention for a hatch that exists for a test.
 */
export function __endShiftAt(id: number, endsAt: number): void {
  db.run("UPDATE understudy_shifts SET ends_at = ? WHERE id = ?", [endsAt, id]);
}
