import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Filter, SettingRow } from "../SettingRow.tsx";
import { useReportHead } from "../SettingsPageState.tsx";
import { SettingsCard } from "../SettingsKit.tsx";
import { Select } from "../Select.tsx";
import { PanesIcon } from "../settingsNavIcons.tsx";
import { PAGE_BTN_SM } from "./OrchKit.tsx";
import { StarIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, LINE } from "../workspace/Chrome.tsx";
import { api, type PolicyRuleState, type SeatAnswer } from "../../lib/api.ts";
import { openSettings } from "../../lib/openSettings.ts";
import type { Policy, PolicyRule } from "../../../../shared/orchestration.ts";
import { usageProvider } from "../../../../shared/orchestration.ts";
import type { EngineReadiness, EnginesReport } from "../../../../shared/types.ts";
import type { Flow } from "../../../../shared/flow.ts";
import { pathRoles } from "../../../../shared/flow.ts";
import { validatePresetList, type PresetFile, type PresetTarget } from "../../../../shared/preset.ts";
import { readEngines } from "../engines/readEngines.ts";
import { flowLikeOf } from "../../lib/roleLabel.ts";
import { RuleStrip } from "./RuleStrips.tsx";
import { presetLabel } from "./QuickSetup.tsx";
import { ScopeBar } from "./ScopeBar.tsx";
import { InheritedNote, LoadFailed, NothingSetUp, SavedChip, SpecificNote } from "./OrchStates.tsx";
import { Note } from "./SafetyParts.tsx";
import { DenyBox } from "./SafetyParts.tsx";
import { FlowIcon } from "./flow/flowIcons.tsx";
import { FlowSlot } from "./flow/FlowSlot.tsx";
import { RefusedSection, SafetySection } from "./flow/FlowSections.tsx";
import { DEFAULT_ROUNDS } from "./flow/flowCopy.ts";
import { OPEN_CONDITIONS, OPEN_PRESETS } from "./flow/FlowSlot.tsx";
import { REVIEW_SETTING_IDS } from "../../../../shared/reviewSettings.ts";
import { rowId } from "../../lib/settingsIndex.ts";
import { reducedMotion } from "../../lib/lookPrefs.ts";
import { PILOT_CHIP } from "../../lib/pilotSettings.ts";
import type { Pilot } from "../../lib/flightPilot.ts";
import type { HeaderChip } from "../../lib/settingsNav.ts";
import { MOCKUP_INK, OrchestratorHero, type HeroPathStep } from "./OrchestratorHero.tsx";
import { PresetCards } from "./PresetCards.tsx";
import { useRoleCounts } from "../../lib/useRoleCounts.ts";
import { orchestratorCardModel } from "../../lib/orchestratorCardView.ts";
import {
  baseChoice, presetChip, presetOffers, scopeWords, usageLeft, usageWord, openingScope, recallScope, rememberScope,
  ruleBadge, ruleLine, shippedPresets, stepLimit,
  withEnvelopes, withLimits, withRuleEnabled,
} from "./orchestrationCopy.ts";

/**
 * How work is handed out: which engine sits in a project's chair, which ones
 * do the work it gives out, and the rules that change that for a while.
 *
 * Only a person changes the policy cards. Nothing on them has a setting id, so an
 * agent can open and read them and cannot write them: the orchestrator works
 * inside this policy. Polaris — its doors, presets and limits — has its own page
 * beside this one (`polaris.*` setting ids), and the card at the foot of this
 * page only points there.
 *
 * Nothing polls. The page reads the policy, the engines, the rules' state and the
 * Polaris doors when it opens, when the project changes and after each save; the
 * server settles a rule's switch and wakes the Polaris sweep on the events that
 * change a reading, so the badges are as fresh as the last time somebody looked.
 */

/** What the view needs of the chair for the project it is showing. */
export interface SeatFacts { live: boolean; model: string; models: { id: string; label: string }[] }

