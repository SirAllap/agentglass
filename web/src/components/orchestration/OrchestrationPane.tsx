import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Filter, SettingRow, Switch, Toggle } from "../SettingRow.tsx";
import { EmptyState, SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, Chip, INPUT, INPUT_STYLE, Segmented } from "../workspace/Chrome.tsx";
import { api, type PolicyRuleState, type SeatAnswer } from "../../lib/api.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { agentProvider } from "../../../../shared/agentKinds.ts";
import { ROLE_IDS, resolve, type EngineChoice, type Envelope, type Policy, type PolicyRule, type Resolved } from "../../../../shared/orchestration.ts";
import { WORKER_ROLES, type RoleId } from "../../../../shared/workerRoles.ts";
import type { EngineReadiness, EnginesReport } from "../../../../shared/types.ts";
import { RuleSheet } from "./RuleForm.tsx";
import { RuleStrip } from "./RuleStrips.tsx";
import { QuickSetup } from "./QuickSetup.tsx";
import { ScopeBar } from "./ScopeBar.tsx";
import { FlowView } from "./FlowView.tsx";
import { EngineTile } from "./EngineTile.tsx";
import { RolePicker } from "./RolePicker.tsx";
import { rowId } from "../../lib/settingsIndex.ts";
import {
  ASK_HINT, BACK_LABEL, CHAIN_TAIL, choiceWords, baseChoice, fineTuneRow, pickedLine, pickUndoable, roleWord, scopeWords, usageLeft, type Picked, LIMIT_RANGE, NO_WORKER_ENGINE, openingScope, recallScope, SAFETY, safetyIsDefault, rememberScope, chainWords, exhausted, notReady, readyFor, ruleBadge, ruleHolds, ruleLine,
  stepLimit, withAsk, withBaseChoice, withEnvelopes, withLimits, withRule, withRuleEnabled, withoutRule, type Field,
} from "./orchestrationCopy.ts";

/**
 * How work is handed out: which engine sits in a project's chair, which ones
 * do the work it gives out, and the rules that change that for a while.
 *
 * Only a person changes any of it. Nothing on this page has a setting id, so an
 * agent can open and read the page and cannot write it: the orchestrator works
 * inside this policy.
 *
 * Nothing polls. The page reads the policy, the engines and the rules' state
 * when it opens, when the project changes and after each save; the server
 * settles a rule's switch on the events that change a reading, so the badges
 * are as fresh as the last time somebody looked.
 */

/** The server's sentence, or a note, under the control that produced it. */
function Note({ text }: { text: string | undefined }) {
  if (!text) return null;
  return <div role="alert" className="agx-settings-x pt-2 pb-3 text-[12px]" style={{ color: "var(--error-ink)" }}>{text}</div>;
}

/** "Ask when it runs", as the hand-off rule words it: a chip on the row. */
function AskChip({ on, disabled, onToggle, hint }: { on: boolean; disabled: boolean; onToggle: () => void; hint: string }) {
  return <Chip on={on} resting disabled={disabled} title={hint} onClick={onToggle}>Ask when it runs</Chip>;
}

/** A list of command prefixes a worker is also refused, with one field to add to it. */
function DenyList({ id, deny, disabled, onChange }: { id: string; deny: string[]; disabled: boolean; onChange: (d: string[]) => void }) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    if (!t || deny.includes(t)) { setText(""); return; }
    onChange([...deny, t]);
    setText("");
  };
  return (
    <div className="grid gap-2">
      {deny.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="list" aria-label="Also refused">
          {deny.map((d) => (
            <span key={d} role="listitem" className="inline-flex items-center gap-1.5">
              <code className="t-mono text-[11.5px] rounded-lg px-2 py-1" style={{ background: "var(--surface-inset)" }}>{d}</code>
              <Button label={`Stop refusing ${d}`} square size="compact" disabled={disabled} onClick={() => onChange(deny.filter((x) => x !== d))}><CloseIcon size={ICON.sm} /></Button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} value={text} spellCheck={false} placeholder="a command to refuse" aria-label="Add a command to refuse"
          disabled={disabled} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 260 }} />
        <Button disabled={disabled || !text.trim()} onClick={add}>Add</Button>
      </div>
    </div>
  );
}

