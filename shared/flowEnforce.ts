/*
 * The flow, held by the server: one pure decision.
 *
 * A worker of role X may hand off only when the role just before X on the
 * flow's path has already reported done for the same task. The first role on
 * the path has no one before it and is never held. A role off the path is not
 * in the chain and is never held. The person is never held: this rule is only
 * asked about a worker.
 *
 * CEILING: a worker with no flow role, or no task (no recorded worktree), is not
 * gated at all. The server cannot tell which step it is, so it lets it by.
 */
import type { Flow } from "./flow.ts";

export interface FlowHold {
  /** The role whose report is missing. */
  missing: string;
  /** One plain sentence: which step is missing and how to change the flow. */
  why: string;
}

/** The role right before `role` on the path, or null for the first role and for a role off the path. */
export function predecessorOf(path: readonly string[], role: string): string | null {
  const at = path.indexOf(role);
  return at > 0 ? path[at - 1]! : null;
}

/**
 * Whether `role` is held back from finishing. `done` holds the ids of the roles
 * that have reported done for this task. `label` names a role the way the
 * screen does (its title), falling back to its id.
 */
export function flowHold(flow: Pick<Flow, "path" | "roster">, role: string, done: ReadonlySet<string>): FlowHold | null {
  const before = predecessorOf(flow.path, role);
  if (!before || done.has(before)) return null;
  const name = (id: string) => flow.roster.find((r) => r.id === id)?.name || id;
  return {
    missing: before,
    why: `${name(role)} cannot finish yet: ${name(before)} has not reported done for this task. Let ${name(before)} finish first, or change the flow in Settings > Flow & review (or turn off "Hold workers to the flow").`,
  };
}

/** A report says its role is done when its state line opens with "done" (or "hecho"). A blocker or a need is the caller's to rule out. */
export const reportSaysDone = (state: string): boolean => /^\s*(done|finished|hecho|terminado)\b/i.test(state);