export interface OrchestrationViewProps {
  policy: Policy;
  scope: "project" | "global";
  /** "" is All projects. */
  root: string;
  projects: string[];
  /** The projects that have a setting of their own. */
  overrides?: string[];
  /** null until the probe has answered: every engine reads "Checking". */
  readiness: EngineReadiness[] | null;
  states: PolicyRuleState[];
  /** null for All projects, or before the chair has answered. */
  seat: SeatFacts | null;
  /** The server's sentence for a refusal, by the card that asked. */
  notes: Record<string, string>;
  busy: boolean;
  /** The last policy save through this page was refused: the chip in the scope bar says so. */
  saveFailed?: boolean;
  /** A rule's form or the new-rule form open from the start (a test and a screenshot show it). */
  openRule?: string | "new";
  /** The moment the strips mark as now; the clock when left out. */
  now?: Date;
  /** A section saved or linked to; the retired "block" and anything unknown open Safety and limits. */
  section?: string;
  onRoot: (root: string) => void;
  /** Answers null when it saved, or the server's sentence. */
  onSave: (next: Policy, card: string) => Promise<string | null>;
  onScope: (override: boolean) => void;
  onOpenEngines: () => void;
  /** Drawn directly under the scope bar: the page's own link row, never above the bar. */
  lead?: ReactNode;
  /** The person's own presets, read by the pane. */
  presets?: PresetFile[];
  /** Saves a preset's policy and flow through the page's own routes: null when it saved, else the sentence. */
  onApplyFlow?: (flow: Flow) => Promise<string | null>;
  onSavePreset?: (preset: PresetFile) => Promise<string | null>;
  onDeletePreset?: (name: string) => Promise<string | null>;
  /**
   * The Flow editor, read from the server by its own component: this view makes no request.
   * It opens when `editReq` counts up, and hands back the flow's names for the roles and the flow itself.
   */
  flowSlot?: (editReq: number, onNames: (n: FlowNames, flow: Flow | null) => void, editBlock?: string) => ReactNode;
}

