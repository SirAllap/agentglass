/*
 * The card's right-click menu, as rows with a refusal and a reason each. It is
 * built from the one list the Keys section documents (`FLOW_MENU`), so the menu
 * and the page cannot drift into two different sets of actions; a row that is
 * off says why instead of disappearing.
 *
 * Request-free and render-free: the card opens the editor for the rows that
 * edit, and the caller does the rest.
 */
import type { Flow, FlowRole } from "../../../shared/flow.ts";
import { FLOW_MENU } from "../components/orchestration/flow/flowCopy.ts";

export type WorkerMenuAct = "open" | "engine" | "model" | "after" | "general" | "copy" | "remove";

export interface WorkerMenuRow {
  act: WorkerMenuAct;
  label: string;
  enabled: boolean;
  /** The sentence a person reads on a row that is off. */
  why: string | null;
  danger: boolean;
}

const WHY: Partial<Record<WorkerMenuAct, string>> = {
  general: "A flow belongs to one project; there is no general flow to fall back to.",
};

/** The menu of one card: which rows it may press, and why the others are off. */
export function workerCardMenu(flow: Flow, role: FlowRole): WorkerMenuRow[] {
  const onPath = flow.path.indexOf(role.id) >= 0;
  const last = flow.path.length < 2;
  return FLOW_MENU.map((m) => {
    let enabled = true;
    let why: string | null = null;
    if (m.act === "general") { enabled = false; why = WHY.general ?? null; }
    if (m.act === "after" && !onPath) { enabled = false; why = "It is not on the path yet: put it on the path first."; }
    if (m.act === "remove") {
      enabled = onPath && !last;
      why = !onPath ? "It is not on the path." : last ? "The last step cannot be removed." : null;
    }
    return { act: m.act as WorkerMenuAct, label: m.label, enabled, why: enabled ? null : why ?? m.why ?? null, danger: !!m.danger };
  });
}

/** Whether pressing a row opens the one editor, and where it lands. */
export function menuOpensEditor(act: WorkerMenuAct): boolean {
  return act === "open" || act === "engine" || act === "model";
}
