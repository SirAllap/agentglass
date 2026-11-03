/*
 * "Around the flow": the three global switches the flow stands on, set from the
 * canvas — the Orchestrator's engine and model, the Fallback (the usage plan
 * rule) and the Gate. They are not per-agent, so they are not blocks; they sit
 * in a row under the drawing with the flow's own names. The Orchestration page
 * keeps its own copy of the same data (two views, last read wins).
 *
 * The Orchestrator chip opens the orchestrator's sheet (`OrchestratorSheet.tsx`);
 * the Fallback chip opens the side panel. A change made in the sheet saves at
 * once: the chair and the ceiling through `/orchestration` (the page's own call
 * and pure edits), the pilot through its own project setting. The Gate
 * is a switch on its chip, written with `hooksGate`, and a link to Settings
 * where it is explained.
 *
 * Its ceiling, stated: a project that inherits the all-projects policy edits
 * that one (the panel says so); the rule sheet edits the plan rule only.
 */
import { SideGrip } from "./SideGrip.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PolicyRuleState, type SeatAnswer } from "../../../lib/api.ts";
import { openSettings } from "../../../lib/openSettings.ts";
import { agentProvider } from "../../../../../shared/agentKinds.ts";
import { ROLE_IDS, type Policy, type PolicyRule } from "../../../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../../../shared/types.ts";
import { readEngines } from "../../engines/readEngines.ts";
import { Button } from "../../workspace/Chrome.tsx";
import { RuleSheet } from "../RuleForm.tsx";
import { presetChip, presetOffers, ruleHolds, scopeWords, usageLeft, withRule, withoutRule } from "../orchestrationCopy.ts";
import { presetLabel } from "../QuickSetup.tsx";
import { planRule } from "./flowCopy.ts";
import { FallbackControls } from "./FallbackControls.tsx";
import { FlowIcon } from "./flowIcons.tsx";

export type AroundId = "orchestrator" | "fallback";
type Gate = { on: boolean; bundled: boolean };

export interface Around {
  root: string;
  policy: Policy | null;
  readiness: EngineReadiness[] | null;
  seat: SeatAnswer | null;
  gate: Gate | null;
  states: PolicyRuleState[];
  /** The project's own policy is in force; false means the all-projects one is what a save here changes. */
  own: boolean;
  note: string;
  saveRule: (next: Policy) => Promise<string | null>;
  /** Gives a project that follows "All projects" its own copy of the setting; the server's sentence, or null. */
  claim: () => Promise<string | null>;
  setGate: (on: boolean) => Promise<void>;
}

/** What the three chips say, in the flow's own words. */
export function aroundChips(a: Pick<Around, "policy" | "seat" | "gate">) {
  const o = a.policy?.base.orchestrator.value[0];
  const rule = a.policy ? planRule(a.policy) : undefined;
  const usage = rule?.when.find((t): t is Extract<typeof t, { kind: "usage" }> => t.kind === "usage");
  // The engine the rule moves blocks to, as the mockup's chip names it.
  const to = rule ? (rule.orchestrator?.[0] ?? ROLE_IDS.map((id) => rule.workers?.[id]?.[0]).find(Boolean)) : undefined;
  const model = a.seat?.seat?.model || o?.model || "";
  return {
    orchestrator: { name: "Orchestrator", value: o ? `${engineName(o.engine)}${model ? ` · ${model}` : ""}` : "reading…" },
    fallback: { name: "Fallback", value: !a.policy ? "reading…" : !rule ? "no rule" : `${rule.enabled ? "" : "off · "}${usage ? `at ${usage.remainingAtMost} % left` : "on"}${to ? ` · ${engineName(to.engine)}` : ""}` },
    gate: { name: "Gate", value: !a.gate ? "checking…" : !a.gate.bundled ? "not in this build" : a.gate.on ? "on" : "off" },
  };
}

const engineName = (id: string): string => agentProvider(id)?.title ?? id;

/** The one write behind the Orchestrator and Fallback chips: the whole edited policy to `/orchestration`, the project's own only when it has one. */
export const saveAroundPolicy = (next: Policy, root: string, own: boolean) =>
  api.orchestrationSave(next, own && root ? root : undefined).catch(() => ({ ok: false, error: "Could not reach the server." } as const));

/** The one write behind the Gate chip: `/hooks/gate`, nothing else. */
export const switchGate = (on: boolean) =>
  api.hooksGate(on).catch(() => ({ ok: false, error: "Could not reach the server." } as const));