/** The page, drawn from what it is handed: no request is made here. */
export function OrchestrationView(p: OrchestrationViewProps) {
  const { policy, readiness, states, root, notes, busy } = p;
  // The section under the pointer card.
  const [section, setSection] = useState<FlowSection>(() => asSection(p.section));
  const [flowNames, setFlowNames] = useState<FlowNames>({});
  /** The flow the editor last read: the hero's path and the presets' target. */
  const [flow, setFlow] = useState<Flow | null>(null);
  /** The names and the flow arrive together, from the slot's one read. */
  const onFlowRead = useCallback((names: FlowNames, read: Flow | null) => { setFlowNames(names); setFlow(read); }, []);
  /** The flow's names for the policy roles: every sentence on this page prints these, never the policy's. */
  const flowLike = useMemo(() => flowLikeOf(flowNames), [flowNames]);
  /** Counts the presses of "Open the Flow editor"; the slot opens the editor when it changes. */
  const [editReq, setEditReq] = useState(0);
  /** The policy role the editor opens selected on; none opens it unselected. */
  const [editBlock, setEditBlock] = useState<string | undefined>(undefined);
  /** The presets sheet under the hero: named setups live behind its chip, not in the page body. */
  const [presetsOpen, setPresetsOpen] = useState(false);
  // The round cap is a server setting the page reads for this project: the limits say when round N+1 does not start.
  const [rounds, setRounds] = useState(DEFAULT_ROUNDS);
  useEffect(() => {
    let live = true;
    void api.settingAt(REVIEW_SETTING_IDS.rounds, root).catch(() => null).then((r) => {
      if (live) setRounds(r?.ok && typeof r.value === "number" ? r.value : DEFAULT_ROUNDS);
    });
    return () => { live = false; };
  }, [root]);

  // The pilot the hero's chip names. Nothing is guessed before the read: the chip is drawn empty.
  const [mode, setMode] = useState("");
  useEffect(() => {
    let tag = true;
    void api.settingAt("flightPlan.pilot", root).catch(() => null).then((r) => {
      if (tag) setMode(r?.ok && typeof r.value === "string" ? PILOT_CHIP[r.value as Pilot] ?? "" : "");
    });
    return () => { tag = false; };
  }, [root]);

  const [env, setEnv] = useState({ ceiling: policy.ceiling, workerDefault: policy.workerDefault });
  // A save, or a project switch, brings a policy the draft did not make.
  useEffect(() => { setEnv({ ceiling: policy.ceiling, workerDefault: policy.workerDefault }); }, [policy]);

  const inherited = root !== "" && p.scope === "global";
  const locked = inherited || busy;
  const save = p.onSave;
  // The global policy and a project's own share rule ids; read the states of this one.
  const scopeKey = inherited || root === "" ? "global" : root;

  const scopeWord = scopeWords(root);
  const setLimit = (k: keyof Policy["limits"], to: number) => {
    const by = to > policy.limits[k] ? 1 : -1;
    void save(withLimits(policy, { [k]: stepLimit(k, policy.limits[k], by) }), "limits");
  };

  const dirty = JSON.stringify(env) !== JSON.stringify({ ceiling: policy.ceiling, workerDefault: policy.workerDefault });
  const SECTIONS: { id: FlowSection; label: string; icon: React.ReactNode }[] = [
    { id: "safety", label: "Safety and limits", icon: <FlowIcon name="shield" size={ICON.sm} /> },
    { id: "refused", label: "Always refused", icon: <FlowIcon name="lock" size={ICON.sm} /> },
  ];
  const specific = root !== "" && !inherited;
  const openFlowEditor = (block?: string) => { setEditBlock(block); setEditReq((n) => n + 1); };
  const chair = baseChoice(policy, "orchestrator");
  // The board's counts, from the app's one poller: the hero's three numbers and the path's discs.
  // Before the flow is read there is no roster to count, so nothing is counted (not zero).
  const board = useRoleCounts(flow ?? NO_FLOW, root, policy.limits);
  const live = flow ? board : { counts: null, inFlight: null, last: null };
  const left = usageLeft(states, scopeKey);
  const planOf = chair.engine ? usageProvider(chair.engine) : null;
  const planLeft = planOf === null ? undefined : left[planOf];
  const planUsed = typeof planLeft === "number" ? Math.min(100, Math.max(0, Math.round(100 - planLeft))) : null;
  const moveAt = planOf === null ? undefined : policy.rules
    .filter((r) => r.enabled)
    .flatMap((r) => r.when)
    .find((t) => t.kind === "usage" && t.provider === planOf);
  const planMark = moveAt && moveAt.kind === "usage" ? Math.min(100, Math.max(0, 100 - moveAt.remainingAtMost)) : null;
  const readout = orchestratorCardModel(flow ?? NO_FLOW, {
    chair: chair.engine ? { engine: chair.engine, model: chair.model } : null,
    planLeft: left, maxWorkers: policy.limits.maxWorkers,
    last: live.last?.line ?? null, counts: live.counts,
  });
  const steps: HeroPathStep[] = flow ? pathRoles(flow).map((r) => {
    const counts = live.counts?.[r.id];
    const choice = r.policyRole ? baseChoice(policy, r.policyRole) : r.chain[0] ?? { engine: "", model: "" };
    return { id: r.id, name: r.name, hue: r.hue, ico: r.ico, engine: choice.engine, run: counts?.run ?? 0, wait: counts?.wait ?? 0, you: r.actor === "person" };
  }) : [];

  // Under All projects the flow read is the first project's, so there is no flow above this page for a preset to change.
  const target: PresetTarget = { policy, flow: root ? flow : null };
  const applyPresetHere = async (next: PresetTarget): Promise<string | null> => {
    const e = await save(next.policy, "preset");
    if (e) return e;
    // A preset that carries no flow (under All projects, or the policy parts only) leaves the flow this page read alone.
    if (!next.flow || next.flow === flow) return null;
    setFlow(next.flow);
    return p.onApplyFlow ? p.onApplyFlow(next.flow) : null;
  };
  // The page's one primary action is the hero's, in the body: the page header carries none.
  useReportHead("orchestration", null);
  // A settings search lists matching rows only; the review rows below exist for it.
  const searching = useContext(Filter).on;

  return (
    <div className="agx-orch agx-flow" style={{ "--accent": MOCKUP_INK.accent } as React.CSSProperties}
      onKeyDown={(e) => {
        const n = ["1", "2"].indexOf(e.key);
        if (!e.altKey || n < 0) return;
        e.preventDefault();
        setSection(SECTIONS[n]!.id);
      }}>
      {/* The project row, then the hero, then the tabs. */}
      <div className="agx-flow-pinned">
        <ScopeBar root={root} projects={p.projects} overrides={p.overrides ?? []}
          note={notes.scope} onRoot={p.onRoot} lead={p.lead}
          saved={<SavedChip saving={busy} failed={!!p.saveFailed} dirty={dirty} word={scopeWord} />} />

        {/* The three review settings are set on the reviewing block. These rows exist for settings search only: a hit opens the Flow editor on it. */}
        {searching && (
          <SettingsCard title="Who reviews" icon={<PanesIcon size={ICON.sm} />}>
          <SettingRow agentExempt label="Conditions" hint="Rules that change which engine a block uses for a while. Set on the canvas, on the blocks they change."
            actions={<Button onClick={() => openFlowEditor(OPEN_CONDITIONS)}>Open Conditions on the canvas</Button>} />
          <SettingRow agentExempt label="Presets" hint="Named setups to start from: see what each one does to the blocks before you use it."
            actions={<Button onClick={() => openFlowEditor(OPEN_PRESETS)}>Open Presets on the canvas</Button>} />
            <SettingRow settingId="orchestration.review.who" label="Who reviews and checks" hint="One answer per project. Set on the reviewing block in the Flow editor."
              actions={<Button onClick={() => openFlowEditor("reviewer")}>Open at the reviewing block</Button>} />
            <SettingRow settingId="orchestration.review.rounds" label="Most rounds before it stops" hint="The review loop's cap, 1 to 6. Set on the reviewing block in the Flow editor."
              actions={<Button onClick={() => openFlowEditor("reviewer")}>Open at the reviewing block</Button>} />
            <SettingRow settingId="orchestration.review.second" label="Second reviewer on another model" hint="A second reader of the same diff on another engine. Set on the reviewing block in the Flow editor."
              actions={<Button onClick={() => openFlowEditor("reviewer")}>Open at the reviewing block</Button>} />
          </SettingsCard>
        )}
        {p.flowSlot?.(editReq, onFlowRead, editBlock)}
      </div>

      <div className="agx-flow-pg">
        {inherited && <InheritedNote name={scopeWord} busy={busy} onMakeSpecific={() => p.onScope(true)} />}
        {specific && <SpecificNote name={scopeWord} busy={busy} onGeneral={() => p.onScope(false)} />}

        <h2 className="agx-flow-t">Orchestration{" "}
          <span className="agx-flow-inf" tabIndex={0} data-tip="How the work is split between agents, on which engine, and what they may never do.">i</span>
        </h2>

        <OrchestratorHero chair={chair.engine ? { engine: chair.engine, model: chair.model } : null} mode={mode}
          path={steps}
          presetsOpen={presetsOpen} onOpenPresets={() => setPresetsOpen((on) => !on)}
          live={{
            plan: { label: planOf === null ? "Plan used" : `${usageWord(planOf)} plan used`, used: planUsed, mark: planMark },
            flight: live.inFlight,
            today: readout.today === "\u2014" ? null : readout.today,
            // The block's own name and when, never the words a worker wrote: that line is its message, not a reading.
            last: live.last ? { name: steps.find((s) => s.id === live.last!.role)?.name ?? "A block", at: live.last.at } : null,
          }}
          conditionsOn={policy.rules.filter((r) => r.enabled).length}
          onConfigure={() => openFlowEditor()} onOpenConditions={() => openFlowEditor(OPEN_CONDITIONS)} onOpenFlow={() => openFlowEditor()} />

        {presetsOpen && (
          <div className="agx-flow-presets-sheet" data-presets-sheet>
            <PresetCards target={target} projectRoot={root} shipped={shippedPresets(policy, readiness)} mine={p.presets ?? []}
              busy={busy} note={notes.preset} onApply={applyPresetHere}
              onSaveMine={p.onSavePreset} onDeleteMine={p.onDeletePreset} />
          </div>
        )}

        <div className="agx-flow-cfg">
          <div className="agx-flow-cfgbar">
            <div className="agx-flow-tabs" role="tablist" aria-label="Configuration sections">
              {SECTIONS.map((s) => (
                <button key={s.id} type="button" role="tab" aria-selected={section === s.id} aria-controls={`agx-flow-${s.id}`}
                  onClick={() => setSection(s.id)}>{s.icon}{s.label}</button>
              ))}
            </div>
          </div>

          <div className="agx-flow-cfgscroll">
            <section role="tabpanel" id="agx-flow-safety" aria-label="Safety and limits" hidden={section !== "safety"}>
              <SafetySection policy={policy} env={env} onEnv={setEnv} onLimits={setLimit} locked={locked}
                note={notes.envelope || notes.limits} rounds={rounds} root={root}
                onSeeRefused={() => setSection("refused")} />
            </section>

            <section role="tabpanel" id="agx-flow-refused" aria-label="Always refused" hidden={section !== "refused"}>
              <RefusedSection policy={policy} locked={locked} note={notes.envelope} scopeWord={scopeWord}
                onDeny={(deny) => setEnv({ ...env, workerDefault: { ...env.workerDefault, deny } })} />
            </section>
          </div>
        </div>
      </div>

      {/* One bar for both sections, and only while something is unsaved: the page writes the whole draft at once. */}
      {dirty && (
        <div className="agx-flow-savebar" data-savebar>
          <FlowIcon name="alert" size={ICON.sm} />
          <span><b>Permissions not saved.</b> Workers keep the old ones until you save.</span>
          <span className="agx-flow-sp" />
          <Button style={PAGE_BTN_SM} onClick={() => setEnv({ ceiling: policy.ceiling, workerDefault: policy.workerDefault })}>Discard</Button>
          <Button tone="primary" style={PAGE_BTN_SM} disabled={locked} onClick={() => void save(withEnvelopes(policy, env), "envelope")}>Save these permissions</Button>
        </div>
      )}

    </div>
  );
}

