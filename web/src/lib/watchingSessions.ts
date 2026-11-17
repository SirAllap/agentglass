import type { LanternRow } from "../components/LanternView.tsx";
import { groupLantern } from "./lanternStore.ts";

/* What the Watching page says about the live sessions, from the Lantern board's rows (no read of its own). */

export type SessionState = "working" | "needs you" | "idle";

/** A live session: not the Lantern's own line, not a name whose pane is gone. */
export const liveSessions = (rows: readonly LanternRow[] | null): LanternRow[] =>
  (rows ?? []).filter((r) => r.role !== "lantern" && !r.gone);

export const stateOf = (r: LanternRow): SessionState => (r.needsYou ? "needs you" : r.state === "working" || r.alive ? "working" : "idle");

/** The names a person can tell apart: "project / name" unless the name already says the project. */
export const sessionLabel = (r: LanternRow): string => (r.project && !r.name.startsWith(r.project) ? `${r.project} / ${r.name}` : r.name);

/** Idle sessions Close idle ends: nobody needs them and nothing runs in them.
 *  Never an orchestrator seat, and never a "waiting" row (it is not at rest). */
export const idleSessions = (rows: readonly LanternRow[]): LanternRow[] =>
  rows.filter((r) => r.role !== "orchestrator" && r.state === "idle" && stateOf(r) === "idle");

/** The cards the preview draws: what needs you first, then what works, then the rest; three at most. */
export function previewRows(rows: readonly LanternRow[]): LanternRow[] {
  const g = groupLantern([...rows]);
  return [...g.need, ...g.finished, ...g.working, ...g.idle].slice(0, 3);
}

export const needCount = (rows: readonly LanternRow[]): number => rows.filter((r) => r.needsYou).length;
