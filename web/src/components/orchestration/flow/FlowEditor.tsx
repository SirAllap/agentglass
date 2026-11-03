/*
 * The Flow editor: the full-screen place where a project's flow is shaped. A bar
 * on top (back, which project, Canvas and Board, Add block, Done), the honesty
 * line under it, the team on the left, the canvas in the middle and the open
 * block on the right. The Flow value lives here and nowhere else: the canvas,
 * the panel and both sheets read it and hand back a new one, and every change
 * is stored as it is made, so Done only closes.
 *
 * Its ceiling, stated: the Board is drawn and off ("Coming soon"); a flow
 * belongs to one project, so there is no "All projects" flow to edit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { roleById, type Flow } from "../../../../../shared/flow.ts";
import { templateFlow } from "../../../../../shared/flowTemplates.ts";
import { api } from "../../../lib/api.ts";
import { endIndex, failOf, flowCounts, moveBlock, movePath, placeOnPath, removeFromPath, setFail } from "../../../lib/flowEdit.ts";
import { flowViewState, organicBlocks } from "../../../lib/flowView.ts";
import { LAYER } from "../../../lib/layers.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { Portal } from "../../Portal.tsx";
import { REVIEW_SETTING_IDS, isReviewWho, type ReviewWho } from "../../../../../shared/reviewSettings.ts";
import { AroundRow, AroundSide, useAround, type AroundId } from "./AroundFlow.tsx";
import { OrchestratorSheet } from "./OrchestratorSheet.tsx";
import { MOCKUP_INK } from "../OrchestratorHero.tsx";
import type { OrchestratorCardData } from "../../../lib/orchestratorCardView.ts";
import { FlowCanvas } from "./FlowCanvas.tsx";
import { conditionCounts, marksHit, marksInForce, marksPreview, marksReadiness, mergeMarks } from "./canvasRules.ts";
import { applyPreset, ruleHolds, usageLeft, type PresetId } from "../orchestrationCopy.ts";
import { PresetsLayer } from "./PresetsLayer.tsx";
import { ConditionsPanel } from "./ConditionsPanel.tsx";
import { RuleEditor } from "./RuleEditor.tsx";
import { baseChainOf, marksEditing } from "./canvasRules.ts";
import { draftDirty, draftOf, withField, type Draft } from "../ruleDraft.ts";
import { freshTrigger } from "../RuleForm.tsx";
import type { PolicyRule } from "../../../../../shared/orchestration.ts";
import type { Field as FieldId } from "../orchestrationCopy.ts";
import { FlowIcon } from "./flowIcons.tsx";
import { WorkerEditor, type WorkerEdit } from "./WorkerEditor.tsx";
import { WorkerPanel } from "./WorkerPanel.tsx";
import type { LiveCounts } from "../../../lib/workerCardView.ts";
import { FlowRootContext } from "./PolicyRoleControls.tsx";
import { PILOT_CHIP } from "../../../lib/pilotSettings.ts";
import type { Pilot } from "../../../lib/flightPilot.ts";
import { flowOnScreen, projectName, railModel, runsOn, stageLabel } from "./flowScreenCopy.ts";
import { useFlow } from "./useFlow.ts";
import "./flowEditor.css";

type Save = { state: "idle" | "saving" | "saved" } | { state: "failed"; error: string };

export function FlowEditor(p: { root: string; projects: string[]; onClose: () => void; /** A rule was saved from a block: the page reads the policy again. */ onPolicySaved?: () => void;
  /** A policy role to open selected (the page's review rows land on the reviewing block). */ select?: string; /** Opened from All projects: the controls edit the all-projects policy until a project is picked. */ allProjects?: boolean;
  /** What the board says each role is doing now; absent until the page hands it in, and the cards say so. */
  counts?: LiveCounts | null }) {
  const [root, setRoot] = useState(p.root);
  const [all, setAll] = useState(!!p.allProjects);
  const policyRoot = all ? "" : root;
  const { load, scope, reload } = useFlow(root);
  const [edited, setFlow] = useState<Flow | null>(null);
  // Until the effect below has taken the answer, the answer itself is the flow: no frame of the empty screen between the two.
  const flow: Flow | null = edited ?? (load.state === "loaded" ? load.flow : null);
  const [selected, setSelected] = useState<string | null>(null);
  // The one worker editor: a role on the path, a role in the team, or a new one at a gap.
  const [worker, setWorker] = useState<WorkerEdit | null>(null);
  const [save, setSave] = useState<Save>({ state: "idle" });
  // The roster starts open where it fits; under 900px it is a drawer over the canvas.
  const [team, setTeam] = useState(() => typeof window === "undefined" || window.innerWidth > 900);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const seq = useRef(0);
  const [fromTemplate, setFromTemplate] = useState(false);
  const [around, setAround] = useState<AroundId | null>(null);
  const aroundData = useAround(policyRoot);
  const [presetsAt, setPresetsAt] = useState<HTMLElement | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [preview, setPreview] = useState<PresetId | null>(null);
  const [checked, setChecked] = useState(false);
  const [conditions, setConditions] = useState(false);
  const [hoverRule, setHoverRule] = useState<string | null>(null);
  // A rule being edited: the draft lives here because the canvas draws it and a pressed block joins it.
  const [edit, setEdit] = useState<{ initial: PolicyRule | null; draft: Draft } | null>(null);
  const [lit, setLit] = useState<FieldId[]>([]);
  const [focusField, setFocusField] = useState<FieldId | null>(null);
  const [leave, setLeave] = useState<(() => void) | null>(null);
  // `orchestration.review.who` decides what the orchestrator does with code; the radios stay on the reviewing block and the card and sheet only say it.
  const [reviewWho, setReviewWho] = useState<ReviewWho | null>(null);
  // The pilot the project flies in (`flightPlan.pilot`), in the orchestrator strip's words. Nothing is guessed before the read.
  const [pilot, setPilot] = useState("");
  useEffect(() => {
    let live = true;
    void api.settingAt(REVIEW_SETTING_IDS.who, policyRoot).catch(() => null).then((r) => {
      if (live) setReviewWho(r?.ok && isReviewWho(r.value) ? r.value : null);
    });
    return () => { live = false; };
  }, [policyRoot]);
  useEffect(() => {
    let live = true;
    void api.settingAt("flightPlan.pilot", policyRoot).catch(() => null).then((r) => {
      if (live) setPilot(r?.ok && typeof r.value === "string" ? PILOT_CHIP[r.value as Pilot] ?? "" : "");
    });
    return () => { live = false; };
  }, [policyRoot]);

  // A new answer from the server replaces what is kept; a flow drawn from the template is not saved until the first change.
  useEffect(() => {
    if (load.state === "loaded") { setFlow(load.flow); setFromTemplate(scope === "template"); setSelected(p.select && !p.select.startsWith("@") ? load.flow?.roster.find((r) => r.policyRole === p.select && load.flow?.path.includes(r.id))?.id ?? null : null); setSave({ state: "idle" }); }
    else setFlow(null);
  }, [load, scope]);

  // The page can open the editor on a panel (settings search lands here): Conditions open at once, Presets once the chip is on screen.
  useEffect(() => {
    if (p.select === "@conditions") setConditions(true);
    if (p.select === "@presets" && load.state === "loaded") {
      const chip = document.querySelector<HTMLElement>("[data-presets]");
      if (chip) { setPresetsAt(chip); setChecked(false); setPresetsOpen(true); }
    }
  }, [p.select, load.state, flow, aroundData.policy]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback((next: Flow) => {
    setFlow(next);
    setFromTemplate(false);
    setSave({ state: "saving" });
    const mine = ++seq.current;
    // Stores go out in the order they were made, so a slow answer never lands over a newer one.
    queue.current = queue.current.then(() => api.putFlow(root, next)).then((r) => {
      if (mine !== seq.current) return;
      setSave(r.ok ? { state: "saved" } : { state: "failed", error: r.error ?? "The server did not take it." });
    }).catch(() => { if (mine === seq.current) setSave({ state: "failed", error: "Could not reach the server." }); });
  }, [root]);

  /** The reviewing block's cap lives in `orchestration.review.rounds`; the flow only shows it, so nothing goes to /flow. */
  const saveReviewRounds = useCallback(async (id: string, n: number): Promise<boolean> => {
    try {
      const r = await api.settingAtSet(REVIEW_SETTING_IDS.rounds, n, root);
      if (!r.ok) { setSave({ state: "failed", error: r.error ?? "The server did not take it." }); return false; }
      setFlow((f) => { const e = f && failOf(f, id); return f && e ? setFail(f, id, e.to, n) : f; });
      setSave({ state: "saved" });
      return true;
    } catch { setSave({ state: "failed", error: "Could not reach the server." }); return false; }
  }, [root]);

  const state = flowViewState(load.state === "loaded" ? { state: "loaded", flow } : load);
  // A dialog owns Escape: the worker editor and the orchestrator's sheet close themselves.
  const modal = worker !== null || around === "orchestrator";

  // What rules say on the blocks: the layers of marks, the later over the earlier.
  const scopeKey = aroundData.own && aroundData.root ? aroundData.root : "global";
  const holds = useMemo(() => ruleHolds(aroundData.states, scopeKey), [aroundData.states, scopeKey]);
  const marks = useMemo(() => {
    const pol = aroundData.policy;
    if (!pol) return {};
    const next = preview ? applyPreset(pol, preview, aroundData.readiness) : null;
    const hit = hoverRule ? pol.rules.find((r) => r.id === hoverRule) : undefined;
    return mergeMarks(marksInForce(pol, holds), checked ? marksReadiness(pol, holds, aroundData.readiness) : {}, next ? marksPreview(pol, next, holds) : {}, hit ? marksHit(pol, hit) : {},
      edit ? marksEditing(pol, { orchestrator: edit.draft.orch, workers: edit.draft.workers }, new Set(edit.draft.off)) : {},
      Object.fromEntries(lit.map((f) => [f, { kind: "hit" as const, tag: "would change" }])),
      focusField ? { [focusField]: { focus: true } } : {});
  }, [aroundData.policy, aroundData.readiness, holds, preview, checked, hoverRule, edit, lit, focusField]);
  // Every screen below reads the flow with each built-in role's chain back from the policy: a save drops `resolvedChain`.
  const shownFlow = useMemo(() => (flow && aroundData.policy ? flowOnScreen(flow, aroundData.policy, holds) : flow), [flow, aroundData.policy, holds]);
  // What the rail, the canvas and the panel draw while nothing is loaded: an empty flow, never a null each spells.
  const drawn: Flow = shownFlow ?? { version: 1, path: [], blocks: [], roster: [], stages: [], edges: [] };
  const dirty = !!edit && !!aroundData.policy && draftDirty(edit.draft, edit.initial, aroundData.policy);
  const closeEdit = () => { setEdit(null); setLit([]); setLeave(null); };
  /** Leaving a rule with unsaved edits asks first; anything else just goes. */
  const guard = (go: () => void) => { if (dirty) setLeave(() => go); else go(); };
  const startEdit = (id: string | "new") => {
    const pol = aroundData.policy;
    if (!pol) return;
    const initial = id === "new" ? null : pol.rules.find((r) => r.id === id) ?? null;
    setHoverRule(null); setLit([]); setLeave(null);
    setEdit({ initial, draft: draftOf(initial, initial ? {} : { when: [freshTrigger("usage")] }) });
  };
  const joinRule = (f: FieldId) => {
    const pol = aroundData.policy;
    if (pol) setEdit((e) => (e ? { ...e, draft: withField(e.draft, f, baseChainOf(pol, f)) } : e));
  };
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    // Esc closes the panel that is open, then the editor; a rule with unsaved edits asks first.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || modal) return;
      if (edit) { guard(closeEdit); return; }
      if (conditions) { setConditions(false); setHoverRule(null); return; }
      if (presetsOpen) return;
      p.onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [modal, p, edit, conditions, presetsOpen, dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const cc = conditionCounts(aroundData.policy, holds);

  // The orchestrator's card reads only what the editor already holds; the counts are D4's, handed in from the page and absent until then.
  const orchestratorData: OrchestratorCardData = {
    chair: aroundData.policy?.base.orchestrator.value[0] ?? null,
    seat: aroundData.seat ? { name: aroundData.seat.agent?.name ?? null } : null,
    planLeft: usageLeft(aroundData.states, scopeKey),
    maxWorkers: aroundData.policy?.limits.maxWorkers ?? null,
    codeWho: reviewWho,
    pilotWord: pilot,
    counts: p.counts,
  };
  // "Open its tab": the session in the chair comes forward. Nothing else is focused when nobody is seated.
  const openChairTab = () => {
    const pane = aroundData.seat?.agent?.paneId;
    if (pane) void api.focusPane({ sessionId: "", windowId: "", paneId: pane }).catch(() => { /* the card stays as it is */ });
  };
  const openOrchestrator = () => guard(() => { closeEdit(); setSelected(null); setConditions(false); setAround("orchestrator"); });

  const counts = flow ? flowCounts(flow) : null;
  const name = projectName(root);
  // The rail's two lists, in the mockup's order: the path, then the team that has no place on it yet.
  const onPath = drawn.path.map((id) => roleById(drawn, id)).filter((r): r is NonNullable<typeof r> => !!r);
  const offPath = drawn.roster.filter((r) => !drawn.path.includes(r.id));
  const railRow = (r: (typeof drawn.roster)[number]) => {
    const on = runsOn(r);
    return (
      <div key={r.id} className="fe-role" draggable role="button" tabIndex={0}
        style={{ "--hue": `var(--${r.hue})` } as React.CSSProperties}
        aria-label={`${r.name}, ${stageLabel(drawn, r.stage)}. Drag onto the canvas to place it.`}
        onDragStart={(e) => { e.dataTransfer.setData("text/plain", `role:${r.id}`); e.dataTransfer.effectAllowed = "copy"; }}
        onClick={() => setWorker({ kind: "role", id: r.id })} onKeyDown={(e) => { if (e.key === "Enter") setWorker({ kind: "role", id: r.id }); }}>
        <span className="fe-rt" aria-hidden="true"><FlowIcon name={r.ico} size={13} /></span>
        <div><b>{r.name}</b><small>{on ? `${on.engine} · ${railModel(on.model)}` : "You · this session"}</small></div>
      </div>
    );
  };
  const template = useMemo(() => templateFlow(), []);
  const templateNames = template.path.map((id) => roleById(template, id)!).map((r) => ({ id: r.id, name: r.name, hue: r.hue }));

  return (
    <FlowRootContext.Provider value={policyRoot}><Portal z={LAYER.flowEditor}>
      {/* No `agx-flow` here: that grid is the Orchestration page's "Right now" picture, and its two columns squeezed this screen to 220px. */}
      <div className="fe-root fe-ed" data-team={team ? "" : undefined} role="region" aria-label="Flow editor" style={{ "--accent": MOCKUP_INK.accent } as React.CSSProperties}>
        <header className="fe-edtop">
          <button className="fe-btn fe-teambtn" type="button" aria-expanded={team} aria-controls="fe-rail" onClick={() => setTeam(!team)}><FlowIcon name="users" size={12} />Team</button>
          <button className="fe-back" type="button" onClick={p.onClose}><FlowIcon name="back" size={14} /><span className="fe-backtxt">Orchestration</span></button>
          <span className="fe-eddiv" />
          <div className="fe-edtitle">
            <div><h1>Flow editor</h1><small>{root ? `${name} · ${scope === "template" ? "the shipped flow, not saved yet" : "the active flow"}` : "no project"}</small></div>
          </div>
          <span className="fe-edsp" />
          {p.projects.length > 0 && (
            <span className="fe-seg" role="group" aria-label="Flow for">
              {p.allProjects && <button type="button" aria-pressed={all} title="The setting every project without its own uses" onClick={() => setAll(true)}>All projects</button>}
              {p.projects.map((r) => (
                <button key={r} type="button" aria-pressed={!all && r === root} onClick={() => { setAll(false); setRoot(r); setWorker(null); }}>
                  {!all && r === root && <span className="fe-own" aria-hidden="true" />}{projectName(r)}
                </button>
              ))}
            </span>
          )}
          <span className="fe-seg" role="group" aria-label="Look at the flow as">
            <button type="button" aria-pressed="true"><FlowIcon name="loop" size={12} />Canvas</button>
            <button type="button" aria-pressed="false" disabled title="The board is coming">
              <FlowIcon name="grid" size={12} />Board<span className="fe-soon">Coming soon</span>
            </button>
          </span>
          <button className="fe-btn" data-tone="primary" type="button" disabled={!flow} onClick={() => flow && setWorker({ kind: "new", index: endIndex(flow) })}><FlowIcon name="plus" size={12} />Add worker</button>
          <button className="fe-btn fe-donebtn" type="button" onClick={p.onClose}>Done</button>
        </header>

        <div className="fe-honest">
          <FlowIcon name="alert" size={13} />
          <span>The orchestrator follows this flow; agentglass does not force it step by step. If it skips a block, it leaves one line saying why.</span>
          <span className="fe-sp" />
          {save.state === "failed" && <span className="fe-savestate" data-bad title={save.error}>Not saved: {save.error}</span>}
          {save.state === "saving" && <span className="fe-savestate">Saving…</span>}
          {save.state === "saved" && <span className="fe-savestate">Saved for {name}</span>}
          {fromTemplate && save.state === "idle" && <span className="fe-savestate">Saved on your first change</span>}
          <span className="fe-only">{counts ? `${counts.blocks} blocks · ${counts.stages} stages · ${counts.team} in the team · ${fromTemplate ? "Saved on your first change" : "Saved"}` : "No blocks yet"}</span>
        </div>

        <div className="fe-edbody">
          {state === "loading" && <div className="fe-loading" role="status">Reading the flow…</div>}
          {state === "error" && (
            <div className="fe-failed" role="alert">
              <div>
                <p>The flow could not be read: {load.state === "failed" ? load.error : ""}</p>
                <button className="fe-btn" type="button" onClick={reload}><FlowIcon name="undo" size={ICON.xs} />Try again</button>
              </div>
            </div>
          )}
          {(state === "ready" || state === "empty") && (
            <>
              <aside className="fe-rail" id="fe-rail" aria-label="Team">
                <h4 className="fe-railh">Team <span>{drawn.roster.length} roles</span></h4>
                <div className="fe-railscroll">
                  <h4 className="fe-railsec" data-first>On the path <span>{drawn.path.length}</span></h4>
                  {onPath.length ? onPath.map(railRow) : <p className="fe-railnote">Nothing on the path yet.</p>}
                  <h4 className="fe-railsec">In the team, off the path <span>drag to place</span></h4>
                  {offPath.length ? offPath.map(railRow) : <p className="fe-railnote">Every role is on the path.</p>}
                  <button className="fe-btn fe-railadd" type="button" disabled={!flow} onClick={() => flow && setWorker({ kind: "new", index: endIndex(flow) })}><FlowIcon name="plus" size={12} />Add worker</button>
                </div>
              </aside>

              <div className="fe-center">
              <FlowCanvas marks={marks} counts={p.counts} project={root ? name : undefined} ask={aroundData.policy?.base.workers ?? null} orchestrator={orchestratorData} onConfigureOrchestrator={openOrchestrator} onOpenOrchestratorTab={openChairTab} zoomToId={focusField === "orchestrator" ? "orchestrator" : focusField ? flow?.roster.find((r) => r.policyRole === focusField)?.id ?? null : null} flow={drawn} selected={selected}
                onSelect={(id) => {
                  if (edit) { const f = flow && id ? roleById(flow, id)?.policyRole : null; if (f) joinRule(f); return; }
                  setAround(null); setConditions(false); setSelected(id);
                }} onOrchestrator={edit ? () => joinRule("orchestrator") : undefined} onConfigure={(id) => setWorker({ kind: "role", id })}
                onAddAfter={(index) => setWorker({ kind: "new", index })}
                onRemove={(id) => { if (!flow) return; commit(removeFromPath(flow, id)); setSelected(null); }}
                onReorder={(id, i) => flow && commit(movePath(flow, id, i))}
                onMove={(id, x, y) => flow && commit(moveBlock(flow, id, x, y))} onTidy={() => flow && commit({ ...flow, blocks: [] })} onFlowLayout={() => flow && commit({ ...flow, blocks: organicBlocks(flow) })}
                onPlace={(id, i) => flow && commit(placeOnPath(flow, id, i))}
                onUseTemplate={() => root && commit({ ...template, blocks: [] })}
                onAddAt={(index) => setWorker({ kind: "new", index })}
                onAddFirst={() => setWorker({ kind: "new", index: 0 })} templateNames={templateNames} />
                <AroundRow tools={{ presetsOpen, conditionsOpen: conditions, editing: !!edit, count: cc.on, off: aroundData.policy ? Math.max(0, aroundData.policy.rules.length - cc.on) : 0, acting: cc.acting,
                  onPresets: (el) => { setPresetsAt(el); if (presetsOpen) setPreview(null); else setChecked(false); setPresetsOpen(!presetsOpen); }, onConditions: () => { setPresetsOpen(false); setPreview(null); setSelected(null); setAround(null); setHoverRule(null); if (conditions) guard(() => { closeEdit(); setConditions(false); }); else setConditions(true); } }} a={aroundData} open={around} onOpen={(id) => guard(() => { closeEdit(); setSelected(null); setConditions(false); setAround(around === id ? null : id); })} />
              </div>

              {conditions && !selected && !around && flow && (
                <ConditionsPanel a={aroundData} flow={flow} onClose={() => guard(() => { closeEdit(); setConditions(false); setHoverRule(null); })} onHover={setHoverRule}
                  onNew={() => startEdit("new")} onEdit={startEdit}
                  editor={edit && aroundData.policy ? {
                    title: edit.draft.name.trim() || (edit.initial ? edit.initial.name : "New condition"),
                    ask: leave ? { onKeep: () => setLeave(null), onDiscard: () => { const go = leave; closeEdit(); go(); } } : undefined,
                    body: <RuleEditor a={aroundData} flow={flow} policy={aroundData.policy} initial={edit.initial} draft={edit.draft}
                      onDraft={(draft) => setEdit({ ...edit, draft })} onLeave={() => guard(closeEdit)} onSaved={() => { closeEdit(); p.onPolicySaved?.(); }} onTested={setLit} onFocusField={setFocusField} />,
                  } : undefined}
                  onPickBlock={(role) => { const r = flow.roster.find((x) => x.policyRole === role && flow.path.includes(x.id)); if (r) { setConditions(false); setHoverRule(null); setSelected(r.id); } }} />
              )}
              {around === "fallback" && !selected && <AroundSide a={aroundData} onClose={() => setAround(null)} />}

              {selected && roleById(drawn, selected) && (
                <WorkerPanel flow={drawn} id={selected} around={aroundData} counts={p.counts} onClose={() => setSelected(null)}
                  onConfigure={() => setWorker({ kind: "role", id: selected })} />
              )}
            </>
          )}
          {state === "empty" && !root && <div className="fe-nonote">Open a project first: a flow belongs to one project.</div>}
        </div>

        {aroundData.policy && (
          <PresetsLayer a={aroundData} flow={flow} open={presetsOpen} anchor={presetsAt} preview={preview} onPreview={setPreview}
            checked={checked} onChecked={setChecked} onClose={() => setPresetsOpen(false)} />
        )}
        {shownFlow && worker && (
          <WorkerEditor flow={shownFlow} edit={worker} project={name} root={root} around={aroundData} onRuleSaved={p.onPolicySaved}
            onClose={() => setWorker(null)}
            onSave={(next, id) => { commit(next); setWorker(null); setSelected(next.path.includes(id) ? id : null); }}
            onReviewRounds={(id, n) => saveReviewRounds(id, n)}
            onOpenRole={(id) => setWorker({ kind: "role", id })} />
        )}
        {around === "orchestrator" && (
          <OrchestratorSheet a={aroundData} flow={drawn} root={policyRoot} reviewWho={reviewWho} onClose={() => setAround(null)} />
        )}
      </div>
    </Portal></FlowRootContext.Provider>
  );
}