export function useAround(root: string): Around {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [own, setOwn] = useState(false);
  const [readiness, setReadiness] = useState<EngineReadiness[] | null>(null);
  const [seat, setSeat] = useState<SeatAnswer | null>(null);
  const [gate, setGateState] = useState<Gate | null>(null);
  const [states, setStates] = useState<PolicyRuleState[]>([]);
  const [note, setNote] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    void api.orchestration(root || undefined).then((r) => { if (alive.current) { if (r.ok) { setPolicy(r.policy); setOwn(r.scope === "project"); } else setNote("The policy could not be read."); } }).catch(() => { if (alive.current) setNote("Could not reach the server."); });
    void api.orchestrationState().then((r) => { if (alive.current && r.ok) setStates(r.rules); }).catch(() => { /* keeps what is on screen */ });
    if (root) void api.seat(root).then((r) => { if (alive.current) setSeat(r); }).catch(() => { if (alive.current) setSeat(null); });
    else setSeat(null);
  }, [root]);
  // A block panel or the role sheet saved the policy: the canvas reads it again, so its cards say what now runs.
  useEffect(() => {
    const again = () => { void api.orchestration(root || undefined).then((r) => { if (alive.current && r.ok) { setPolicy(r.policy); setOwn(r.scope === "project"); } }).catch(() => { /* keeps what is on screen */ }); void api.orchestrationState().then((r) => { if (alive.current && r.ok) setStates(r.rules); }).catch(() => { /* keeps what is on screen */ }); };
    window.addEventListener("agx:policy-saved", again);
    return () => window.removeEventListener("agx:policy-saved", again);
  }, [root]);
  useEffect(() => {
    void readEngines((fresh) => api.engines(fresh), (r) => { if (alive.current) setReadiness(r.engines); }, { alive: () => alive.current }).catch(() => { /* the rows say "checking" */ });
    void api.hooksStatus().then((r) => { if (alive.current) setGateState({ on: r.gate, bundled: r.gateBundled }); }).catch(() => { /* the chip says it is checking */ });
  }, []);

  // A project that inherits saves to the all-projects policy, as the page does when it shows "All projects".
  const saveRule = useCallback(async (next: Policy): Promise<string | null> => {
    const r = await saveAroundPolicy(next, root, own);
    if (!alive.current) return null;
    if (!r.ok || !r.policy) { const e = r.error ?? "Could not save."; setNote(e); return e; }
    setNote("");
    setPolicy(r.policy);
    void api.orchestrationState().then((s) => { if (alive.current && s.ok) setStates(s.rules); }).catch(() => { /* keeps what is on screen */ });
    return null;
  }, [own, root]);

  const claim = useCallback(async (): Promise<string | null> => {
    if (!policy || !root) return "Open a project first.";
    const r = await saveAroundPolicy(policy, root, true);
    if (!alive.current) return null;
    if (!r.ok || !r.policy) return r.error ?? "Could not save.";
    setOwn(true); setPolicy(r.policy); setNote("");
    void api.orchestrationState().then((s) => { if (alive.current && s.ok) setStates(s.rules); }).catch(() => { /* keeps what is on screen */ });
    return null;
  }, [policy, root]);

  const setGate = useCallback(async (on: boolean) => {
    const r = await switchGate(on);
    if (!alive.current) return;
    setNote(r.ok ? "" : r.error ?? "Could not update the Gate.");
    await api.hooksStatus().then((s) => { if (alive.current) setGateState({ on: s.gate, bundled: s.gateBundled }); }).catch(() => { /* keeps the old state */ });
  }, []);

  return { root, policy, readiness, seat, gate, states, own, note, saveRule, claim, setGate };
}

/** The row under the canvas: two chips that open the side panel, and the Gate with its own switch. */
export interface RuleTools {
  presetsOpen: boolean; conditionsOpen: boolean; editing: boolean;
  /** Rules that hold right now, whether one of them is moving a block, and how many are off. */
  count: number; off: number; acting: boolean;
  onPresets: (el: HTMLElement) => void; onConditions: () => void;
}

