/*
 * The picker decision for Settings ▸ Orchestration ▸ Session start: the
 * status names to offer, from the same Jira read the workflow map page
 * already holds (`useJiraUnits`). A failed read falls back to the stale list
 * when there is one, and to nothing (free text) when there is not.
 */
import { allStatuses, type MapSpace } from "./workflowMap.ts";
import type { UnitsState } from "./jiraUnits.ts";

/** Every distinct status name across the units this read answered with, sorted. Empty is "no picker: fall back to free text". */
export function sessionStartStatusNames(state: UnitsState): string[] {
  const units: MapSpace[] = (state.kind === "ok" ? state.units : state.kind === "error" ? state.stale ?? [] : [])
    .map((u) => ({ id: u.id, name: u.name, statuses: u.statuses }));
  return allStatuses(units).map((s) => s.name).sort((a, b) => a.localeCompare(b));
}
