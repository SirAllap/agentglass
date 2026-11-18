/*
 * Which tab is a policy-started worker, and what glyph says so.
 *
 * `/agents/named` is the only list that knows a worker by its window. `startedBy`
 * is the stamp a policy start leaves and nothing else does, so a tab a person
 * opened by hand (a named agent, an enlisted tab) never reads as a worker and
 * never gets the worker's Stop. A role start without the stamp (a TUI worker)
 * still carries `role`, so either one marks the tab.
 */
import type { FlowBlockId } from "../components/orchestration/flow/flowCopy.ts";

export interface NamedAgentRow {
  name: string;
  kind: string;
  paneId: string;
  windowId: string;
  startedAt: number;
  endedAt: number | null;
  model?: string;
  role?: string;
  startedBy?: unknown;
  exitCode?: number;
  exitLine?: string;
  resultMissing?: boolean;
  /** The turn ended on a question to the orchestrator: not a finished worker. */
  awaitingAnswer?: boolean;
}

/** The flow's role colours (the Orchestration flow's own): builder teal,
 *  reviewer / inspector yellow, verifier green, scout / planner salmon. */
const ROLES: Record<string, { id: FlowBlockId; colour: string; label: string }> = {
  builder: { id: "builder", colour: "#4aa08f", label: "Builder" },
  reviewer: { id: "reviewer", colour: "#d4a73a", label: "Reviewer" },
  inspector: { id: "reviewer", colour: "#d4a73a", label: "Inspector" },
  verifier: { id: "verifier", colour: "#4cb06f", label: "Verifier" },
  scout: { id: "scout", colour: "#c98a7a", label: "Scout" },
  planner: { id: "scout", colour: "#c98a7a", label: "Planner" },
};

/** The glyph and colour for a worker's role; null for an unknown role or no worker. */
export function roleTabIcon(role: string | null | undefined): { id: FlowBlockId; colour: string; label: string } | null {
  return role ? ROLES[role.toLowerCase()] ?? null : null;
}

/** Rows arrive newest first, so the window's newest row decides: a stale
 *  worker row behind a tab somebody opened later is not that tab's. */
export function workerInWindow(rows: readonly NamedAgentRow[] | null, windowId: string): NamedAgentRow | null {
  if (!rows) return null;
  const here = rows.find((r) => r.windowId === windowId);
  return here && (here.startedBy !== undefined || here.role) ? here : null;
}

/** The windows no named-agent row points at yet. A worker's window exists a
 *  moment before its row does, so these are the ones worth one more read when
 *  the fleet changes. Rows of any kind count: a tab with a row is not waiting. */
export function windowsWithoutRow(rows: readonly NamedAgentRow[] | null, windowIds: readonly string[]): string[] {
  if (!rows) return [...windowIds];
  const seen = new Set(rows.map((r) => r.windowId));
  return windowIds.filter((id) => !seen.has(id));
}

/** Stop is offered on a worker that is still running; an ended row keeps its tab but has nothing to stop. */
export const canStopWorker = (r: NamedAgentRow | null): r is NamedAgentRow => !!r && r.endedAt === null;

/** The state word for the tooltip. The dot on the tab carries the same state. */
export function workerState(r: NamedAgentRow): string {
  if (r.awaitingAnswer) return "needs you";
  return r.endedAt === null ? "running" : "idle";
}

/** "<name> · <Role> · <state>" — the tab icon's hover text. */
export function workerTabTip(r: NamedAgentRow): string {
  const role = roleTabIcon(r.role)?.label ?? r.role ?? "Worker";
  return `${r.name} · ${role} · ${workerState(r)}`;
}

/** A worker tab draws the role icon only; its state is the icon's colour, never a second badge.
 *  The tab's own mark is hidden on a worker: its "failed" is the pane's last status line, which
 *  a worker whose agent is fine (a shell running tsc) raises as noise. Amber when it needs you,
 *  red only when the worker really ended with a non-zero exit, the role's own colour otherwise. */
export function workerIconColour(r: NamedAgentRow, role: { colour: string }, needsYou: boolean): string {
  if (needsYou || r.awaitingAnswer) return "var(--warning)";
  if (r.endedAt !== null && r.exitCode !== undefined && r.exitCode !== 0) return "var(--error)";
  return role.colour;
}

/** Windows still worth a re-read, each counted once. Entries of windows that are gone are dropped, so the map cannot grow. */
export function spendRowTries(tries: Map<string, number>, waiting: readonly string[], windowIds: readonly string[], max: number): string[] {
  const live = new Set(windowIds);
  for (const id of [...tries.keys()]) if (!live.has(id)) tries.delete(id);
  const worth = waiting.filter((id) => (tries.get(id) ?? 0) < max);
  for (const id of worth) tries.set(id, (tries.get(id) ?? 0) + 1);
  return worth;
}

/** Overlapping reads can land out of order: only a read newer than the last applied one may win. */
export function newestWins(): { start(): number; accept(n: number): boolean } {
  let issued = 0;
  let applied = 0;
  return { start: () => ++issued, accept: (n) => (n > applied ? ((applied = n), true) : false) };
}
