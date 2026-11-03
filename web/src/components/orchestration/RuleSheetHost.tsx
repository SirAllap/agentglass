/*
 * The one mount of `RuleSheet`, for the page and for the flow editor. The caller
 * owns which rule is open and how a policy is stored; this owns what the sheet is
 * handed from them, so the two screens cannot drift apart.
 */
import type { Policy, PolicyRule } from "../../../../shared/orchestration.ts";
import type { PolicyRuleState } from "../../lib/api.ts";
import type { EngineReadiness } from "../../../../shared/types.ts";
import type { FlowLike } from "../../lib/roleLabel.ts";
import { RuleSheet } from "./RuleForm.tsx";
import { ruleHolds, scopeWords, usageLeft, withRule, withoutRule } from "./orchestrationCopy.ts";
import { sheetOpen, sheetRuleFor } from "./ruleSheetState.ts";

export function RuleSheetHost(p: {
  editing: string | null;
  seed: PolicyRule | null;
  policy: Policy;
  flow: FlowLike | null;
  readiness: readonly EngineReadiness[] | null;
  states: readonly PolicyRuleState[];
  /** The project whose policy this edits; "" for all projects. */
  root: string;
  /** The key the states of this policy are filed under: "global" or the project. */
  scopeKey: string;
  now: Date;
  /** Stores the whole policy; null when it saved, or the server's sentence. */
  save: (next: Policy) => Promise<string | null>;
  onClose: () => void;
}) {
  const rule = sheetRuleFor(p.policy, p.editing, p.seed);
  if (!sheetOpen(p.editing, rule)) return null;
  return (
    <RuleSheet key={p.editing} initial={rule} flow={p.flow} policy={p.policy} readiness={p.readiness} scope={scopeWords(p.root)}
      facts={{ on: ruleHolds(p.states, p.scopeKey) }} left={usageLeft(p.states, p.scopeKey)} now={p.now} onCancel={p.onClose}
      onDelete={rule && p.editing !== "new" ? () => { void p.save(withoutRule(p.policy, rule.id)).then((e) => { if (!e) p.onClose(); }); } : undefined}
      onSave={async (r) => { const e = await p.save(withRule(p.policy, r)); if (!e) p.onClose(); return e; }} />
  );
}
