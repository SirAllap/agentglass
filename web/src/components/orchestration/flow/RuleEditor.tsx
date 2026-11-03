/*
 * Editing one rule, in the Conditions panel's slot. WHEN is picked here (every
 * kind the rules have, several at once: all must hold); WHAT is set on the
 * blocks: the editor fades the blocks outside the rule, pressing a block adds it,
 * and each block's chain is edited below with the same engine and model controls
 * the block panel has. Nothing is saved until Save, and the server's own sentence
 * for a refusal sits above the buttons.
 *
 * The saved rule is `buildRule`'s, the one the old rule sheet builds, so the same
 * input is the same bytes.
 *
 * Its ceiling, stated: a chain is edited step by step here; the rule sheet's
 * "keeps the page's choice" is a role switched off.
 */
import { useRef, useState } from "react";
import type { Flow } from "../../../../../shared/flow.ts";
import { CHAIN_MAX, TRIGGERS_MAX, type Chain, type Policy, type PolicyRule } from "../../../../../shared/orchestration.ts";
import { roleLabel } from "../../../lib/roleLabel.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { INPUT, INPUT_STYLE } from "../../workspace/Chrome.tsx";
import { PickRow } from "../SafetyParts.tsx";
import { TriggerEditor, freshTrigger } from "../RuleForm.tsx";
import {
  CHAIN_FULL, CHAIN_TAIL, chainAdd, chainMove, chainRemove, engineOptions, pickEngine, ruleHolds, ruleLine, scopeWords, testDraft, usageLeft, withRule, withoutRule,
} from "../orchestrationCopy.ts";
import type { Around } from "./AroundFlow.tsx";
import { Switch } from "./Switch.tsx";
import { ModelInput } from "./ModelInput.tsx";
import { FIELDS } from "./canvasRules.ts";
import { chainOfDraft, draftDirty, draftRule, setDraftChain, withField, type Draft } from "../ruleDraft.ts";
import { ruleProblem } from "../ruleDraft.ts";
import { baseChainOf } from "./canvasRules.ts";
import { FlowIcon } from "./flowIcons.tsx";
import type { Field } from "../orchestrationCopy.ts";

const fieldName = (f: Field, flow: Flow): string => (f === "orchestrator" ? "The main agent" : roleLabel(f, flow).name);

/** One chain: numbered steps tried in order, each with the block panel's engine and model controls, then "Then ask me." */
export function DraftChain({ id, label, chain, role, readiness, onChange }: {
  id: string; label: string; chain: Chain; role: "orchestrator" | "worker"; readiness: Around["readiness"]; onChange: (c: Chain) => void;
}) {
  const options = engineOptions(role, readiness);
  const firstReady = options.find((o) => !o.disabled);
  return (
    <div className="fe-draftchain" role="group" aria-label={label}>
      {chain.map((c, i) => (
        <div key={i} className="fe-draftstep" data-step={i + 1}>
          <div className="fe-stephead">
            <span className="fe-n">{i + 1}</span><b>{i === 0 ? "uses" : "then"}</b>
            <span className="fe-sp" />
            <button type="button" className="fe-sq" aria-label={`${label}: move step ${i + 1} up`} disabled={i === 0} onClick={() => onChange(chainMove(chain, i, -1))}>↑</button>
            <button type="button" className="fe-sq" aria-label={`${label}: move step ${i + 1} down`} disabled={i === chain.length - 1} onClick={() => onChange(chainMove(chain, i, 1))}>↓</button>
            <button type="button" className="fe-sq" aria-label={`${label}: remove step ${i + 1}`} disabled={chain.length === 1} onClick={() => onChange(chainRemove(chain, i))}><FlowIcon name="x" size={ICON.xs} /></button>
          </div>
          <PickRow label="Engine" ctl="engine" value={c.engine} disabled={!readiness}
            options={options.map((o) => ({ id: o.value, label: o.label, title: o.hint, disabled: o.disabled }))}
            onChange={(engine) => { const n = pickEngine(options, c, engine); if (n) onChange(chain.map((x, j) => (j === i ? n : x))); }} />
          <ModelInput choice={c} label={`${label}: model ${i + 1}`} disabled={false} onCommit={(n) => onChange(chain.map((x, j) => (j === i ? n : x)))} />
        </div>
      ))}
      {chain.length >= CHAIN_MAX
        ? <small className="fe-quiet">{CHAIN_FULL} {CHAIN_TAIL}</small>
        : (
          <div className="fe-stepadd">
            <button type="button" className="fe-btn" data-size="sm" data-add-step disabled={!firstReady}
              onClick={() => onChange(chainAdd(chain, { engine: firstReady!.value, model: "" }))}>+ add a step</button>
            <small className="fe-quiet">{CHAIN_TAIL}</small>
          </div>
        )}
      <span hidden id={id} />
    </div>
  );
}

