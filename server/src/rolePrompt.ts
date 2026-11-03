/*
 * A flow role's prompt, from the project's saved flow, as the opening of a
 * worker's brief. Lives apart from flightPlan.ts so the start paths can use it
 * without importing the whole Flight plan engine.
 */
import { readStoredFlow } from "./config.ts";
import { FLOW_PROMPT_MAX } from "../../shared/flow.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { owesResult, workerRole } from "../../shared/workerRoles.ts";
import type { Chain } from "../../shared/orchestration.ts";
import type { FlowRole } from "../../shared/flow.ts";
import { chainInForce } from "./orchestration.ts";

/**
 * The last line of a headless worker's brief, for the roles whose answer is
 * the point of them: a turn keeps one message — its last — and that message is
 * the result the card and the plan read. Idempotent because a retried turn
 * hands the same prompt again.
 */
export const RESULT_CONTRACT = "The last message of this turn is the only thing kept of it, and it is the result: before you finish, write it there — what changed and what you ran, or the verdict line this role owes. A turn that ends without one has left no result at all.";

/** A built-in role that owes a result, or a flow role that runs as one of them. */
export function roleOwesResult(root: string, role: unknown): boolean {
  if (owesResult(role)) return true;
  const policy = flowRoleFor(root, role)?.policyRole;
  return !!policy && owesResult(policy);
}

/** Append the result contract to a headless turn's brief, when the role owes one. */
export function withResultContract(text: string, root: string, role: unknown): string {
  const typed = text.trim();
  if (typed.includes(RESULT_CONTRACT) || !roleOwesResult(root, role)) return text;
  return typed ? `${typed}\n\n${RESULT_CONTRACT}` : RESULT_CONTRACT;
}

/**
 * A roster role of the SAVED flow that is not one of the four built-in ids, or
 * null. A roster id equal to a built-in id is never custom: it takes the
 * built-in path (matched by `policyRole`) unchanged, and a custom role that
 * carries a `policyRole` (a "QA" step that is a reviewer) is found by its own
 * id only, so it can never change what the built-in role resolves to. The
 * chain is the policy's for a role with a `policyRole`, else the stored one.
 */
export function flowRoleFor(root: string, id: unknown): (FlowRole & { chain: Chain }) | null {
  if (typeof id !== "string" || workerRole(id)) return null;
  const r = readStoredFlow(root)?.roster.find((x) => x.id === id);
  return r ? { ...r, chain: r.policyRole ? chainInForce(root, r.policyRole) : [...r.chain] } : null;
}

/** The saved flow's custom role ids, for the sentence that refuses an unknown one. */
export function flowRoleIds(root: string): string[] {
  return (readStoredFlow(root)?.roster ?? []).map((r) => r.id).filter((id) => !workerRole(id));
}

/** The sentence for an id that is neither built-in nor in the saved flow. */
export function unknownRoleError(root: string): string {
  const ids = flowRoleIds(root);
  return ids.length ? `no such role. The saved flow also has: ${ids.join(", ")}` : "no such role";
}

/**
 * The prompt of the roster role whose `policyRole` is `role`: the saved flow's,
 * else the shipped template's. A project with no saved flow gets "": its
 * launches stay as they were until somebody opens the flow editor. Anything
 * that is not a built-in role gets the saved flow's role of that id, else "".
 */
export function rolePromptFor(root: string, role: unknown): string {
  if (!workerRole(role)) return (flowRoleFor(root, role)?.prompt?.trim() ?? "").slice(0, FLOW_PROMPT_MAX).trim();
  const own = readStoredFlow(root);
  if (!own) return "";
  const pick = (f: { roster: { policyRole?: string; prompt?: string }[] }) => f.roster.find((r) => r.policyRole === role)?.prompt?.trim() ?? "";
  return (pick(own) || pick(templateFlow())).slice(0, FLOW_PROMPT_MAX).trim();
}

/**
 * What the saved flow says a built-in role may do: `readsOnly`, the `tools`
 * list and the `allow` list of the roster role whose `policyRole` is `roleId`.
 * Null when the project has no saved flow, or its flow has no such role: the
 * start is then exactly what it was. The shipped template is NOT consulted, so
 * a project that never opened the flow editor is not narrowed by defaults it
 * did not choose.
 */
export function roleLockFor(root: string, roleId: unknown): { readsOnly: boolean; tools: string[]; allow: string[] } | null {
  if (!workerRole(roleId)) {
    const c = flowRoleFor(root, roleId);
    return c ? { readsOnly: c.readsOnly === true, tools: [...(c.tools ?? [])], allow: [...(c.allow ?? [])] } : null;
  }
  const r = readStoredFlow(root)?.roster.find((x) => x.policyRole === roleId);
  return r ? { readsOnly: r.readsOnly === true, tools: [...(r.tools ?? [])], allow: [...(r.allow ?? [])] } : null;
}

/** The role prompt, then what the seat typed. Not repeated when the seat already pasted it. */
export function withRolePrompt(seatText: string, rolePrompt: string): string {
  if (!rolePrompt) return seatText;
  const typed = seatText.trim();
  if (typed.startsWith(rolePrompt)) return seatText;
  return typed ? `${rolePrompt}\n\n${seatText}` : rolePrompt;
}
