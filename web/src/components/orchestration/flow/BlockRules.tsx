/*
 * Under a block's engine in the editor's side panel: why it is set this way,
 * when it runs, the rules that touch it (each opens the rule sheet) and the
 * button that starts a new one for this role. Rules are POLICY: the sheet saves
 * the whole policy through the editor's own `useAround`, and `onSaved` tells the
 * page to read it again so its Conditions card agrees.
 *
 * Its ceiling, stated: a rule that touches two roles opens the same sheet from
 * either one; there is no per-role copy of it.
 */
import { useRef, useState } from "react";
import type { PolicyRule } from "../../../../../shared/orchestration.ts";
import type { RoleId } from "../../../../../shared/workerRoles.ts";
import type { FlowLike } from "../../../lib/roleLabel.ts";
import { RuleSheetHost } from "../RuleSheetHost.tsx";
import { ruleHolds, scopeWords } from "../orchestrationCopy.ts";
import type { Around } from "./AroundFlow.tsx";
import { roleRuleDraft, roleWhen, roleWhy, rulesTouching } from "./blockRules.ts";

export function BlockRules({ role, flow, a, onSaved }: { role: RoleId; flow: FlowLike; a: Around; onSaved?: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [seed, setSeed] = useState<PolicyRule | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const policy = a.policy;
  if (!policy) return null;
  // The states of the policy in force: the project's own, or the all-projects one it inherits.
  const root = a.own ? a.root : "";
  const scopeKey = a.own && a.root ? a.root : "global";
  const touching = rulesTouching(policy, role);
  const open = (id: string, from: HTMLElement, withSeed: PolicyRule | null = null) => { opener.current = from; setSeed(withSeed); setEditing(id); };
  const close = () => { setEditing(null); setSeed(null); opener.current?.focus(); opener.current = null; };
  return (
    <div className="fe-rules" data-block-rules={role}>
      <div className="fe-row"><span className="fe-k">Why it is set this way</span><span className="fe-v fe-wide fe-small" data-why>{roleWhy(policy, role, a.readiness, ruleHolds(a.states, scopeKey), scopeWords(root))}</span></div>
      <div className="fe-row"><span className="fe-k">When</span><span className="fe-v fe-wide fe-small" data-when>{roleWhen(role)}</span></div>
      <div className="fe-row"><span className="fe-k">Rules for this block<small>{touching.length ? `${touching.length} in the policy.` : "None yet."}</small></span>
        <span className="fe-v fe-wide fe-rulechips">
          {touching.map((r) => (
            <button key={r.id} type="button" className="fe-rulechip" data-rule-chip={r.id} data-off={r.enabled ? undefined : ""} onClick={(e) => open(r.id, e.currentTarget)}>
              <span>{r.name}</span>{!r.enabled && <small>off</small>}
            </button>
          ))}
          <button type="button" className="fe-btn" data-size="sm" data-add-rule onClick={(e) => open("new", e.currentTarget, roleRuleDraft(policy, role, flow))}>Add a rule for this block</button>
        </span>
      </div>
      <RuleSheetHost editing={editing} seed={seed} policy={policy} flow={flow} readiness={a.readiness} states={a.states} root={root} scopeKey={scopeKey}
        now={new Date()} onClose={close}
        save={async (next) => { const e = await a.saveRule(next); if (!e) onSaved?.(); return e; }} />
    </div>
  );
}