/** One group of the envelope: write, network, commit, and the extra refusals. */
function EnvelopeRows({ prefix, env, locked, onChange }: { prefix: string; env: Envelope; locked: boolean; onChange: (e: Envelope) => void }) {
  // Without a prefix the label starts a sentence; with one it follows a colon.
  const L = (w: string) => (prefix ? `${prefix}${w}` : w.charAt(0).toUpperCase() + w.slice(1));
  return (
    <>
      <SettingRow label={L("write files")} hint={SAFETY.write}
        control={<Segmented label={L("write files")} value={env.write}
          options={[{ id: "none", label: "Nothing" }, { id: "worktree", label: "Its own copy" }]}
          onChange={(w) => { if (!locked) onChange({ ...env, write: w }); }} />} />
      <Toggle label={L("network")} hint={SAFETY.network} disabled={locked}
        on={env.network} onClick={() => onChange({ ...env, network: !env.network })} />
      <Toggle label={L("commit in its own copy")} hint={SAFETY.commit} disabled={locked}
        on={env.commit} onClick={() => onChange({ ...env, commit: !env.commit })} />
      <SettingRow label={L("also refuse")} hint={SAFETY.deny}
        below={<DenyList id={`${prefix}deny`.replace(/\W+/g, "-")} deny={env.deny} disabled={locked} onChange={(deny) => onChange({ ...env, deny })} />} />
    </>
  );
}

function StepRow({ k, value, locked, onStep }: { k: keyof Policy["limits"]; value: number; locked: boolean; onStep: (by: -1 | 1) => void }) {
  const r = LIMIT_RANGE[k];
  return (
    <SettingRow label={r.label} hint={r.hint}
      control={
        <span className="flex items-center gap-1 justify-self-end">
          <Button label={`Fewer: ${r.label}`} square disabled={locked || value <= r.min} onClick={() => onStep(-1)}>−</Button>
          <span className="text-[12px] tabular-nums text-center w-[42px]" style={{ color: "var(--text)" }}>{value}</span>
          <Button label={`More: ${r.label}`} square disabled={locked || value >= r.max} onClick={() => onStep(1)}>+</Button>
        </span>
      } />
  );
}

/** The name of a group inside Safety and limits, and the one sentence that says what it is for. */
function SafetyHead({ title, note }: { title: string; note: string }) {
  return (
    <div className="agx-settings-x pt-4 pb-1">
      <h4 className="m-0 text-[13px] font-semibold" style={{ color: "var(--text)" }}>{title}</h4>
      <p className="m-0 mt-1 text-[12px]" style={{ color: "var(--text3)" }}>{note}</p>
    </div>
  );
}

/** What a choice row says about its engine: ready, or why not and what runs instead. */
function ChoiceStatus({ bad, checking }: { bad: ReturnType<typeof notReady>; checking: boolean }) {
  if (checking) return <StatusBadge tone="checking">Checking</StatusBadge>;
  return bad ? <StatusBadge tone="err">{bad.text}</StatusBadge> : <StatusBadge tone="ok">Ready</StatusBadge>;
}

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
  /** A rule's form or the new-rule form open from the start (a test and a screenshot show it). */
  openRule?: string | "new";
  /** The moment the strips mark as now; the clock when left out. */
  now?: Date;
  /** A job's tiles open from the start (a test and a screenshot show them). */
  openPicker?: Field;
  onRoot: (root: string) => void;
  /** Answers null when it saved, or the server's sentence. */
  onSave: (next: Policy, card: string) => Promise<string | null>;
  onScope: (override: boolean) => void;
  onOpenEngines: () => void;
}

