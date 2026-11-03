/*
 * Engine, model, fallback chain and "Ask when it runs" of a role that runs a
 * policy role (Planner, Builder, Inspector, Verifier), drawn in the Flow editor.
 * These are POLICY, the same store as the Orchestration page's "This block":
 * the policy is read and stored through the same `/orchestration` calls and the
 * same pure edits, and each control saves at once. Nothing here is copied into
 * the flow: the flow keeps only the role's text.
 *
 * Its ceiling, stated: worker roles are the same for every project, so this
 * edits the general policy, not a project's own copy; the main agent's seat is
 * set on the page ("Also set here").
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import type { RoleId } from "../../../../../shared/workerRoles.ts";
import type { EngineChoice, Policy, PolicyRule } from "../../../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../../../shared/types.ts";
import { readEngines } from "../../engines/readEngines.ts";
import { ASK_HINT, engineOptions, withAsk, withBaseChoice, withRule, withoutRule } from "../orchestrationCopy.ts";
import { ChainList } from "./ChainEditor.tsx";
import { ModelInput } from "./ModelInput.tsx";
import { EngineWhy } from "./EngineWhy.tsx";
import { Switch } from "./Switch.tsx";
import { ENGINE_CHOICES, ENGINE_PLAN, engineName } from "./flowScreenCopy.ts";

export type PolicyEdit =
  | { kind: "engine"; choice: EngineChoice }
  | { kind: "model"; choice: EngineChoice }
  | { kind: "chain"; chain: EngineChoice[] }
  | { kind: "ask"; ask: boolean };

/** The rule that holds a role's fallbacks: one per role, found again by this id. */
export const fallbackRuleId = (role: RoleId) => `fallback-${role}`;

/** The always-on rule other than ours that sets this role's chain, if any: it decides before ours does, or after. */
export function otherChainRule(policy: Policy, role: RoleId): PolicyRule | undefined {
  return policy.rules.find((r) => r.id !== fallbackRuleId(role) && r.enabled && r.workers?.[role] && r.when.every((t) => t.kind === "always"));
}

/** The chain the controls show: the base choice, then the fallbacks of our rule. */
export function shownChain(policy: Policy, role: RoleId, scoped = false): EngineChoice[] {
  // A project's policy cannot move a worker role (those are global), so there its rule holds the whole chain.
  if (scoped) { const mine = policy.rules.find((r) => r.id === fallbackRuleId(role))?.workers?.[role]; if (mine?.length) return mine; }
  const first = policy.base.workers[role].value[0];
  const ours = policy.rules.find((r) => r.id === fallbackRuleId(role))?.workers?.[role] ?? [];
  return first ? [first, ...ours.slice(1)] : ours;
}

