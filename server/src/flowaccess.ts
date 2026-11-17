/*
 * Who may write a project's flow.
 *
 * The person's own window keeps every write, as it always had. An agent
 * credential writes only when both hold: it is the seat of THIS project, and
 * the person turned `flow.agentEdit` on there. The caller's kind is checked
 * first, so an agent that is not the seat (or is the seat of another project)
 * hears the person's sentence and nothing about the gate's state.
 *
 * A seat's root may be a worktree of its project: `seatSpeaksFor` folds it, and
 * the write goes to the project's own record, never the worktree's.
 */
import { seatSpeaksFor } from "./seat.ts";
import type { UiLevel } from "../../shared/uiActions.ts";
import { levelRefusal } from "../../shared/uiActions.ts";

export const FLOW_PERSON = "the flow is the person's: an agent asks for the change, the person makes it";
export const FLOW_AGENT_EDIT_OFF = "flow.agentEdit is off for this project";
/** Level 3 stages a dialog and nothing else, so a flow write has no door there. */
export const FLOW_LEVEL_THREE = "flow is a level 2 change, and this server is at level 3: level 3 only stages a dialog for the person, so a flow write is refused here";

export type FlowAccess =
  | { ok: true; root: string }
  | { ok: false; root: string; error: string };

export function flowWriteAccess(a: {
  person: boolean;
  /** The seat's own project from its credential, when it is one. */
  seatRoot?: string;
  root: string;
  /** Whether `flow.agentEdit` is on for the project at the root passed to this. */
  agentEdit: (root: string) => boolean;
  controlLevel: UiLevel;
  readonly: boolean;
}): FlowAccess {
  if (a.person) return { ok: true, root: a.root };
  if (!a.seatRoot) return { ok: false, root: a.root, error: FLOW_PERSON };
  const speaks = seatSpeaksFor(a.seatRoot, a.root);
  if ("error" in speaks) return { ok: false, root: a.root, error: FLOW_PERSON };
  if (!a.agentEdit(speaks.root)) return { ok: false, root: speaks.root, error: FLOW_AGENT_EDIT_OFF };
  /* Level 2 is the only level: 1 looks or opens, and 3 stages a dialog. */
  if (a.readonly || a.controlLevel === 1) {
    return { ok: false, root: speaks.root, error: levelRefusal("flow", { level: 2, kind: "change" }, a.controlLevel, a.readonly) };
  }
  if (a.controlLevel === 3) return { ok: false, root: speaks.root, error: FLOW_LEVEL_THREE };
  return { ok: true, root: speaks.root };
}

