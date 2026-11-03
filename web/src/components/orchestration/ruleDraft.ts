/*
 * One rule as it is edited, and the rule that edit saves. The old rule sheet and
 * the canvas editor both build the stored rule with `buildRule`, so the same
 * input is the same bytes whichever door it came through (a test feeds one input
 * to both and compares). Nothing here touches the network.
 *
 * Its ceiling, stated: a draft holds one rule; two edits at once is one panel.
 */
import { ROLE_IDS, type Chain, type Policy, type PolicyRule, type Trigger } from "../../../../shared/orchestration.ts";
import type { RoleId } from "../../../../shared/workerRoles.ts";
import { newRuleId, type Field } from "./orchestrationCopy.ts";

export interface RuleParts {
  /** The id of the rule being edited; null for a new one. */
  id: string | null;
  name: string;
  when: Trigger[];
  enabled: boolean;
  orch: Chain | undefined;
  workers: Partial<Record<RoleId, Chain>>;
}

/** The stored rule for these parts: the exact shape the rule sheet has always saved. */
export function buildRule(parts: RuleParts, policy: Policy): PolicyRule {
  const { orch, workers } = parts;
  return {
    id: parts.id ?? newRuleId(policy, parts.name), name: parts.name.trim(), when: parts.when, enabled: parts.enabled,
    ...(orch ? { orchestrator: orch } : {}),
    ...(ROLE_IDS.some((r) => workers[r]) ? { workers: Object.fromEntries(ROLE_IDS.filter((r) => workers[r]).map((r) => [r, workers[r]])) as PolicyRule["workers"] } : {}),
  };
}

/** What stops a save, in the sheet's own sentences, or null. */
export function ruleProblem(parts: Pick<RuleParts, "name" | "orch" | "workers">): string | null {
  if (!parts.name.trim()) return "Give the rule a name: it is what the Lantern and the log show.";
  if (!parts.orch && !ROLE_IDS.some((r) => parts.workers[r])) return "A rule has to change something: switch on the main agent or one of the jobs.";
  return null;
}

/** The canvas editor's state: the parts, plus the roles that were added and then switched off (they fade, they do not vanish). */
export interface Draft extends RuleParts { off: Field[] }

export const draftOf = (rule: PolicyRule | null, seed?: Partial<Draft>): Draft => ({
  id: rule?.id ?? null, name: rule?.name ?? "", when: rule?.when ?? [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 10 }],
  enabled: rule?.enabled ?? true, orch: rule?.orchestrator, workers: rule?.workers ?? {}, off: [], ...seed,
});

export const draftRule = (d: Draft, policy: Policy): PolicyRule => buildRule(d, policy);

/** True when the draft differs from the rule it started from (a new rule is dirty once it has a name or a block). */
export function draftDirty(d: Draft, initial: PolicyRule | null, policy: Policy): boolean {
  if (!initial) return !!d.name.trim() || !!d.orch || ROLE_IDS.some((r) => d.workers[r]) || d.when.length !== 1 || d.when[0]!.kind !== "usage";
  const a = JSON.stringify(buildRule(d, policy)), b = JSON.stringify(buildRule(draftOf(initial), policy));
  return a !== b;
}

/** A block was pressed while the rule is edited: it joins the rule with the chain it uses now, so the rule starts as "no change" and the person edits the difference. */
export function withField(d: Draft, f: Field, chain: Chain): Draft {
  const off = d.off.filter((x) => x !== f);
  return f === "orchestrator" ? { ...d, orch: d.orch ?? chain, off } : { ...d, workers: d.workers[f] ? d.workers : { ...d.workers, [f]: chain }, off };
}
export const chainOfDraft = (d: Draft, f: Field): Chain | undefined => (f === "orchestrator" ? d.orch : d.workers[f]);
export function setDraftChain(d: Draft, f: Field, chain: Chain | undefined): Draft {
  if (f === "orchestrator") return { ...d, orch: chain, off: chain ? d.off.filter((x) => x !== f) : [...new Set([...d.off, f])] };
  const workers = { ...d.workers };
  if (chain) workers[f] = chain; else delete workers[f];
  return { ...d, workers, off: chain ? d.off.filter((x) => x !== f) : [...new Set([...d.off, f])] };
}
