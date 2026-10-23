/*
 * WHICH WORKERS DRAW UNDER A CHAIR, and which stay where their urgency puts them.
 *
 * A chair's workers nest under its card so a person sees whose they are. The
 * exception is the point of the screen: a worker that is stopped on a person
 * (a permission, a held gate, or a turn that ended) stays in its "Needs you" or
 * "Finished" section, because a number that a fold can hide is not a number. It
 * is counted there, and the chair says how many of its own are up there. A
 * worker that has gone is not a quiet one: it goes with the gone, where a person
 * clears it.
 *
 * Pure over the rows, so the rule is asserted on rows and not by looking.
 */
import type { LanternRow } from "../components/LanternView.tsx";

export interface ChairGroup {
  chair: LanternRow;
  /** The workers drawn beneath it, quiet ones. */
  workers: LanternRow[];
  /** Its own workers that are stopped on a person and are drawn above, not here. */
  above: number;
}

export function nestUnderChairs(rows: readonly LanternRow[]): { chairs: ChairGroup[]; rest: LanternRow[] } {
  const chairs: ChairGroup[] = [];
  const seated = new Map<string, ChairGroup>();
  for (const r of rows) {
    if (r.role !== "orchestrator" || !r.chairOf || seated.has(r.chairOf)) continue;
    const g = { chair: r, workers: [], above: 0 };
    seated.set(r.chairOf, g);
    chairs.push(g);
  }
  const rest: LanternRow[] = [];
  for (const r of rows) {
    if (chairs.some((g) => g.chair === r)) continue;
    const g = !r.role && r.under ? seated.get(r.under) : undefined;
    if (!g) rest.push(r);
    else if (r.needsYou) { g.above++; rest.push(r); }
    else if (r.gone) rest.push(r);
    else g.workers.push(r);
  }
  return { chairs, rest };
}
