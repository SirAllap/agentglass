/*
 * The ceiling on one worker's turn, and the moment it ends.
 *
 * Two things hang on one worker, and both are EVENTS, never a poll:
 *   - a timer for the turn limit, armed when the turn starts, and
 *   - a watch on the worker's run folder, which fires when the wrapper
 *     writes its exit status (headless.ts).
 * Whichever comes first settles the row. Nothing here ticks: a worker that
 * ends on its own is noticed the instant its status file appears, and a
 * worker that does not is stopped when its minutes run out.
 *
 * STOPPING IS THE TREE, NOT THE GROUP. Measured by hand on Claude and OpenCode: a
 * command their Bash tool started lives in a session of its own and outlives
 * a SIGTERM to the engine's process group. So the tree is walked from the
 * window's pane by parent, every process is signalled by PID (a pattern could
 * match somebody else's work), and only then is the window closed.
 *
 * ONE TIMEOUT PER TURN. It is set to the deadline when the turn starts and
 * cleared when the turn ends or the worker is let go; nothing looks again in
 * between. Measured on the version that looked every 60 ms until a status
 * showed up: 18 timeouts a second for one worker, about thirty thousand reads
 * over a thirty-minute turn. The wrapper moves its status into place whole
 * (headless.ts), so the event that comes with it is enough.
 *
 * A NAME IS NOT A WORKER. Names are reused: a stopped worker's name can be a
 * person's own tab a minute later. So a timer remembers the pane and the start
 * stamp of the turn it was armed for, every path that lets a name go clears it
 * (agentops.ts `onLetGo`), and at the deadline the row is read again and
 * nothing is stopped unless it is still that turn. Measured before this: a
 * tab enlisted under a stopped worker's name came back 124 "timeout".
 *
 * In memory on purpose, and NOT put back after a restart. Pane and window ids
 * start again from zero when tmux does, so an id kept from before can be
 * somebody's restored tab; stopping by one is the mistake this file will not
 * make. A worker that was still on its turn when the server came back is
 * marked "ceiling lost: restarted" instead (policystart.ts
 * `workersAfterRestart`): its end is still watched, its minutes are not.
 */
import { existsSync, watch, type FSWatcher } from "node:fs";
import type { EventEmitter } from "node:events";
import * as AgentOps from "../agentops.ts";
import { tmux } from "../tmuxpane.ts";
import { addReport } from "../seatreport.ts";
import { wakeForReport } from "../seatwake.ts";
import { turnResult, type RunFiles } from "./headless.ts";

export interface ArmOpts {
  /** Epoch ms at which the turn is over its limit. Null: only the turn's end
   *  is watched, which is what is left of a ceiling after a restart. */
  deadline: number | null;
  limitMinutes: number;
  files: RunFiles;
  /** The turn ended by itself (any exit code); its row is settled by now. */
  ended: (name: string) => void | Promise<void>;
  /** Who to wake with the report. Injected so a test can count wakes. */
  wake?: (root: string, from: string) => Promise<unknown>;
}

interface Armed {
  deadline: number | null; timer: ReturnType<typeof setTimeout> | null; watcher: FSWatcher | null;
  /** The turn this was armed for: a name alone can be somebody else by now. */
  paneId: string; startedAt: number;
}
const armed = new Map<string, Armed>();

export const armedDeadline = (name: string): number | null => armed.get(name)?.deadline ?? null;

export function disarm(name: string): void {
  const w = armed.get(name);
  if (!w) return;
  armed.delete(name);
  if (w.timer) clearTimeout(w.timer);
  try { w.watcher?.close(); } catch { /* already closed */ }
}
// A stop, a start under the same name, a tab enlisted under it: each lets the name go.
AgentOps.onLetGo(disarm);

/** What a restart does to this module's memory. For tests. */
export function __dropTimers(): void { for (const n of armed.keys()) disarm(n); }

