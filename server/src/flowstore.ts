/*
 * One step back for a project's flow.
 *
 * Every write, by a person or by the seat, saves the flow it found before it
 * writes. The next write replaces that step, so undo always answers "before the
 * last change", never a stack. A project that had no saved flow snapshots
 * null, and undo deletes the record: back to the template.
 *
 * Nothing here validates a flow. `readStoredFlow` already did, and the step is
 * the record that was there, never a value a caller sent.
 */
import type { Flow } from "../../shared/flow.ts";
import { readFlowSnapshot, writeFlowSnapshot, writeStoredFlow } from "./config.ts";

export interface FlowUndoNote {
  who: string;
  at: number;
}

export type FlowUndo =
  | { ok: true; who: string; flow: Flow | null }
  | { ok: false; error: string };

/** What the flow page draws as its undo button: who made the last change, and when. */
export function flowUndoNote(root: string): FlowUndoNote | null {
  const s = readFlowSnapshot(root);
  return s ? { who: s.actor, at: s.at } : null;
}

/** Keep the flow as it reads now, before the write about to happen. */
export function rememberFlow(root: string, before: Flow | null, actor: string, at = Date.now()): { ok: boolean; error?: string } {
  const w = writeFlowSnapshot(root, { flow: before, actor, at });
  return w.ok ? { ok: true } : { ok: false, error: w.error ?? "could not keep the step before this write" };
}

/** Put back the flow from before the last write, and clear the step. */
export function undoFlow(root: string): FlowUndo {
  const step = readFlowSnapshot(root);
  if (!step) return { ok: false, error: "nothing to undo" };
  const w = writeStoredFlow(root, step.flow);
  if (!w.ok) return { ok: false, error: w.error ?? "could not put the flow back" };
  const cleared = writeFlowSnapshot(root, null);
  if (!cleared.ok) return { ok: false, error: cleared.error ?? "the flow was put back but the step could not be cleared" };
  return { ok: true, who: step.actor, flow: step.flow };
}
