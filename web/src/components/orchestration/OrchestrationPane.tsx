import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SettingRow, Switch, Toggle } from "../SettingRow.tsx";
import { EmptyState, SELECT_BOX, SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { Select } from "../Select.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, Chip, INPUT, INPUT_STYLE, Segmented } from "../workspace/Chrome.tsx";
import { api, type PolicyRuleState, type SeatAnswer } from "../../lib/api.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { agentProvider } from "../../../../shared/agentKinds.ts";
import { ROLE_IDS, resolve, type Envelope, type Policy, type PolicyRule, type Resolved } from "../../../../shared/orchestration.ts";
import { WORKER_ROLES, type RoleId } from "../../../../shared/workerRoles.ts";
import type { EngineReadiness, EnginesReport } from "../../../../shared/types.ts";
import { RuleForm } from "./RuleForm.tsx";
import {
  ASK_HINT, CHAIN_TAIL, LIMIT_RANGE, NO_WORKER_ENGINE, chainWords, engineOptions, exhausted, notReady, readyFor, ruleBadge, ruleLine,
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

const baseName = (root: string) => root.split("/").filter(Boolean).pop() ?? root;

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
      <SettingRow label={L("write files")} hint="Never wider than the worker's own worktree."
        control={<Segmented label={L("write files")} value={env.write}
          options={[{ id: "none", label: "Nothing" }, { id: "worktree", label: "Its own worktree" }]}
          onChange={(w) => { if (!locked) onChange({ ...env, write: w }); }} />} />
      <Toggle label={L("network")} hint="Fetching from the web and calling its APIs: curl, wget and the like." disabled={locked}
        on={env.network} onClick={() => onChange({ ...env, network: !env.network })} />
      <Toggle label={L("commit in its worktree")} hint="Local commits only. Pushing is never part of this." disabled={locked}
        on={env.commit} onClick={() => onChange({ ...env, commit: !env.commit })} />
      <SettingRow label={L("also refuse")} hint="Commands refused on top of the ones that are always refused."
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
  const [env, setEnv] = useState({ ceiling: policy.ceiling, workerDefault: policy.workerDefault });
  // A save, or a project switch, brings a policy the draft did not make.
  useEffect(() => { setEnv({ ceiling: policy.ceiling, workerDefault: policy.workerDefault }); }, [policy]);

  const inherited = root !== "" && p.scope === "global";
  const locked = inherited || busy;
  const save = p.onSave;

  const resolution = useMemo(() => {
    if (!readiness) return null;
    return resolve(policy, { on: (id) => states.some((s) => s.ruleId === id && s.active) }, readiness);
  }, [policy, readiness, states]);

  const ruleState = (rule: PolicyRule) => states.find((s) => s.ruleId === rule.id);
  const chairNow = root === "" || !p.seat?.live ? null
    : `${agentProvider(policy.base.orchestrator.value[0]?.engine ?? "")?.title ?? ""} · ${p.seat.model}`;

  const choiceRow = (field: Field, label: string, hint: string, resolved: Resolved | undefined) => {
    const role = field === "orchestrator" ? "orchestrator" as const : "worker" as const;
    const ask = field === "orchestrator" ? policy.base.orchestrator : policy.base.workers[field];
    const c = ask.value[0]!;
    const bad = notReady(c, role, resolved, readiness);
    const chairLock = field === "orchestrator" ? { engine: c.engine, why: "The chair's engine is set when the seat opens; another engine in the chair comes later." } : undefined;
    const workerGlobal = field !== "orchestrator" && root !== "";
    const commitModel = (model: string) => { if (model !== c.model) void save(withBaseChoice(policy, field, { engine: c.engine, model }), field); };
    return (
      <SettingRow key={field} label={label} hint={hint} disabled={inherited}
        status={<ChoiceStatus bad={bad} checking={!readiness} />}
        control={<Select value={c.engine} title={`${label}: engine`} style={SELECT_BOX} disabled={locked || workerGlobal}
          options={engineOptions(role, readiness, chairLock).map((o) => ({ value: o.value, label: o.label, disabled: o.disabled, hint: o.hint }))}
          onChange={(engine) => { if (engine !== c.engine) void save(withBaseChoice(policy, field, { engine, model: "" }), field); }} />}
        actions={<AskChip on={ask.ask} disabled={locked}
          hint={field === "orchestrator" ? "The dialog that opens the chair offers this one first, and you pick." : ASK_HINT}
          onToggle={() => void save(withAsk(policy, field, !ask.ask), field)} />}
        below={
          <div className="grid gap-2">
            {field === "orchestrator" ? (
              <div className="flex flex-wrap items-center gap-2">
                <Select value={c.model} title="The chair's model" style={SELECT_BOX} disabled={locked || root === "" || !p.seat?.models.length}
                  options={(p.seat?.models ?? []).map((m) => ({ value: m.id, label: m.label }))} placeholder="Its default model"
                  onChange={commitModel} />
                <span className="text-[12px]" style={{ color: "var(--text3)" }}>
                  {root === "" ? "The chair's model is a project's choice: pick a project above." : ""}
                </span>
              </div>
            ) : (
              <input defaultValue={c.model} key={`${root}:${field}:${c.engine}:${c.model}`} spellCheck={false} placeholder="its default model"
                aria-label={`${label}: model`} disabled={locked || workerGlobal}
                onBlur={(e) => commitModel(e.target.value.trim())}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
                className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 260 }} />
            )}
            {bad && (
              <p className="m-0 text-[12px]" style={{ color: "var(--error-ink)" }}>
                {bad.why}{bad.using ? ` ${bad.using}` : ""}{" "}
                <button type="button" className="agx-field-link" onClick={p.onOpenEngines}>See Agent engines</button>
              </p>
            )}
            {workerGlobal && <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>Worker roles are global. Change them on All projects, or name them in a rule here.</p>}
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
        actions={<Button disabled={locked} onClick={() => { setSeed(rule); setEditing("new"); }}>Add a fallback rule</Button>} />
    );
  };

  const workersExhausted = resolution ? ROLE_IDS.map((r) => exhausted(resolution.workers[r])).find(Boolean) ?? null : null;
  const noWorker = !!readiness && readyFor("worker", readiness).length === 0;
  const dirty = JSON.stringify(env) !== JSON.stringify({ ceiling: policy.ceiling, workerDefault: policy.workerDefault });

  const ruleRows = policy.rules.map((rule) => {
    const badge = ruleBadge(rule, ruleState(rule), readiness);
    return (
      <SettingRow key={rule.id} label={rule.name} hint={ruleLine(rule)} disabled={inherited}
        status={<StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>}
        control={
          <button type="button" role="switch" aria-checked={rule.enabled} aria-label={`${rule.name}: on or off`} disabled={locked}
            onClick={() => void save(withRuleEnabled(policy, rule.id, !rule.enabled), "rules")} className="flex">
            <Switch on={rule.enabled} />
          </button>}
        actions={<Button disabled={locked} onClick={() => { setSeed(null); setEditing(editing === rule.id ? null : rule.id); }}>Edit</Button>}
        below={editing === rule.id ? (
          <RuleForm initial={rule} policy={policy} readiness={readiness} onCancel={() => setEditing(null)}
            onDelete={() => { void save(withoutRule(policy, rule.id), "rules").then((e) => { if (!e) setEditing(null); }); }}
            onSave={async (r) => { const e = await save(withRule(policy, r), "rules"); if (!e) setEditing(null); return e; }} />
        ) : undefined} />
    );
  });

  return (
    <>
      <SettingsCard title="Applies to" desc="A project with its own setting uses it instead of the general one, whole."
        actions={root === "" ? undefined : (
          <Button disabled={busy} onClick={() => p.onScope(inherited)}>{inherited ? "Set for this project" : "Use the general setting"}</Button>)}>
        <SettingRow label="Scope"
          hint={root === "" ? "The setting every project without its own uses." : inherited ? `${baseName(root)} has no setting of its own, so it uses the general one, shown here as it is.` : `${baseName(root)} has its own setting.`}
          below={<Segmented label="Applies to" value={root} onChange={p.onRoot}
            options={[{ id: "", label: "All projects" }, ...p.projects.map((r) => ({ id: r, label: baseName(r), title: r }))]} />} />
        <Note text={notes.scope} />
      </SettingsCard>

      <SettingsCard title="Orchestrator" desc="Who sits in the project's chair and decides who works."
        status={root === "" ? <StatusBadge tone="off">All projects</StatusBadge>
          : chairNow ? <StatusBadge tone="ok">{chairNow}</StatusBadge> : <StatusBadge tone="off">Nobody in the chair</StatusBadge>}>
        {choiceRow("orchestrator", "Engine and model", "What a new chair opens with. Running sessions are never moved.", resolution?.orchestrator)}
        {fallbackRow("orchestrator", "The chair")}
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

      <SettingsCard title="Rules" desc="A rule replaces the choices above while its condition holds. The first one that holds wins. Running sessions are never moved: a rule applies to sessions started after it turns on."
        actions={<Button disabled={locked} onClick={() => { setSeed(null); setEditing(editing === "new" ? null : "new"); }}>Add a rule</Button>}>
        {editing === "new" && (
          <SettingRow label="New rule" disabled={inherited}
            below={<RuleForm initial={seed} policy={policy} readiness={readiness} onCancel={() => { setEditing(null); setSeed(null); }}
              onSave={async (r) => { const e = await save(withRule(policy, r), "rules"); if (!e) { setEditing(null); setSeed(null); } return e; }} />} />
        )}
        {policy.rules.length === 0 && editing !== "new" ? <EmptyState>No rules. The choices above always apply.</EmptyState> : ruleRows}
        <Note text={notes.rules} />
      </SettingsCard>

      <SettingsCard title="What workers may do"
        desc="What a worker gets when the orchestrator says nothing. Save is under the next card; both save together.">
        <EnvelopeRows prefix="" env={env.workerDefault} locked={locked} onChange={(workerDefault) => setEnv({ ...env, workerDefault })} />
        <SettingRow label="Always refused"
          hint="Push, pull requests, merges, releases, anything that spends."
          detail={{ summary: "Why this cannot be changed here", body: "A worker's permissions have no setting for these, here or anywhere: nothing an orchestrator or a rule says can grant them. They are done by a person." }} />
      </SettingsCard>

      <SettingsCard title="The most an orchestrator may allow"
        desc="The widest a worker's permissions can be made when the orchestrator asks for more. A default wider than this is refused.">
        <EnvelopeRows prefix="At most: " env={env.ceiling} locked={locked} onChange={(ceiling) => setEnv({ ...env, ceiling })} />
        <SettingRow label="Save these permissions" hint="Both groups save together; the server checks that the default is inside the most allowed."
          control={<Button tone="primary" pending={busy} disabled={locked || !dirty} onClick={() => void save(withEnvelopes(policy, env), "envelope")}>Save</Button>} />
        <Note text={notes.envelope} />
      </SettingsCard>

      <SettingsCard title="Limits">
        {(Object.keys(LIMIT_RANGE) as (keyof Policy["limits"])[]).map((k) => (
          <StepRow key={k} k={k} value={policy.limits[k]} locked={locked}
            onStep={(by) => void save(withLimits(policy, { [k]: stepLimit(k, policy.limits[k], by) }), "limits")} />
        ))}
        <Note text={notes.limits} />
      </SettingsCard>
    </>
  );
}

export function OrchestrationPane() {
  const [root, setRoot] = useState("");
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
    void api.projects().then((r) => { if (alive.current) setWorkspaces(r.workspaces ?? (r.workspace ? [r.workspace] : [])); }).catch(() => { /* no project switch without a list */ });
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
    <OrchestrationView policy={loaded.policy} scope={loaded.scope} root={root} projects={projects}
      readiness={report?.engines ?? null} states={states}
      seat={root && seat ? { live: seat.live && !!seat.seat, model: seat.seat?.model ?? "", models: seat.models } : null}
      notes={notes} busy={busy} onRoot={setRoot} onSave={save} onScope={(o) => void setScope(o)}
      onOpenEngines={() => openSettings("engines")} />
  );
}
