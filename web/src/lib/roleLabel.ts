/*
 * One name per role. The flow's roster is where a person names a role
 * ("Planner", "Inspector", or "Paco"), and every sentence that prints a
 * policy role prints that name. The policy ids (`scout`, `reviewer`...) stay
 * what is stored and sent; this is only what is read.
 *
 * Without a flow (not loaded, none for the project) the shipped titles of
 * `WORKER_ROLES` are the fallback, so the page reads the same as before.
 * A name from the flow is used as it is, singular, so sentences are written
 * "Paco uses ..." and never pluralise it. `plural` is for group labels only:
 * the shipped fallback pluralises ("Scouts"), a flow's own name does not.
 */
import { WORKER_ROLES, type RoleId } from "../../../shared/workerRoles.ts";

/** The part of a flow a name needs: a full Flow satisfies it. */
export interface FlowLike {
  roster: readonly { policyRole?: RoleId; name: string }[];
}

export const MAIN_AGENT_NAME = "main agent";

export function roleLabel(role: RoleId | "orchestrator", flow?: FlowLike | null): { name: string; plural: string } {
  if (role === "orchestrator") return { name: MAIN_AGENT_NAME, plural: MAIN_AGENT_NAME };
  const named = flow?.roster.find((r) => r.policyRole === role)?.name.trim();
  if (named) return { name: named, plural: named };
  const title = WORKER_ROLES.find((r) => r.id === role)?.title ?? role;
  return { name: title, plural: `${title}s` };
}

/** A FlowLike from a name per policy role, for a page that holds the names and not the flow. */
export function flowLikeOf(names: Record<string, { name: string }>): FlowLike {
  return { roster: Object.entries(names).map(([policyRole, v]) => ({ policyRole: policyRole as RoleId, name: v.name })) };
}