/** A chain is a rule, never the base: the base keeps its one choice, `fallback-<role>` holds [choice, ...fallbacks]; one step left removes the rule. */
function withFallbackRule(policy: Policy, role: RoleId, name: string, chain: EngineChoice[], scoped: boolean): Policy {
  if (chain.length === 0) return policy;
  const id = fallbackRuleId(role);
  const based = scoped ? policy : withBaseChoice(policy, role, chain[0]!);
  const first = policy.base.workers[role].value[0];
  // Global: one step left is the base itself. Project: one step left that is the base's own choice needs no rule.
  if (chain.length < 2 && (!scoped || (first && first.engine === chain[0]!.engine && first.model === chain[0]!.model))) return withoutRule(based, id);
  const label = `${name} fallbacks`.replace(/["'\n\r]/g, "").slice(0, 60);
  const rule: PolicyRule = { id, name: label, when: [{ kind: "always" }], workers: { [role]: chain }, enabled: true };
  // Replace in place so the rule keeps its place in the order; a new one goes last.
  return based.rules.some((r) => r.id === id) ? { ...based, rules: based.rules.map((r) => (r.id === id ? rule : r)) } : withRule(based, rule);
}

/** The policy after one control moved: the same edits the page makes, chosen by what was pressed. */
export function applyPolicyEdit(policy: Policy, role: RoleId, e: PolicyEdit, name: string = role, scoped = false): Policy {
  if (e.kind === "ask") return withAsk(policy, role, e.ask);
  if (e.kind === "chain") return withFallbackRule(policy, role, name, e.chain, scoped);
  // A new engine or model replaces the first step and keeps the fallbacks behind it.
  const [, ...rest] = shownChain(policy, role, scoped);
  return withFallbackRule(policy, role, name, [e.choice, ...rest], scoped);
}

/** One edit, stored: answers the policy the server kept, or its sentence. */
export async function savePolicyEdit(policy: Policy, role: RoleId, e: PolicyEdit, name: string = role, root?: string): Promise<{ policy: Policy } | { error: string }> {
  const r = await api.orchestrationSave(applyPolicyEdit(policy, role, e, name, !!root), root).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
  return r.ok && r.policy ? { policy: r.policy } : { error: r.error ?? "Could not save." };
}

/** The project whose policy the controls read and write: the Flow editor's own, never the global one by accident. */
export const FlowRootContext = createContext<string>("");
const POLICY_SAVED = "agx:policy-saved";

export const SAVES_AT_ONCE = "Engine, model, fallbacks and Ask save as soon as you change them. The text fields below wait for Save role.";

export function PolicyRoleControls({ role, name }: { role: RoleId; name: string }) {
  const root = useContext(FlowRootContext);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [own, setOwn] = useState(false);
  const [readiness, setReadiness] = useState<EngineReadiness[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const read = () => void api.orchestration(root || undefined).then((r) => { if (alive.current) { if (r.ok) { setPolicy(r.policy); setOwn(r.scope === "project"); } else setNote("The policy could not be read."); } }).catch(() => { if (alive.current) setNote("Could not reach the server."); });
    read();
    window.addEventListener(POLICY_SAVED, read);
    void readEngines((fresh) => api.engines(fresh), (r) => { if (alive.current) setReadiness(r.engines); }, { alive: () => alive.current }).catch(() => { /* the tiles say "checking" */ });
    return () => { alive.current = false; window.removeEventListener(POLICY_SAVED, read); };
  }, [root]);

  if (!policy) return <p className="fe-quiet" role={note ? "alert" : undefined}>{note || "Reading the policy…"}</p>;
  const chain = shownChain(policy, role, own && !!root);
  const other = otherChainRule(policy, role);
  const choice = chain[0] ?? null;
  const options = engineOptions("worker", readiness);
  const saveRaw = async (next: Policy) => {
    setBusy(true);
    const r = await api.orchestrationSave(next, own ? root : undefined).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
    if (!alive.current) return;
    setBusy(false);
    if (r.ok && r.policy) { setNote(""); setPolicy(r.policy); window.dispatchEvent(new Event(POLICY_SAVED)); } else setNote(r.error ?? "Could not save.");
  };
  const send = async (e: PolicyEdit) => {
    setBusy(true);
    const r = await savePolicyEdit(policy, role, e, name, own ? root : undefined);
    if (!alive.current) return;
    setBusy(false);
    if ("error" in r) { setNote(r.error); return; }
    setNote("");
    setPolicy(r.policy);
    window.dispatchEvent(new Event(POLICY_SAVED));
  };
  return (
    <div className="fe-policyctl" data-policy-role={role}>
      {other && (
        <div className="fe-ruleover" role="status">
          <b>A rule decides this block.</b> “{other.name}” is on, so the Main choice below is not used. The button takes this block out of that rule; the others keep it.
          <button type="button" className="fe-ruleoff" disabled={busy} onClick={() => void saveRaw({ ...policy, rules: policy.rules.map((r) => { if (r.id !== other.id) return r; const { [role]: _drop, ...rest } = r.workers ?? {}; return { ...r, workers: rest }; }) })}>Use my choice for this block</button>
        </div>
      )}
      {other?.workers?.[role] && (
        <div className="fe-field fe-ruleruns">
          <span className="fe-tagfb">RUNS NOW</span><span className="fe-flabel">In this order, set by “{other.name}”</span>
          <div className="fe-bsteps" data-wide>
            {other.workers[role]!.map((c, i) => <div key={`${i}-${c.engine}-${c.model}`} className="fe-bstep"><i>{i + 1}</i><b>{engineName(c.engine)}</b><span>{c.model}</span></div>)}
          </div>
        </div>
      )}
      <div>
        <div className="fe-lab">Engine</div>
        <div className="fe-eng">
          {ENGINE_CHOICES.map((e) => {
            const o = options.find((x) => x.value === e.id);
            return (
              <button key={e.id} type="button" aria-pressed={choice?.engine === e.id} disabled={busy || !o || o.disabled}
                title={o?.hint} onClick={() => { if (choice?.engine !== e.id) void send({ kind: "engine", choice: { engine: e.id, model: "" } }); }}>
                <b>{engineName(e.id)}</b><small>{ENGINE_PLAN[e.id]}</small>
              </button>
            );
          })}
        </div>
        <EngineWhy engine={choice?.engine} readiness={readiness} />
      </div>
      <div>
        <ModelInput choice={choice} label={`Model for ${name}`} disabled={busy} wide
          note={`${(ENGINE_CHOICES.find((e) => e.id === choice?.engine)?.models ?? []).length} offered · its own default if you pick none`}
          onCommit={(c) => void send({ kind: "model", choice: c })} />
      </div>
      <div className="fe-fbsec">
        <span className="fe-lab">If it cannot start, try next <small>in this order · drag to reorder</small></span>
        <ChainList chain={chain} onChange={(c) => void send({ kind: "chain", chain: c })} />
      </div>
      <div className="fe-row2">
        <div className="fe-d"><b>Ask me when it runs</b><small>{ASK_HINT}</small></div>
        <Switch on={policy.base.workers[role].ask} label="Ask me when it runs" disabled={busy}
          onChange={(on) => void send({ kind: "ask", ask: on })} />
      </div>
      <small className="fe-quiet">{SAVES_AT_ONCE} Worker roles are the same for every project.</small>
      {note && <p className="fe-errline" role="alert">{note}</p>}
    </div>
  );
}