/** The page, drawn from what it is handed: no request is made here. */
export function OrchestrationView(p: OrchestrationViewProps) {
  const { policy, readiness, states, root, notes, busy } = p;
  const [editing, setEditing] = useState<string | null>(p.openRule ?? null);
  const [seed, setSeed] = useState<PolicyRule | null>(null);
  // Which job's tiles are open, and the last press, so the line under it can offer Undo.
  const [picking, setPicking] = useState<Field | null>(p.openPicker ?? null);
  const [pickTick, setPickTick] = useState(0);
  const [picked, setPicked] = useState<Picked | null>(null);
  useEffect(() => { if (picking) revealEditor(rowId(fineTuneRow(picking)), "[data-pick-first]"); }, [picking, pickTick]);
  useEffect(() => { setPicking(null); setPicked(null); }, [root]);
  // The sheet is fixed over the page, so it opens where the person is looking; closing it hands the focus back to what opened it.
  const opener = useRef<HTMLElement | null>(null);
  const openSheet = (id: string | null, from: HTMLElement, withSeed: PolicyRule | null = null) => {
    if (id) opener.current = from;
    setSeed(withSeed);
    setEditing(id);
  };
  useEffect(() => {
    if (editing !== null || !opener.current) return;
    opener.current.focus();
    opener.current = null;
  }, [editing]);
  // Shut until the person opens it; a refusal under Save or a step opens it, so a sentence is never hidden.
  const [safetyOpen, setSafetyOpen] = useState(false);
  const safetyNote = notes.envelope || notes.limits;
  useEffect(() => { if (safetyNote) setSafetyOpen(true); }, [safetyNote]);
  // A search result lands on a row by scrolling to it; one inside the shut card would be nowhere to be seen, so the card opens.
  const flash = useContext(Filter).flash;
  useEffect(() => {
    if (!flash) return;
    const card = document.querySelector(`[data-row="${flash}"]`)?.closest("section");
    if (card?.querySelector("h3")?.textContent === SAFETY.title) setSafetyOpen(true);
  }, [flash]);
  const [env, setEnv] = useState({ ceiling: policy.ceiling, workerDefault: policy.workerDefault });
  // A save, or a project switch, brings a policy the draft did not make.
  useEffect(() => { setEnv({ ceiling: policy.ceiling, workerDefault: policy.workerDefault }); }, [policy]);

  const inherited = root !== "" && p.scope === "global";
  const locked = inherited || busy;
  const save = p.onSave;

  // The global policy and a project's own share rule ids; read the states of this one.
  const scopeKey = inherited || root === "" ? "global" : root;
  const resolution = useMemo(() => {
    if (!readiness) return null;
    return resolve(policy, { on: ruleHolds(states, scopeKey) }, readiness);
  }, [policy, readiness, states, scopeKey]);

  const commit = (field: Field, to: EngineChoice) => {
    const from = baseChoice(policy, field);
    void save(withBaseChoice(policy, field, to), field).then((err) => { if (!err) setPicked({ field, from, to }); });
  };
  const undoPick = () => {
    if (!picked || !pickUndoable(policy, picked)) return;
    const u = picked;
    setPicked(null);
    void save(withBaseChoice(policy, u.field, u.from), u.field);
  };
  const ruleState = (rule: PolicyRule) => states.find((s) => s.scope === scopeKey && s.ruleId === rule.id);
  const chairNow = root === "" || !p.seat?.live ? null
    : `${agentProvider(policy.base.orchestrator.value[0]?.engine ?? "")?.title ?? ""} · ${p.seat.model}`;

  const choiceRow = (field: Field, label: string, hint: string, resolved: Resolved | undefined) => {
    const role = field === "orchestrator" ? "orchestrator" as const : "worker" as const;
    const ask = field === "orchestrator" ? policy.base.orchestrator : policy.base.workers[field];
    const baseC = ask.value[0]!;
    // One story per row: while a rule holds this field, its choice is what runs, so it is what the row shows.
    const byRule = resolved?.ok && resolved.from === "rule" ? resolved : null;
    const c = byRule ? byRule.choice : baseC;
    const bad = notReady(c, role, resolved, readiness);
    const chairLock = field === "orchestrator" ? { engine: c.engine, why: "The main agent's engine is set when it opens; another engine comes later." } : undefined;
    const workerGlobal = field !== "orchestrator" && root !== "";
    const open = picking === field && !inherited && !workerGlobal;
    const orchModels = field === "orchestrator" ? (root === "" ? [] : p.seat?.models ?? []) : null;
    const undoable = picked?.field === field && pickUndoable(policy, picked);
    return (
      <SettingRow key={field} label={label} hint={hint} disabled={inherited}
        status={<>
          {byRule && <StatusBadge tone="off">From a rule</StatusBadge>}
          <ChoiceStatus bad={bad} checking={!readiness} />
        </>}
        control={<EngineTile engine={c.engine} model={c.model} role={role} readiness={readiness} />}
        actions={
          <>
            <AskChip on={ask.ask} disabled={locked}
              hint={field === "orchestrator" ? "The dialog that opens the main agent offers this one first, and you pick." : ASK_HINT}
              onToggle={() => void save(withAsk(policy, field, !ask.ask), field)} />
            <Button disabled={locked || workerGlobal} label={`Change the ${roleWord(field)}`} onClick={() => setPicking(open ? null : field)}>{open ? "Done" : "Change"}</Button>
          </>}
        below={
          <div className="grid gap-2">
            {open && (
              <RolePicker id={rowId(fineTuneRow(field))} role={role} word={roleWord(field)} current={c} readiness={readiness} lock={chairLock}
                models={orchModels} disabled={locked}
                modelNote={field === "orchestrator" && root === "" ? "The main agent's model is a project's choice: pick a project above." : ""}
                onPick={(choice) => commit(field, choice)} />
            )}
            {undoable && (
              <p role="status" data-toast="picked" className="m-0 text-[12px] flex flex-wrap items-center gap-x-3 gap-y-1" style={{ color: "var(--text)" }}>
                <span>{pickedLine(root)}</span>
                <button type="button" className="agx-field-link" disabled={locked} onClick={undoPick}>{BACK_LABEL}</button>
              </p>
            )}
            {bad && (
              <p className="m-0 text-[12px]" style={{ color: "var(--error-ink)" }}>
                {bad.why}{bad.using ? ` ${bad.using}` : ""}{" "}
                <button type="button" className="agx-field-link" onClick={p.onOpenEngines}>See Agent engines</button>
              </p>
            )}
            {byRule && (
              <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>From the rule “{byRule.ruleName ?? byRule.ruleId}”. Without it: {choiceWords(baseC)}.{" "}
                {!inherited && byRule.ruleId && <button type="button" className="agx-field-link" disabled={locked} onClick={(e) => openSheet(byRule.ruleId!, e.currentTarget)}>Edit the rule</button>}
              </p>
            )}
            {workerGlobal && (
              <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>
                Worker roles are the same for every project.{" "}
                <button type="button" className="agx-field-link" onClick={() => p.onRoot("")}>Switch to All projects</button> to change them.
              </p>
            )}
          </div>} />
    );
  };

  /** A fallback is a rule that always holds: the base is one choice, a chain lives in a rule. */
  const fallbackRow = (field: Field, label: string) => {
    const ask = field === "orchestrator" ? policy.base.orchestrator : policy.base.workers[field];
    const rule: PolicyRule = {
      id: "", name: `${label} fallback`, enabled: true, when: [{ kind: "always" }],
      ...(field === "orchestrator" ? { orchestrator: ask.value } : { workers: { [field]: ask.value } }),
    };
    return (
      <SettingRow key={`${field}-fb`} label={`If ${label.toLowerCase()} is not available`} disabled={inherited}
        hint={<>{chainWords(ask.value)}. {CHAIN_TAIL}</>}
        actions={<Button disabled={locked} onClick={(e) => openSheet("new", e.currentTarget, rule)}>Add a fallback rule</Button>} />
    );
  };

  const workersExhausted = resolution ? ROLE_IDS.map((r) => exhausted(resolution.workers[r])).find(Boolean) ?? null : null;
  const noWorker = !!readiness && readyFor("worker", readiness).length === 0;
  const dirty = JSON.stringify(env) !== JSON.stringify({ ceiling: policy.ceiling, workerDefault: policy.workerDefault });

  const now = p.now ?? new Date();
  const left = usageLeft(states, scopeKey);
  const closeSheet = () => { setEditing(null); setSeed(null); };
  const sheetRule = editing && editing !== "new" ? policy.rules.find((r) => r.id === editing) ?? null : seed;
  const ruleRows = policy.rules.map((rule) => {
    const badge = ruleBadge(rule, ruleState(rule), readiness);
    const pictured = rule.when.some((t) => t.kind === "hours" || t.kind === "usage");
    return (
      <SettingRow key={rule.id} label={rule.name} hint={ruleLine(rule)} disabled={inherited}
        status={<StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>}
        control={
          <button type="button" role="switch" aria-checked={rule.enabled} aria-label={`${rule.name}: on or off`} disabled={locked}
            onClick={() => void save(withRuleEnabled(policy, rule.id, !rule.enabled), "rules")} className="flex">
            <Switch on={rule.enabled} />
          </button>}
        actions={<Button disabled={locked} onClick={(e) => openSheet(rule.id, e.currentTarget)}>Edit</Button>}
        below={pictured ? <div className="grid gap-2"><RuleStrip when={rule.when} now={now} left={left} /></div> : undefined} />
    );
  });

  return (
    <div className="agx-orch">
      <ScopeBar root={root} projects={p.projects} overrides={p.overrides ?? []} inherited={inherited} busy={busy}
        note={notes.scope} onRoot={p.onRoot} onScope={p.onScope} />

      <FlowView policy={policy} facts={{ on: ruleHolds(states, scopeKey) }} readiness={readiness} root={root} disabled={false}
        liveModel={root !== "" && p.seat?.live ? p.seat.model : null}
        onChange={(field) => { setPicking(field); setPickTick((n) => n + 1); }} />

      <QuickSetup policy={policy} root={root} readiness={readiness} states={states} inherited={inherited} busy={busy}
        note={notes.quick} onSave={save} onOpenEngines={p.onOpenEngines} />

      <SettingsCard title="Main agent" desc={root !== "" && !chairNow ? "Decides the plan and hands the work out. No main agent is running now; this is what the next one will use." : "Decides the plan and hands the work out."}
        status={root === "" ? <StatusBadge tone="off">All projects</StatusBadge>
          : chairNow ? <StatusBadge tone="ok">{chairNow}</StatusBadge> : <StatusBadge tone="off">Not open</StatusBadge>}>
        {choiceRow("orchestrator", "Engine and model", "What a new main agent opens with. Running sessions are never moved.", resolution?.orchestrator)}
        {fallbackRow("orchestrator", "The main agent")}
        <Note text={notes.orchestrator} />
      </SettingsCard>

      <SettingsCard title="Workers" desc="Which engine and model each role runs on when the orchestrator starts one."
        status={workersExhausted ? <StatusBadge tone="err">{workersExhausted.text}</StatusBadge> : undefined}>
        {noWorker ? (
          <EmptyState>
            <span>{NO_WORKER_ENGINE}</span>
            <Button onClick={p.onOpenEngines}>See Agent engines</Button>
          </EmptyState>
        ) : (
          WORKER_ROLES.map((r) => {
            const out = exhausted(resolution?.workers[r.id as RoleId]);
            return (
              <Fragment key={r.id}>
                {choiceRow(r.id as RoleId, r.title, r.what, resolution?.workers[r.id as RoleId])}
                {fallbackRow(r.id as RoleId, r.title)}
                {out && <p className="agx-settings-x m-0 pb-3 text-[12px]" style={{ color: "var(--error-ink)" }}>{out.sentence}</p>}
              </Fragment>
            );
          })
        )}
        <Note text={notes.scout || notes.builder || notes.verifier} />
      </SettingsCard>

      <SettingsCard title="Conditions" desc="A condition replaces the choices above while it holds. The first one that holds wins. Running sessions are never moved: a condition applies to sessions started after it turns on."
        actions={<Button disabled={locked} onClick={(e) => openSheet("new", e.currentTarget)}>Add a condition</Button>}>
        {policy.rules.length === 0 ? <EmptyState>No conditions. The choices above always apply.</EmptyState> : ruleRows}
        <Note text={notes.rules} />
      </SettingsCard>

      <SettingsCard title={SAFETY.title} desc={SAFETY.summary}
        status={safetyIsDefault(policy) ? <StatusBadge tone="off">defaults</StatusBadge> : <StatusBadge tone="ok">changed</StatusBadge>}
        fold={{ open: safetyOpen, onToggle: setSafetyOpen }}>
        <SafetyHead {...SAFETY.workers} />
        <EnvelopeRows prefix="" env={env.workerDefault} locked={locked} onChange={(workerDefault) => setEnv({ ...env, workerDefault })} />
        <SettingRow label="Always refused" hint={SAFETY.always.hint} detail={{ summary: SAFETY.always.more, body: SAFETY.always.body }} />
        <SafetyHead {...SAFETY.most} />
        <EnvelopeRows prefix="At most: " env={env.ceiling} locked={locked} onChange={(ceiling) => setEnv({ ...env, ceiling })} />
        <SettingRow label="Save these permissions" hint="Both groups save together; the server checks that the default is inside the most allowed."
          control={<Button tone="primary" pending={busy} disabled={locked || !dirty} onClick={() => void save(withEnvelopes(policy, env), "envelope")}>Save</Button>} />
        <Note text={notes.envelope} />
        <SafetyHead {...SAFETY.limits} />
        {(Object.keys(LIMIT_RANGE) as (keyof Policy["limits"])[]).map((k) => (
          <StepRow key={k} k={k} value={policy.limits[k]} locked={locked}
            onStep={(by) => void save(withLimits(policy, { [k]: stepLimit(k, policy.limits[k], by) }), "limits")} />
        ))}
        <Note text={notes.limits} />
      </SettingsCard>

      {editing && !inherited && (editing === "new" || sheetRule) && (
        <RuleSheet key={editing} initial={sheetRule} policy={policy} readiness={readiness} scope={scopeWords(root)}
          facts={{ on: ruleHolds(states, scopeKey) }} left={left} now={now} onCancel={closeSheet}
          onDelete={sheetRule && editing !== "new" ? () => { void save(withoutRule(policy, sheetRule.id), "rules").then((e) => { if (!e) closeSheet(); }); } : undefined}
          onSave={async (r) => { const e = await save(withRule(policy, r), "rules"); if (!e) closeSheet(); return e; }} />
      )}
    </div>
  );
}

