import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Filter, SettingRow, Switch, Toggle } from "../SettingRow.tsx";
import { StatusBadge } from "../SettingsKit.tsx";
import { CARD, Card, Sec } from "./OrchKit.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, Chip, INPUT, INPUT_STYLE, Segmented } from "../workspace/Chrome.tsx";
import { api, type PolicyRuleState, type SeatAnswer } from "../../lib/api.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { agentProvider } from "../../../../shared/agentKinds.ts";
import { resolve, type EngineChoice, type Envelope, type Policy, type PolicyRule } from "../../../../shared/orchestration.ts";
import type { EngineReadiness, EnginesReport } from "../../../../shared/types.ts";
import { RuleSheet } from "./RuleForm.tsx";
import { RuleStrip } from "./RuleStrips.tsx";
import { QuickSetup } from "./QuickSetup.tsx";
import { ScopeBar } from "./ScopeBar.tsx";
import { FlowView } from "./FlowView.tsx";
import { RolePicker } from "./RolePicker.tsx";
import { rowId } from "../../lib/settingsIndex.ts";
import {
  ASK_HINT, BACK_LABEL, CHAIN_TAIL, choiceWords, baseChoice, fineTuneRow, pickedLine, pickUndoable, roleWord, scopeWords, usageLeft, type Picked, LIMIT_RANGE, NO_WORKER_ENGINE, openingScope, recallScope, SAFETY, safetyIsDefault, rememberScope, chainWords, notReady, exhausted, limitedEngines, OLD_WORDS, pickedHint, readyFor, ruleBadge, ruleHolds, ruleLine,
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
    if (document.querySelector(`[data-row="${flash}"]`)?.closest("[data-safety]")) setSafetyOpen(true);
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

  /**
   * Fine-tune: one card for the job whose Change was pressed. Everything the old
   * rows held for that job lives here, in the order a person reads it: the
   * engine tiles and the model, what is running now and why, the "ask when it
   * runs" switch, the fallback rule, and the undo of the last press.
   */
  const fineTune = (field: Field) => {
    const role = field === "orchestrator" ? "orchestrator" as const : "worker" as const;
    const resolved = field === "orchestrator" ? resolution?.orchestrator : resolution?.workers[field];
    const ask = field === "orchestrator" ? policy.base.orchestrator : policy.base.workers[field];
    const baseC = ask.value[0]!;
    // One story: while a rule holds this field, its choice is what runs, so it is what the card shows.
    const byRule = resolved?.ok && resolved.from === "rule" ? resolved : null;
    const c = byRule ? byRule.choice : baseC;
    const bad = notReady(c, role, resolved, readiness);
    const out = exhausted(resolved);
    const chairLock = field === "orchestrator" ? { engine: c.engine, why: "The main agent's engine is set when it opens; another engine comes later." } : undefined;
    const workerGlobal = field !== "orchestrator" && root !== "";
    const orchModels = field === "orchestrator" ? (root === "" ? [] : p.seat?.models ?? []) : null;
    const undoable = picked?.field === field && pickUndoable(policy, picked);
    const label = fineTuneRow(field);
    const fb: PolicyRule = {
      id: "", name: `${label} fallback`, enabled: true, when: [{ kind: "always" }],
      ...(field === "orchestrator" ? { orchestrator: ask.value } : { workers: { [field]: ask.value } }),
    };
    const say = "m-0 text-[11px]";
    return (
      <div className="grid gap-3" data-fine={field}>
        <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>Choosing for {roleWord(field)} {"\u00b7"} step 1</div>
        <RolePicker id={rowId(fineTuneRow(field))} role={role} word={roleWord(field)} current={c} readiness={readiness} lock={chairLock}
          models={orchModels} disabled={locked || workerGlobal}
          modelNote={field === "orchestrator" && root === "" ? "The main agent's model is a project's choice: pick a project above." : ""}
          onPick={(choice) => commit(field, choice)} />
        <div className="flex flex-wrap items-center gap-2">
          <AskChip on={ask.ask} disabled={locked || workerGlobal}
            hint={field === "orchestrator" ? "The dialog that opens the main agent offers this one first, and you pick." : ASK_HINT}
            onToggle={() => void save(withAsk(policy, field, !ask.ask), field)} />
          <span className={say} style={{ color: "var(--text3)" }}>If {roleWord(field)} {field === "orchestrator" ? "is" : "are"} not available: {chainWords(ask.value)}. {CHAIN_TAIL}</span>
          <Button disabled={locked || workerGlobal} onClick={(e) => openSheet("new", e.currentTarget, fb)}>Add a fallback rule</Button>
        </div>
        {(byRule || out) && (
          <div className="flex flex-wrap items-center gap-2">
            {byRule && <StatusBadge tone="off">From a rule</StatusBadge>}
            {out && <StatusBadge tone="err">{out.text}</StatusBadge>}
          </div>
        )}
        {out && <p role="alert" className={say} style={{ color: "var(--error-ink)" }}>{out.sentence}</p>}
        {undoable && (
          <p role="status" data-toast="picked" className={`${say} flex flex-wrap items-center gap-x-3 gap-y-1`} style={{ color: "var(--text)" }}>
            <span>{pickedLine(root)}</span>
            <button type="button" className="agx-field-link" disabled={locked} onClick={undoPick}>{BACK_LABEL}</button>
          </p>
        )}
        {bad && (
          <p className={say} style={{ color: "var(--error-ink)" }}>
            {bad.why}{bad.using ? ` ${bad.using}` : ""}{" "}
            <button type="button" className="agx-field-link" onClick={p.onOpenEngines}>See Agent engines</button>
          </p>
        )}
        {byRule && (
          <p className={say} style={{ color: "var(--text3)" }}>From the rule “{byRule.ruleName ?? byRule.ruleId}”. Without it: {choiceWords(baseC)}.{" "}
            {!inherited && byRule.ruleId && <button type="button" className="agx-field-link" disabled={locked} onClick={(e) => openSheet(byRule.ruleId!, e.currentTarget)}>Edit the rule</button>}
          </p>
        )}
        {workerGlobal && (
          <p className={say} style={{ color: "var(--text3)" }}>
            Worker roles are the same for every project.{" "}
            <button type="button" className="agx-field-link" onClick={() => p.onRoot("")}>Switch to All projects</button> to change them.
          </p>
        )}
        <div className="flex items-center gap-3">
          <span className={say} style={{ color: "var(--text3)" }}>{pickedHint(root)}</span>
          <span className="flex-1" />
          <Button onClick={() => { setPicking(null); setPicked(null); }}>Done</Button>
        </div>
      </div>
    );
  };

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
      <div key={rule.id} data-row={rowId(rule.name)} data-rule={rule.id} className="grid items-center gap-4 p-4"
        style={{ gridTemplateColumns: "auto minmax(0, 1fr) auto", borderBottom: "1px solid var(--surface-line)", opacity: inherited ? 0.6 : 1 }}>
        <button type="button" role="switch" aria-checked={rule.enabled} aria-label={`${rule.name}: on or off`} disabled={locked}
          onClick={() => void save(withRuleEnabled(policy, rule.id, !rule.enabled), "rules")} className="flex">
          <Switch on={rule.enabled} />
        </button>
        <div className="min-w-0 grid gap-2" style={{ opacity: rule.enabled ? 1 : 0.8 }}>
          <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold" style={{ color: "var(--text)" }}>
            {rule.name}<StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>
          </div>
          <div className="text-[12px]" style={{ color: "var(--text2)" }}>{ruleLine(rule)}</div>
          {pictured && <RuleStrip when={rule.when} now={now} left={left} />}
          <div className="text-[11px]" style={{ color: "var(--text3)" }}>
            {rule.enabled ? "On: it applies to agents started from now on. The switch turns it off." : "Off: it does nothing. The switch turns it on for agents started afterwards."}
          </div>
        </div>
        <Button disabled={locked} onClick={(e) => openSheet(rule.id, e.currentTarget)}>Edit</Button>
      </div>
    );
  });

  return (
    <div className="agx-orch">
      <ScopeBar root={root} projects={p.projects} overrides={p.overrides ?? []} inherited={inherited} busy={busy}
        note={notes.scope} onRoot={p.onRoot} onScope={p.onScope} />

      <FlowView policy={policy} facts={{ on: ruleHolds(states, scopeKey) }} readiness={readiness} root={root} disabled={false}
        liveModel={root !== "" && p.seat?.live ? p.seat.model : null} limited={limitedEngines(states, scopeKey)}
        onPickSetup={() => document.querySelector("[data-orch-presets]")?.scrollIntoView({ block: "start", behavior: "smooth" })}
        onChange={(field) => { setPicking(field); setPickTick((n) => n + 1); }} />

      <QuickSetup policy={policy} root={root} readiness={readiness} states={states} inherited={inherited} busy={busy}
        note={notes.quick} onSave={save} onOpenEngines={p.onOpenEngines} />

      <Sec n={2} id="orch-fine-tune" title="Fine-tune who does what"
        sub={chairNow ? `Press \u201cChange\u201d on the picture above. The main agent now open runs ${chairNow}.` : "Press \u201cChange\u201d on the picture above, then pick an engine from the tiles and a model."} />
      <Card data-row={picking ? rowId(fineTuneRow(picking)) : undefined}>
        {noWorker ? (
          <div className="flex flex-wrap items-center gap-3 text-[12px]" style={{ color: "var(--text2)" }}>
            <span>{NO_WORKER_ENGINE}</span>
            <Button onClick={p.onOpenEngines}>See Agent engines</Button>
          </div>
        ) : picking ? fineTune(picking) : (
          <div className="text-[12px]" style={{ color: "var(--text3)" }}>Press “Change” on a role in the picture above. The tiles open right here.</div>
        )}
        <Note text={notes.orchestrator || notes.scout || notes.builder || notes.verifier} />
      </Card>

      <Sec n={3} title="Switch things automatically"
        sub="Conditions override the picture while they hold. The first one that holds wins. They only affect agents started afterwards."
        right={<>
          <span className="text-[11px]" style={{ color: "var(--text3)" }}>Opens the editor. Nothing is saved until you press Save.</span>
          <Button tone="primary" disabled={locked} onClick={(e) => openSheet("new", e.currentTarget)}>+ Add a condition</Button>
        </>} />
      <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg)", border: "1px solid var(--border)" }} data-rules>
        {policy.rules.length === 0
          ? <div className="p-4 text-[12px]" style={{ color: "var(--text3)" }}>No conditions. The choices above always apply.</div> : ruleRows}
      </div>
      <Note text={notes.rules} />

      <Sec n={4} title={SAFETY.title} sub={`${SAFETY.summary} Every change here saves as you make it.`} />
      <section data-safety className="rounded-xl p-4" style={{ background: "var(--surface-card)", border: "1px solid var(--surface-line)", boxShadow: "var(--surface-lift)" }}>
        <button type="button" aria-expanded={safetyOpen} onClick={() => setSafetyOpen(!safetyOpen)}
          className="flex items-center gap-2 text-[13px] font-semibold bg-transparent border-0 p-0 cursor-pointer" style={{ color: "var(--text)", minHeight: 26 }}>
          <span aria-hidden className="text-[10px]" style={{ color: "var(--text3)" }}>{safetyOpen ? "\u25be" : "\u25b8"}</span>
          Show safety and limits
          {safetyIsDefault(policy) ? <StatusBadge tone="off">defaults</StatusBadge> : <StatusBadge tone="ok">changed</StatusBadge>}
        </button>
        {(
          <div className="mt-3" hidden={!safetyOpen}>
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
            <p className="m-0 mt-3 text-[11px]" style={{ color: "var(--text3)" }}>{OLD_WORDS}</p>
          </div>
        )}
      </section>

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
  const [workspacesKnown, setWorkspacesKnown] = useState(false);
  const [startedGlobal, setStartedGlobal] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const loadStates = useCallback(() => {
    void api.orchestrationState().then((r) => { if (alive.current && r.ok) setStates(r.rules); }).catch(() => { /* a failed read keeps what is on screen */ });
  }, []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const loadPolicy = useCallback((forRoot: string) => {
    void api.orchestration(forRoot || undefined).then((r) => {
      if (!alive.current) return;
      if (r.ok) { setLoaded({ policy: r.policy, scope: r.scope, overrides: r.overrides }); setLoadError(null); }
      else setLoadError((r as { error?: string }).error ?? "The server did not answer.");
    }).catch(() => { if (alive.current) setLoadError("Could not reach the server."); }).finally(() => { if (alive.current) setRetrying(false); });
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
      setWorkspacesKnown(true);
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

  // Nothing open and nothing chosen: say so, and offer the one thing that works without a project.
  if (workspacesKnown && workspaces.length === 0 && !chosen.current && root === "" && !startedGlobal) {
    return (
      <div className="agx-orch">
        <div className="grid gap-3 justify-items-start rounded-xl p-6" style={{ ...CARD, maxWidth: 620 }}>
          <h2 className="m-0 text-[15px] font-semibold" style={{ color: "var(--text)" }}>Nothing is set up yet</h2>
          <p className="m-0 text-[13px]" style={{ color: "var(--text2)" }}>No project is open, so there is nothing to show for one. You can set who does what for all projects now, and each project follows it until you change that project.</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button tone="primary" onClick={() => setStartedGlobal(true)}>Set up for all projects</Button>
            <span className="text-[11px]" style={{ color: "var(--text3)" }}>Opens the setup for all projects. Nothing is saved until you pick.</span>
          </div>
        </div>
      </div>
    );
  }

  // Before there is a policy to draw: a failed read says what the server answered, and the wait is a skeleton.
  if (!loaded) {
    if (loadError) {
      return (
        <div className="agx-orch">
          <div role="alert" className="grid gap-3 justify-items-start rounded-xl p-6" style={{ ...CARD, borderColor: "color-mix(in srgb, var(--error) 50%, var(--border))", maxWidth: 620 }}>
            <h2 className="m-0 text-[15px] font-semibold" style={{ color: "var(--text)" }}>Could not load the setting for {root ? root.split("/").filter(Boolean).pop() : "all projects"}</h2>
            <p className="m-0 text-[13px]" style={{ color: "var(--text2)" }}>The server answered:</p>
            <div className="t-mono text-[11px] rounded-md px-3 py-2" style={{ background: "var(--bg3)", color: "var(--text2)", overflowWrap: "anywhere" }}>{loadError}</div>
            <p className="m-0 text-[13px]" style={{ color: "var(--text2)" }}>Nothing was changed. Your last saved setting is still in force.</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button tone="primary" pending={retrying} disabled={retrying} onClick={() => { setRetrying(true); loadPolicy(root); }}>{retrying ? "Trying again\u2026" : "Retry"}</Button>
              <span className="text-[11px]" style={{ color: "var(--text3)" }} aria-live="polite">{retrying ? "Asking the server. Nothing is changed." : "Asks the server again. Nothing is changed."}</span>
            </div>
          </div>
        </div>
      );
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
      readiness={report?.engines ?? null} states={states}
      seat={root && seat ? { live: seat.live && !!seat.seat, model: seat.seat?.model ?? "", models: seat.models } : null}
      notes={notes} busy={busy} onRoot={pick} onSave={save} onScope={(o) => void setScope(o)}
      onOpenEngines={() => openSettings("engines")} />
  );
}