export function arm(a: AgentOps.NamedAgent, o: ArmOpts): void {
  disarm(a.name);
  const me: Armed = { deadline: o.deadline, watcher: null, timer: null, paneId: a.paneId, startedAt: a.startedAt };
  if (o.deadline !== null) {
    me.timer = setTimeout(() => { void overLimit(a.name, me, o); }, Math.max(0, o.deadline - Date.now()));
    me.timer.unref?.();
  }
  armed.set(a.name, me);
  try {
    /* Any event in the folder, not only the status file's: the watch folds
       what happens together into one event under the first name, and an engine
       that complains on stderr and exits is exactly that (measured: 90 of 300
       statuses missed when only its own name counted, 0 when any did). A
       turn's output makes events all along; each costs one look for a file. */
    me.watcher = watch(o.files.dir, () => { if (existsSync(o.files.rc)) void check(a.name, me, o); });
    (me.watcher as unknown as EventEmitter).on("error", () => {});
  } catch { /* no folder to watch: the timer still stands */ }
  // The turn may have ended before the watch was up: one look, and no other.
  void check(a.name, me, o);
}

/** The row this timer was armed for, or null once the name is another turn's
 *  or nobody's: then the timer is dropped and nothing else happens. */
function mine(name: string, me: Armed): AgentOps.NamedAgent | null {
  if (armed.get(name) !== me) return null;
  const row = AgentOps.agentNamed(name);
  if (row && row.paneId === me.paneId && row.startedAt === me.startedAt) return row;
  disarm(name);
  return null;
}

/** Something happened to the status file: settle the row from it if it is there. */
async function check(name: string, me: Armed, o: ArmOpts): Promise<void> {
  const row = mine(name, me);
  if (!row) return;
  const r = turnResult(o.files, row.kind);
  if (!r) return;
  disarm(name);
  AgentOps.settleTurn(row, r);
  await o.ended(name);
}

async function overLimit(name: string, me: Armed, o: ArmOpts): Promise<void> {
  const row = mine(name, me);
  if (!row) return;
  // It ended in the same moment: that is an exit, not a timeout.
  if (turnResult(o.files, row.kind)) return check(name, me, o);
  disarm(name);
  // Closed without a status: it was stopped, or its window is gone. Nothing to stop, nothing to say.
  if (row.exitCode !== undefined || row.endedAt !== null) return;
  // The row first: whatever the dying wrapper writes after this is ignored.
  AgentOps.settleTurn(row, { exitCode: 124, line: `timeout: still running after ${o.limitMinutes} minutes, so it was stopped` });
  await killTree(row);
  const root = row.seatRoot;
  if (!root) return;
  addReport({
    root, agent: name,
    text: [
      `STATE: stopped after ${o.limitMinutes} minutes: the turn limit`,
      `BLOCKED: it ran past the limit and was killed; whatever it wrote is in ${row.cwd}`,
      "NEED: decide whether to start it again with a smaller task, continue from its files, or drop it",
      "COST: one decision",
    ].join("\n"),
  });
  await (o.wake ?? wakeForReport)(root, name);
}

/** Every process under the pane, the pane's own included, leaves first. */
async function paneTree(paneId: string): Promise<number[]> {
  const asked = await tmux(["display-message", "-p", "-t", paneId, "#{pane_pid}"]);
  const root = Number(asked.stdout.trim());
  if (!asked.ok || !Number.isInteger(root) || root < 2) return [];
  const ps = Bun.spawnSync(["ps", "-e", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
  const pairs = ps.stdout.toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const found = [root];
  for (let i = 0; i < found.length; i++) for (const [p, pp] of pairs) if (pp === found[i] && !found.includes(p)) found.push(p);
  return found.reverse();
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const signal = (pids: number[], sig: NodeJS.Signals): void => { for (const p of pids) { try { process.kill(p, sig); } catch { /* gone */ } } };

/** Stop a worker: TERM to its tree by PID, close the window, KILL what is
 *  still there after a moment. The tree is who answers to the pane by parent
 *  at that instant: a process that forked twice and was handed to init is not
 *  in it, and is the next thing after this that is not here. */
export async function killTree(a: AgentOps.NamedAgent): Promise<number[]> {
  const pids = await paneTree(a.paneId);
  signal(pids, "SIGTERM");
  await AgentOps.stopAgent(a, Date.now(), true);
  await Bun.sleep(300);
  signal(pids.filter(alive), "SIGKILL");
  return pids;
}
