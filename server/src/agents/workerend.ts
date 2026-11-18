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
 * A TUI TURN ENDS WITHOUT ITS PROCESS. The interactive CLI stays in its pane
 * after a turn, so the seat hears "finished its turn, waiting" (the line that
 * says to answer it) from the transcript's own marker, and the process leaving
 * later is not a second notice: both take the same marker row.
 *
 * THE PROJECT, NOT THE SPELLING. A seat working in a linked worktree beside its
 * project (`~/code/orbit-1042` next to `~/code/orbit`) and a chair seated at
 * the project spell the same project two ways, and the chair's name is a hash
 * of the root it was seated at. So the root is resolved by the git common dir
 * before the seat is looked up (`seat.ts seatHome`), on this side and in
 * `promptSeat`; otherwise the notice is typed to nobody and nothing says so.
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
import { seatHome } from "../seat.ts";
import { reportedSince } from "../seatreport.ts";
import { runOutOfMemory } from "../scopes.ts";
import { promptSeat } from "../seatwake.ts";
import { owesResult } from "../../../shared/workerRoles.ts";
import { answerOf, runFiles } from "./headless.ts";
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
 * its last message (headless.ts `answerOf`) or a report to the seat; a role
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
  const missing = !reportedSince(a.name, a.startedAt) && !answerOf(by.tui, readText(runFiles(a.name).out))?.trim();
  looks.set(a.name, { at: a.startedAt, missing });
  return missing;
}

/**
 * Whether the turn's last message ends with a question for the orchestrator.
 *
 * A scout that has to choose between two plans, or a builder that needs a
 * decision, asks it in its last line. A turn that ends on a question is not
 * dead work: the session it ran in is kept and `agentglass-agent prompt <name>
 * "answer"` resumes it (`policystart.ts resumeTurn`), and the worker's card
 * says it is waiting for an answer.
 *
 * Ceiling: this reads the shape of the last line, not the meaning of the
 * message. A report that ends "no questions." is not a question, and one whose
 * question lost its "?" is not seen. The brief asks a worker to end with the
 * question it needs answered, which is the marker this reads.
 */
export function endsWithQuestion(text: string | null | undefined): boolean {
  const last = (text ?? "").trimEnd().split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return /\?[\s"')\]]*$/.test(last);
}

/* One look per turn: the result is final once the status file exists. */
const answers = new Map<string, { at: number; asking: boolean }>();

/** Whether this finished turn left a question, read once per turn. */
export function awaitingAnswer(a: Pick<AgentOps.NamedAgent, "name" | "startedAt" | "exitCode" | "startedBy">): boolean {
  const by = startedByOf(a);
  if (a.exitCode !== 0 || !by) return false;
  const had = answers.get(a.name);
  if (had && had.at === a.startedAt) return had.asking;
  const asking = endsWithQuestion(answerOf(by.tui, readText(runFiles(a.name).out)));
  answers.set(a.name, { at: a.startedAt, asking });
  return asking;
}

/** The one line the seat is woken with: what ended, how, and for how long. */
export function endLine(
  name: string, ending: Ending, exitCode: number, ms: number, withoutResult = false, oomCeiling: string | null = null,
): string {
  if (withoutResult) return `worker ${name} ended without a result after ${elapsed(ms)}. Read it with \`agentglass-agent read ${name}\` and decide the next step.`;
  const how = oomCeiling
    ? `out of memory (worker ceiling ${oomCeiling})`
    : ending === "failed" ? `failed (exit ${exitCode})` : ending;
  return `worker ${name} ended: ${how} after ${elapsed(ms)}. Read it with \`agentglass-agent read ${name}\` and decide the next step.`;
}

/**
 * The one line for a turn that is over while its worker is not: an interactive
 * Claude turn ends and the CLI stays in its pane, ready for the next one. The
 * seat's move is to answer it, so the line says that and not "ended".
 */
export function waitingLine(name: string): string {
  return `worker ${name} finished its turn, waiting. Answer it with \`agentglass-agent prompt ${name} "..."\` or read it with \`agentglass-agent read ${name}\`.`;
}

export interface EndDeps {
  now?: number;
  /** The send, injected so a suite can watch it without a tmux chair. */
  send?: (root: string, text: string) => Promise<unknown>;
  /** The ceiling that bound the run when the kernel OOM-killed something in
   *  it — both when the shared slice is in use ("7G, shared 20G"), because the
   *  child's counter cannot say which wall fired — or null. Injected so a suite
   *  reads no cgroup. */
  outOfMemory?: (name: string) => string | null;
}

/**
 * Tell the seat that started this worker how its turn ended. Idempotent: the
 * second call for the same ending says nothing and answers false.
 *
 * A failed turn whose scope was OOM killed says so instead of its exit line:
 * the engine's socket dying is the symptom, and ECONNRESET sends the seat
 * looking for a network fault that is not there.
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
  const oom = ending === "failed" ? (deps.outOfMemory ?? runOutOfMemory)(name) : null;
  await (deps.send ?? promptSeat)(seatHome(a.seatRoot), endLine(name, ending, a.exitCode ?? 0, now - a.startedAt, endedWithoutResult(a), oom));
  return true;
}

/**
 * Tell the seat that an interactive turn is over and the worker is waiting for
 * its next one. The same door and the same marker as the ending: claimed here
 * first, so the CLI leaving the pane later is not a second notice for a turn
 * the seat has already heard about.
 */
export async function announceWorkerWaiting(name: string, deps: EndDeps = {}): Promise<boolean> {
  const a = AgentOps.agentNamed(name);
  if (!a || !a.seatRoot || !startedByOf(a)) return false;
  const now = deps.now ?? Date.now();
  /* Claimed before the send, and before the status the folder's watch reads is
     written (tuiturn.ts calls this first): the ending that watch settles must
     not be announced over the top of this. */
  if (claim.run(name, a.startedAt, now).changes === 0) return false;
  prune.run(now - KEEP_MS);
  await (deps.send ?? promptSeat)(seatHome(a.seatRoot), waitingLine(name));
  return true;
}