/**
 * An editor opens in the Rules card, which can be far below the button that
 * asked for it. Bring it to the eye and put the cursor in its first field; the
 * scroll is instant when the person asked for less motion.
 */
function revealEditor(row: string, focus = "input, select, button"): void {
  const el = document.querySelector<HTMLElement>(`[data-row="${row}"]`);
  if (!el) return;
  const calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  el.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
}

const storage = (): Storage | null => { try { return localStorage; } catch { return null; } };

export function OrchestrationPane() {
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
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const loadStates = useCallback(() => {
    void api.orchestrationState().then((r) => { if (alive.current && r.ok) setStates(r.rules); }).catch(() => { /* a failed read keeps what is on screen */ });
  }, []);
  const loadPolicy = useCallback((forRoot: string) => {
    void api.orchestration(forRoot || undefined).then((r) => {
      if (alive.current && r.ok) setLoaded({ policy: r.policy, scope: r.scope, overrides: r.overrides });
    }).catch(() => { /* a failed read keeps what is on screen */ });
    loadStates();
    if (forRoot) void api.seat(forRoot).then((r) => { if (alive.current) setSeat(r); }).catch(() => { if (alive.current) setSeat(null); });
    else setSeat(null);
  }, [loadStates]);

  useEffect(() => {
    void api.engines().then((r) => { if (alive.current) setReport(r); }).catch(() => { /* the rows say "checking" until it answers */ });
    void api.projects().then((r) => {
      if (!alive.current) return;
      const ws = r.workspaces ?? (r.workspace ? [r.workspace] : []);
      setWorkspaces(ws);
      if (!chosen.current) setRoot(openingScope(null, ws, ws[0] ?? null));
    }).catch(() => { /* no project switch without a list */ });
  }, []);
  useEffect(() => { loadPolicy(root); }, [root, loadPolicy]);

  const projects = useMemo(() => [...new Set([...workspaces, ...(loaded?.overrides ?? [])])], [workspaces, loaded?.overrides]);

  /** Store the whole policy. Answers null when it saved, or the server's sentence, which also goes under the control that asked; nothing else moves. */
  const save = async (next: Policy, card: string): Promise<string | null> => {
    setBusy(true);
    const r = await api.orchestrationSave(next, root || undefined).catch(() => ({ ok: false, error: "Could not reach the server." } as const));
    if (!alive.current) return null;
    setBusy(false);
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

  if (!loaded) {
    return (
      <SettingsCard title="Orchestration" status={<StatusBadge tone="checking">Checking</StatusBadge>}>
        <SettingRow label="The policy" minHeight={56} hint="Reading what is set on this computer." />
      </SettingsCard>
    );
  }
  return (
    <OrchestrationView policy={loaded.policy} scope={loaded.scope} root={root} projects={projects} overrides={loaded.overrides}
      readiness={report?.engines ?? null} states={states}
      seat={root && seat ? { live: seat.live && !!seat.seat, model: seat.seat?.model ?? "", models: seat.models } : null}
      notes={notes} busy={busy} onRoot={pick} onSave={save} onScope={(o) => void setScope(o)}
      onOpenEngines={() => openSettings("engines")} />
  );
}