export function RuleEditor(p: {
  a: Around; flow: Flow; policy: Policy; initial: PolicyRule | null; draft: Draft; onDraft: (d: Draft) => void;
  /** Leave the editor (guarded by the caller when the draft is dirty). */
  onLeave: () => void; onSaved: () => void;
  /** Lights the blocks the test says would change. */
  onTested: (fields: Field[]) => void;
  /** The pointer is over (or left) one block's settings: the canvas lights that block. */
  onFocusField?: (field: Field | null) => void;
}) {
  const { a, flow, policy, draft: d, initial } = p;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const scope = scopeWords(a.own ? a.root : "");
  const scopeKey = a.own && a.root ? a.root : "global";
  const rule = draftRule(d, policy);
  const set = (n: Draft) => { setTested(null); p.onTested([]); p.onDraft(n); };
  const used = FIELDS.filter((f) => chainOfDraft(d, f));
  const offered = FIELDS.filter((f) => d.off.includes(f) && !chainOfDraft(d, f));
  const uid = d.id ?? "new-rule";

  const save = async () => {
    setError(null);
    const problem = ruleProblem(d);
    if (problem) { setError(problem); return; }
    setBusy(true);
    const e = await a.saveRule(withRule(policy, rule)).catch(() => "Could not reach the server.");
    setBusy(false);
    if (e) setError(e); else p.onSaved();
  };
  const runTest = () => {
    const left = usageLeft(a.states, scopeKey);
    const r = testDraft(policy, rule, { on: ruleHolds(a.states, scopeKey) }, new Date(), left, a.readiness, flow);
    const touched = FIELDS.filter((f) => chainOfDraft(d, f));
    // One line: does the condition hold now, and what each block of the rule would run.
    const mine = r.lines.filter((l) => touched.some((f) => l.startsWith(f === "orchestrator" ? "The main agent" : roleLabel(f, flow).name)));
    setTested(`${r.holds} ${mine.join(" ")}`.trim());
    p.onTested(r.holds.startsWith("This condition holds") ? touched : []);
  };

  return (
    <div className="fe-ruleeditor" data-rule-editor
      onPointerLeave={() => p.onFocusField?.(null)}
      onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) p.onFocusField?.(null); }}>
      <div className="fe-edname">
        <label htmlFor={`${uid}-name`} className="sr-only">Name</label>
        <input id={`${uid}-name`} ref={nameRef} value={d.name} maxLength={60} spellCheck={false} placeholder="Name this condition" autoFocus
          onChange={(e) => set({ ...d, name: e.target.value })} className={INPUT} style={INPUT_STYLE} />
        <small className="fe-quiet">{initial ? "Editing" : "New"} · nothing saved yet</small>
      </div>

      <section className="fe-edsec" data-when>
        <h3>When <small>{d.when.length > 1 ? "all of these must hold" : "pick one"}</small></h3>
        {d.when.map((t, i) => (
          <TriggerEditor key={i} id={`${uid}-when-${i}`} t={t} now={new Date()} left={usageLeft(a.states, scopeKey)} removable={d.when.length > 1}
            onChange={(n) => set({ ...d, when: d.when.map((x, j) => (j === i ? n : x)) })}
            onRemove={() => set({ ...d, when: d.when.filter((_, j) => j !== i) })} />
        ))}
        <button type="button" className="fe-btn" data-size="sm" data-add-when disabled={d.when.length >= TRIGGERS_MAX} onClick={() => set({ ...d, when: [...d.when, freshTrigger("hours")] })}>+ add a line</button>
      </section>

      <section className="fe-edsec" data-then>
        <h3>Then, for the blocks in this rule</h3>
        {used.length === 0 && <p className="fe-quiet" data-none>Press a block on the canvas to add it to this rule. The main agent is the Orchestrator at the top.</p>}
        {used.map((f) => {
          const chain = chainOfDraft(d, f)!;
          const label = fieldName(f, flow);
          return (
            <div key={f} className="fe-edrole" data-role={f} onPointerEnter={() => p.onFocusField?.(f)} onFocusCapture={() => p.onFocusField?.(f)}>
              <div className="fe-edrolehead">
                <b>{label} uses, in order:</b>
                <Switch on label={`${label}: in this rule`} onChange={() => set(setDraftChain(d, f, undefined))} />
              </div>
              <DraftChain id={`${uid}-${f}`} label={label} chain={chain} role={f === "orchestrator" ? "orchestrator" : "worker"} readiness={a.readiness}
                onChange={(c) => set(setDraftChain(d, f, c))} />
            </div>
          );
        })}
        {offered.map((f) => (
          <div key={f} className="fe-edrole" data-role={f} data-off>
            <div className="fe-edrolehead">
              <b>{fieldName(f, flow)}</b>
              <Switch on={false} label={`${fieldName(f, flow)}: in this rule`} onChange={() => set(withField(d, f, baseChainOf(policy, f)))} />
            </div>
            <small className="fe-quiet">Role off in this rule · keeps its usual choice</small>
          </div>
        ))}
      </section>

      <section className="fe-edsec" data-preview>
        <h3>What this would do</h3>
        <p className="fe-rulesentence" data-sentence>{ruleLine({ ...rule, name: rule.name || "This rule" }, flow)}</p>
        <div className="fe-edtest">
          <button type="button" className="fe-btn" data-size="sm" data-test onClick={runTest}>Test it now</button>
          {tested && <p role="status" data-tested className="fe-testline">{tested}</p>}
        </div>
      </section>

      {error && <p className="fe-errline" role="alert">{error}</p>}
      <div className="fe-edfoot">
        {initial && <button type="button" className="fe-btn" data-tone="danger" data-size="sm" data-delete disabled={busy}
          onClick={() => { void a.saveRule(withoutRule(policy, initial.id)).then((e) => { if (e) setError(e); else p.onSaved(); }); }}>Delete</button>}
        <span className="fe-sp" />
        <button type="button" className="fe-btn" data-size="sm" data-cancel onClick={p.onLeave}>Cancel</button>
        <button type="button" className="fe-btn" data-tone="primary" data-size="sm" data-save disabled={busy} onClick={() => void save()}>Save for {scope}</button>
      </div>
    </div>
  );
}

export { draftDirty };
