/*
 * The rules of one block, for its side panel in the flow editor: which rules
 * touch the role, the one line that says why it runs what it runs, and the draft
 * "Add a rule for this block" starts from. Pure, so the words are tested without
 * a renderer.
 */
import { resolve, type Policy, type PolicyRule } from "../../../../../shared/orchestration.ts";
import type { RoleId } from "../../../../../shared/workerRoles.ts";
import type { EngineReadiness } from "../../../../../shared/types.ts";
import { roleLabel, type FlowLike } from "../../../lib/roleLabel.ts";
import { WORDS, whyFor, type FlowBlock } from "./flowCopy.ts";

/** The rules that set this role's engine, in the order the policy keeps them. */
export const rulesTouching = (policy: Policy, role: RoleId): PolicyRule[] => policy.rules.filter((r) => !!r.workers?.[role]);

/** The line the page prints under "Why it is set this way": the rule that moves the role right now, or the base choice. */
export function roleWhy(policy: Policy, role: RoleId, readiness: readonly EngineReadiness[] | null, holds: (id: string) => boolean, scopeWord: string): string {
  const r = readiness ? resolve(policy, { on: holds }, readiness).workers[role] : null;
  const ruleName = r?.ok && r.from === "rule" ? r.ruleName ?? null : null;
  return whyFor({ id: role, ruleName } as FlowBlock, scopeWord);
}

/** When the role runs, in the page's words. */
export const roleWhen = (role: RoleId): string => WORDS[role].when;

/** The sheet starts from a rule that moves this role to what it uses now, so the draft has one thing to change. */
export function roleRuleDraft(policy: Policy, role: RoleId, flow: FlowLike | null): PolicyRule {
  return { id: "", name: `${roleLabel(role, flow).name} rule`, enabled: true, when: [{ kind: "always" }], workers: { [role]: policy.base.workers[role].value } };
}