export function AroundRow({ a, open, onOpen, tools }: { a: Around; open: AroundId | null; onOpen: (id: AroundId) => void; tools?: RuleTools }) {
  const c = aroundChips(a);
  const bundled = !!a.gate?.bundled;
  // The preset in force, in the mockup's one-word label beside "Presets": read from the offers the drawer lists, never a constant.
  const presetWord = a.policy ? presetChip(presetOffers(a.readiness, a.policy, null), presetLabel).text : "reading…";
  return (
    <div className="fe-around" role="group" aria-label="Around the flow">
      {tools && (
        <>
          <button type="button" className="fe-achip" data-presets aria-expanded={tools.presetsOpen} aria-controls="fe-presets" onClick={(e) => tools.onPresets(e.currentTarget)}>
            <FlowIcon name="layers" size={12} />
            <span className="fe-achiptxt"><b>Presets</b><small>{presetWord}</small></span>
            <FlowIcon name="chev" size={12} />
          </button>
          <button type="button" className="fe-achip" data-conditions data-open={tools.conditionsOpen ? "" : undefined} aria-pressed={tools.conditionsOpen} onClick={tools.onConditions}>
            {tools.acting && <i className="fe-adot" aria-hidden="true" />}
            <FlowIcon name="gauge" size={12} />
            <span className="fe-achiptxt"><b>Conditions</b><small>{tools.editing ? "editing a rule" : `${tools.count} on, ${tools.off} off`}</small></span>
          </button>
        </>
      )}
      <span className="fe-aroundtitle">Around the flow</span>
      <button type="button" className="fe-achip" aria-pressed={open === "orchestrator"} onClick={() => onOpen("orchestrator")}>
        <FlowIcon name="users" size={12} /><span className="fe-achiptxt"><b>{c.orchestrator.name}</b><small>{c.orchestrator.value}</small></span>
      </button>
      <button type="button" className="fe-achip" data-dashed="" aria-pressed={open === "fallback"} onClick={() => onOpen("fallback")}>
        <FlowIcon name="undo" size={12} /><span className="fe-achiptxt"><b>{c.fallback.name}</b><small>{c.fallback.value}</small></span>
      </button>
      <div className="fe-achip" data-kind="gate">
        <FlowIcon name="shield" size={12} /><span className="fe-achiptxt"><b>{c.gate.name}</b><small>{c.gate.value}</small></span>
        <button type="button" role="switch" aria-checked={!!a.gate?.on} aria-label="Gate" className="fe-switch" data-on={a.gate?.on ? "" : undefined}
          disabled={!bundled} onClick={() => void a.setGate(!a.gate!.on)}><span className="fe-track" /></button>
        <button type="button" className="fe-alink" onClick={() => openSettings("hooks")}>Settings</button>
      </div>
    </div>
  );
}

/** The side panel for the Fallback chip; 292px of content, rows stack. The Orchestrator has its own sheet. */
export function AroundSide({ a, onClose }: { a: Around; onClose: () => void }) {
  const [sheet, setSheet] = useState<"new" | "edit" | null>(null);
  const policy = a.policy;
  const scope = a.own ? a.root : "";
  const rule = policy ? planRule(policy) : undefined;
  return (
    <aside className="fe-side fe-aroundside" aria-label="Fallback">
      <SideGrip />
      <div className="fe-sidehead" style={{ "--hue": "var(--text3)" } as React.CSSProperties}>
        <span className="fe-ico" aria-hidden="true"><FlowIcon name="undo" size={13} /></span>
        <div><h2>Fallback</h2><p>Around the flow · saves at once</p></div>
        <span className="fe-sp" />
        <button className="fe-sq" type="button" title="Close" aria-label="Close" onClick={onClose}><FlowIcon name="x" size={12} /></button>
      </div>
      <div className="fe-sidescroll">
        {!policy ? <p className="fe-quiet" role={a.note ? "alert" : undefined}>{a.note || "Reading the policy…"}</p>
          : (
            <div className="fe-aroundfb">
              <FallbackControls stacked watch={rule} policy={policy} readiness={a.readiness} disabled={false}
                onEditRule={(r) => void a.saveRule({ ...policy, rules: policy.rules.map((x) => (x.id === r.id ? r : x)) })} />
              <Button onClick={() => setSheet(rule ? "edit" : "new")}>{rule ? "Open the rule" : "Add a usage rule"}</Button>
            </div>
          )}
        <small className="fe-quiet">{a.own ? `Set for ${scopeWords(a.root)}.` : "Applies to all projects."}</small>
        {a.note && policy && <p className="fe-errline" role="alert">{a.note}</p>}
      </div>
      {sheet && policy && (
        <RuleSheet key={sheet} initial={sheet === "edit" ? rule ?? null : null} policy={policy} readiness={a.readiness} scope={scopeWords(scope)}
          facts={{ on: ruleHolds(a.states, scope || "global") }} left={usageLeft(a.states, scope || "global")} now={new Date()} onCancel={() => setSheet(null)}
          onDelete={sheet === "edit" && rule ? () => { void a.saveRule(withoutRule(policy, rule.id)).then((e) => { if (!e) setSheet(null); }); } : undefined}
          onSave={async (r: PolicyRule) => { const e = await a.saveRule(withRule(policy, r)); if (!e) setSheet(null); return e; }} />
      )}
    </aside>
  );
}
