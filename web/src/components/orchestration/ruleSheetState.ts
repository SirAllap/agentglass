/*
 * What the rule sheet shows, decided in one place for the two screens that mount
 * it: the Orchestration page and the flow editor's side panel. "new" opens the
 * seed (or an empty draft); an id opens that rule; an id the policy no longer
 * holds opens nothing, so a rule deleted underneath the sheet does not leave it
 * editing a ghost.
 */
import type { Policy, PolicyRule } from "../../../../shared/orchestration.ts";

export function sheetRuleFor(policy: Policy, editing: string | null, seed: PolicyRule | null): PolicyRule | null {
  return editing && editing !== "new" ? policy.rules.find((r) => r.id === editing) ?? null : seed;
}

/** Whether the sheet is on screen: a rule to edit, or a new one. */
export const sheetOpen = (editing: string | null, rule: PolicyRule | null): boolean => !!editing && (editing === "new" || !!rule);
