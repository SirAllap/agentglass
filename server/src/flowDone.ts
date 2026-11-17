/*
 * Which flow roles have reported done for a task, kept so the server can hold
 * a later role to the flow (shared/flowEnforce.ts). The task is a worktree:
 * every role of one card runs in the same folder.
 *
 * CEILING: a predecessor that reported in a DIFFERENT worktree is not matched:
 * the key is the folder, so a hand-off across worktrees reads as "not done".
 * flow.enforce is off by default. Rows are dropped when the worktree is removed
 * (clearTask), so a stale done never opens the gate for a later card that
 * reuses the same folder.
 */
import { db } from "./db.ts";
import { flowHold, type FlowHold } from "../../shared/flowEnforce.ts";
import { getSetting } from "./preflightStore.ts";
import { readFlow } from "./flow.ts";

db.run(`CREATE TABLE IF NOT EXISTS flow_done (root TEXT NOT NULL, task TEXT NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (root, task, role))`);

export const enforceOn = (root: string): boolean => getSetting(root, "flow.enforce") === true;

export function markDone(root: string, task: string, role: string, at = Date.now()): void {
  db.query(`INSERT OR REPLACE INTO flow_done (root, task, role, at) VALUES (?, ?, ?, ?)`).run(root, task, role, at);
}

/** Forget every done for the worktree at `task`: it is gone, so the next card there starts clean. */
export function clearTask(task: string): void {
  db.query(`DELETE FROM flow_done WHERE task = ?`).run(task);
}

export function doneRoles(root: string, task: string): Set<string> {
  return new Set(db.query<{ role: string }, [string, string]>(`SELECT role FROM flow_done WHERE root = ? AND task = ?`).all(root, task).map((r) => r.role));
}

/** The refusal for a worker of `role` finishing `task` in `root`, or null: setting off, no role, or the step before is done. */
export function holdFor(root: string | undefined, role: string | undefined, task: string): FlowHold | null {
  if (!root || !role || !enforceOn(root)) return null;
  return flowHold(readFlow(root).flow, role, doneRoles(root, task));
}