/** What the flow calls each block that runs a policy role, by that role's id. */
type FlowNames = Record<string, { name: string; does: string }>;

type FlowSection = "safety" | "refused";

/** A saved or deep-linked section; the retired "block", "keys" (and anything unknown) read as the default. */
export const asSection = (v: unknown): FlowSection => v === "refused" ? v : "safety";

const storage = (): Storage | null => { try { return localStorage; } catch { return null; } };

/** What `useRoleCounts` reads before a project has a flow: a roster of nobody, so no count is invented. */
const NO_FLOW: Flow = { version: 1, path: [], blocks: [], roster: [], stages: [], edges: [] };

export function OrchestrationPane({ onChip, lead }: { onChip?: (c: HeaderChip | null) => void; lead?: ReactNode } = {}) {
  // Remembered for this window, so leaving Settings and coming back does not
  // read as the project's setting being lost. Never chosen: the project the app shows.
  const chosen = useRef<boolean>(recallScope(storage()) !== null);
  const [root, setRoot] = useState(() => recallScope(storage()) ?? "");
  const pick = useCallback((r: string) => { chosen.current = true; rememberScope(storage(), r); setRoot(r); }, []);
  const [loaded, setLoaded] = useState<{ policy: Policy; scope: "project" | "global"; overrides: string[] } | null>(null);
  const [report, setReport] = useState<EnginesReport | null>(null);
  const [states, setStates] = useState<PolicyRuleState[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [seat, setSeat] = useState<SeatAnswer | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  /** The last save was refused, so the chip in the scope bar says the setting was not kept. */
  const [saveFailed, setSaveFailed] = useState(false);
  const [workspacesKnown, setWorkspacesKnown] = useState(false);
  const [startedGlobal, setStartedGlobal] = useState(false);
  const alive = useRef(true);
  // An effect runs again in development (and whenever React remounts it), and the
  // ref outlives the cleanup: without the reset every later answer is dropped.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const loadStates = useCallback(() => {
    void api.orchestrationState().then((r) => { if (alive.current && r.ok) setStates(r.rules); }).catch(() => { /* a failed read keeps what is on screen */ });
  }, []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const loadPolicy = useCallback((forRoot: string) => {
    void api.orchestration(forRoot || undefined).then((r) => {
      if (!alive.current) return;
      if (r.ok) { setLoaded({ policy: r.policy, scope: r.scope, overrides: r.overrides }); setLoadError(null); setSaveFailed(false); }
      else setLoadError((r as { error?: string }).error ?? "The server did not answer.");
    }).catch(() => { if (alive.current) setLoadError("Could not reach the server."); }).finally(() => { if (alive.current) setRetrying(false); });
    loadStates();
    if (forRoot) void api.seat(forRoot).then((r) => { if (alive.current) setSeat(r); }).catch(() => { if (alive.current) setSeat(null); });
    else setSeat(null);
  }, [loadStates]);

  useEffect(() => {
    void readEngines((fresh) => api.engines(fresh), setReport, { alive: () => alive.current }).catch(() => { /* the rows say "checking" until it answers */ });
    void api.projects().then((r) => {
      if (!alive.current) return;
      const ws = r.workspaces ?? (r.workspace ? [r.workspace] : []);
      setWorkspaces(ws);
      setWorkspacesKnown(true);
      if (!chosen.current) setRoot(openingScope(null, ws, ws[0] ?? null));
    }).catch(() => { /* no project switch without a list */ });
  }, []);
  useEffect(() => { loadPolicy(root); }, [root, loadPolicy]);

  // A person's own presets live on the server, per project like the other settings here.
  const [presets, setPresets] = useState<PresetFile[]>([]);
  const loadPresets = useCallback((forRoot: string) => {
    void api.settingAt("orchestration.presets", forRoot).catch(() => null).then((r) => {
      if (!alive.current) return;
      const v = r?.ok ? validatePresetList(r.value ?? []) : null;
      setPresets(v?.ok ? v.value : []);
    });
  }, []);
  useEffect(() => { loadPresets(root); }, [root, loadPresets]);

  // The header chip names the setup in force: the preset that is on, or none.
  const readiness = report?.engines ?? null;
  useEffect(() => {
    if (!onChip) return;
    if (!loaded) { onChip(null); return; }
    onChip(presetChip(presetOffers(readiness, loaded.policy), presetLabel));
    return () => onChip(null);
  }, [onChip, loaded, readiness]);

  const projects = useMemo(() => [...new Set([...workspaces, ...(loaded?.overrides ?? [])])], [workspaces, loaded?.overrides]);

  /** Store the person's presets as one list; the door validates it like every other setting. */
  const writePresets = async (next: PresetFile[], failure: string): Promise<string | null> => {
    const r = await api.settingAtSet("orchestration.presets", next, root).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
    if (!alive.current) return null;
    if (!r.ok) return r.error ?? failure;
    setPresets(next);
    return null;
  };
  const savePreset = async (preset: PresetFile): Promise<string | null> => {
    const next = [...presets.filter((x) => x.name !== preset.name), preset];
    return writePresets(next, `Could not save "${preset.name}".`);
  };
  const deletePreset = async (name: string): Promise<string | null> => writePresets(presets.filter((x) => x.name !== name), `Could not delete "${name}".`);
  /** A preset's flow half: a flow belongs to one project, so All projects has none to write. */
  const applyFlow = async (flow: Flow): Promise<string | null> => {
    if (!root) return "The permissions and rules were saved. A flow belongs to one project: pick one above, then apply the flow part again.";
    const r = await api.putFlow(root, flow).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
    if (!alive.current) return null;
    return r.ok ? null : `The permissions and rules were saved; the flow was not: ${r.error ?? "the server did not answer."}`;
  };

  /** Store the whole policy. Answers null when it saved, or the server's sentence, which also goes under the control that asked; nothing else moves. */
  const save = async (next: Policy, card: string): Promise<string | null> => {
    setBusy(true);
    const r = await api.orchestrationSave(next, root || undefined).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
    if (!alive.current) return null;
    setBusy(false);
    setSaveFailed(!r.ok || !r.policy);
    if (!r.ok || !r.policy) { const e = r.error ?? "Could not save."; setNotes((n) => ({ ...n, [card]: e })); return e; }
    setNotes((n) => ({ ...n, [card]: "" }));
    setLoaded({ policy: r.policy, scope: r.scope ?? "global", overrides: r.overrides ?? [] });
    loadStates();
    return null;
  };

  const setScope = async (override: boolean) => {
    if (!loaded) return;
    setBusy(true);
    const r = await api.orchestrationSave(override ? loaded.policy : null, root).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
    if (!alive.current) return;
    setBusy(false);
    if (!r.ok) { setNotes((n) => ({ ...n, scope: r.error ?? "Could not save." })); return; }
    setNotes((n) => ({ ...n, scope: "" }));
    loadPolicy(root);
  };

  // Nothing open and nothing chosen: say so, and offer the one thing that works without a project.
  if (workspacesKnown && workspaces.length === 0 && !chosen.current && root === "" && !startedGlobal) {
    return <NothingSetUp onStart={() => setStartedGlobal(true)} />;
  }

  // Before there is a policy to draw: a failed read says what the server answered, and the wait is a skeleton.
  if (!loaded) {
    if (loadError) {
      return <LoadFailed name={root ? root.split("/").filter(Boolean).pop()! : "all projects"} error={loadError} retrying={retrying}
        onRetry={() => { setRetrying(true); loadPolicy(root); }} />;
    }
    return (
      <div className="agx-orch grid gap-3" aria-busy="true" aria-label="Loading">
        <div className="agx-skel rounded-lg" style={{ height: 12, width: 140 }} />
        <div className="agx-skel rounded-lg" style={{ height: 200 }} />
        <div className="agx-skel rounded-lg" style={{ height: 32, width: "60%" }} />
        <div className="agx-presets">{[0, 1, 2].map((i) => <div key={i} className="agx-skel rounded-lg" style={{ height: 200 }} />)}</div>
      </div>
    );
  }
  return (
    <OrchestrationView policy={loaded.policy} scope={loaded.scope} root={root} projects={projects} overrides={loaded.overrides}
      readiness={readiness} states={states}
      seat={root && seat ? { live: seat.live && !!seat.seat, model: seat.seat?.model ?? "", models: seat.models } : null}
      notes={notes} busy={busy} saveFailed={saveFailed} onRoot={pick} onSave={save} onScope={(o) => void setScope(o)}
      onOpenEngines={() => openSettings("engines")} lead={lead}
      presets={presets} onApplyFlow={applyFlow} onSavePreset={savePreset} onDeletePreset={deletePreset}
      flowSlot={(editReq, onNames, editBlock) => <FlowSlot root={root} projects={projects} editReq={editReq} editBlock={editBlock} onNames={onNames} onPolicySaved={() => loadPolicy(root)} />} />
  );
}
