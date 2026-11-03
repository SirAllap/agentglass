/*
 * A WORKER'S END REACHES THE SEAT THAT STARTED IT — once, and only.
 *
 * A seat starts headless workers and hears their reports, but nothing told it
 * when one finished: a done worker sat there until the person noticed.
 * OpenCode cannot message the seat, and this app already knows the fact — the
 * wrapper leaves the turn's exit status (headless.ts) and the watcher that
 * settles the row fires the moment it appears (ceilings.ts).
 *
 * An ending is an EVENT, so it takes the door a report takes (seatwake.ts
 * `promptSeat`) and not a sweep: that module's rule is "wake on a change,
 * never on a clock", and a worker ending is the change. Nothing here ticks.
 *
 * ONCE PER ENDING, ACROSS A RESTART. The marker is a row keyed by the name and
 * the start stamp of the turn, in the database, so one ending seen twice — the
 * watcher and a settling that races it, or a second server after a restart — is
 * one notice. Claimed before it is sent, so a crash between the two loses the
 * notice rather than repeating it. A worker the seat resumes for another turn
 * ends again, and that is a notice of its own: the stamp is new.
 *
 * ONLY THE OWNER IS WOKEN. The root comes from the row's `seat_root`, never
 * from a caller, so a seat that did not start this worker is never told about
 * it; and a finished worker is not an error for the person — no need is filed
 * and no alert raised, whatever the exit code. A role that owes a result and
 * left none says so in the line instead of "done": the turn was wasted, and
 * that is the seat's to see.
 *
 * The brief's report path is not guessed at: a brief is free prose, and the
 * only place a worker says where it wrote is its own transcript, which this
 * does not read. The notice names the worker instead, which is what `read`
 * takes.
 *
 * Ceiling: an ending that happened while the server was away is settled on boot
 * without a notice (policystart.ts `workersAfterRestart`), as it is settled
 * without a report. A worker that outlives the restart is watched, and ends
 * with the same notice as any other.
 */
import { readFileSync } from "node:fs";
import * as AgentOps from "../agentops.ts";
import { db } from "../db.ts";
import { projectRootOf } from "../git.ts";
import { roleOwesResult } from "../rolePrompt.ts";
import { reportedSince } from "../seatreport.ts";
import { promptSeat } from "../seatwake.ts";
import { owesResult } from "../../../shared/workerRoles.ts";
import { reportOf, runFiles } from "./headless.ts";
import { startedByOf } from "./workerstart.ts";

/** How long an ending is remembered. The marker is only ever asked about the
 *  ending happening now; this is housekeeping, not a window of notice. */
const KEEP_MS = 7 * 86_400_000;

db.run(`CREATE TABLE IF NOT EXISTS worker_end (
  name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (name, started_at)
)`);

const claim = db.query<never, [string, number, number]>(
  `INSERT OR IGNORE INTO worker_end (name, started_at, at) VALUES (?, ?, ?)`);
const prune = db.query<never, [number]>(`DELETE FROM worker_end WHERE at < ?`);

export type Ending = "done" | "failed" | "timed out";

/**
 * How the turn ended, from the status the wrapper left. 124 is this app's own
 * code for a turn stopped at its limit (ceilings.ts); 0 is done, and anything
 * else is the engine failing.
 */
export function endingOf(a: { exitCode?: number }): Ending | null {
  if (a.exitCode === undefined) return null;
  if (a.exitCode === 124) return "timed out";
  return a.exitCode === 0 ? "done" : "failed";
}

/** A turn's length as the seat reads it at a glance. */
export function elapsed(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
}

const readText = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

/* One look per turn: the output is final once the status file exists (the
   wrapper moves it into place after the tab drained), and the list is polled. */
const looks = new Map<string, { at: number; missing: boolean }>();

/**
 * Whether a clean turn left nothing to read. The result of a headless turn is
 * its last message (headless.ts `reportOf`) or a report to the seat; a role
 * that owes one and left neither has failed at the only thing it was for.
 *
 * A turn that failed is not this: it already reaches the seat as a report and a
 * need, and saying "no result" over the top of that hides the exit code.
 */
export function endedWithoutResult(a: Pick<AgentOps.NamedAgent, "name" | "startedAt" | "cwd" | "exitCode" | "startedBy" | "seatRoot">): boolean {
  const by = startedByOf(a);
  if (a.exitCode !== 0 || !by) return false;
  if (!owesResult(by.role) && !roleOwesResult(a.seatRoot ?? projectRootOf(a.cwd) ?? a.cwd, by.role)) return false;
  const had = looks.get(a.name);
  if (had && had.at === a.startedAt) return had.missing;
  // An engine that frames its answer can frame an empty one: Claude's last
  // frame is a result whatever the model said, so whitespace is no result.
  const missing = !reportedSince(a.name, a.startedAt) && !reportOf(readText(runFiles(a.name).out))?.trim();
  looks.set(a.name, { at: a.startedAt, missing });
  return missing;
}

/** The one line the seat is woken with: what ended, how, and for how long. */
export function endLine(name: string, ending: Ending, exitCode: number, ms: number, withoutResult = false): string {
  if (withoutResult) return `worker ${name} ended without a result after ${elapsed(ms)}. Read it with \`agentglass-agent read ${name}\` and decide the next step.`;
  const how = ending === "failed" ? `failed (exit ${exitCode})` : ending;
  return `worker ${name} ended: ${how} after ${elapsed(ms)}. Read it with \`agentglass-agent read ${name}\` and decide the next step.`;
}

export interface EndDeps {
  now?: number;
  /** The send, injected so a suite can watch it without a tmux chair. */
  send?: (root: string, text: string) => Promise<unknown>;
}

/**
 * Tell the seat that started this worker how its turn ended. Idempotent: the
 * second call for the same ending says nothing and answers false.
 */
export async function announceWorkerEnd(name: string, deps: EndDeps = {}): Promise<boolean> {
  const a = AgentOps.agentNamed(name);
  const ending = a ? endingOf(a) : null;
  /* No row, no owner, or no status: a worker still on its turn, one stopped by
     hand (the row ends without a status), or one that is not a policy worker at
     all. None of those is an ending to announce. */
  if (!a || !a.seatRoot || !ending || !startedByOf(a)) return false;
  const now = deps.now ?? Date.now();
  if (claim.run(name, a.startedAt, now).changes === 0) return false;
  prune.run(now - KEEP_MS);
  await (deps.send ?? promptSeat)(a.seatRoot, endLine(name, ending, a.exitCode ?? 0, now - a.startedAt, endedWithoutResult(a)));
  return true;
}
