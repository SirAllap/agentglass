import { useEffect, useRef, useState, type ReactNode } from "react";
import { SELECT_BOX, helpIdFor } from "../SettingsKit.tsx";
import { Select } from "../Select.tsx";
import { AnchoredMenu } from "../AnchoredMenu.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { roleLabel, type FlowLike } from "../../lib/roleLabel.ts";
import { Button, Chip, EDGE, INPUT, INPUT_STYLE, LINE } from "../workspace/Chrome.tsx";
import { LAYER } from "../../lib/layers.ts";
import {
  CHAIN_MAX, ROLE_IDS, TRIGGERS_MAX,
  type Chain, type EngineChoice, type Policy, type PolicyRule, type Trigger, type UsageProviderId,
} from "../../../../shared/orchestration.ts";
import { RuleStrip } from "./RuleStrips.tsx";
import { buildRule, ruleProblem } from "./ruleDraft.ts";
import { WORKER_ROLES, type RoleId } from "../../../../shared/workerRoles.ts";
import type { EngineReadiness } from "../../../../shared/types.ts";
import {
  CHAIN_FULL, CHAIN_TAIL, GAUGE_HELP, chainAddFrom, chainMove, chainRemove, engineLetter, engineOptions, engineTileState,
  newRuleId, ruleLine, testDraft, usageChoices, type EngineOption,
} from "./orchestrationCopy.ts";

/**
 * One rule, edited in a side sheet that opens over the page where the person
 * pressed Add or Edit: its name, when it applies (with the strip that shows it),
 * what it puts in place (one section per job), the sentence the draft makes, and
 * a dry run of it against this moment. Nothing is saved until Save, Esc and
 * Cancel change nothing, and the server's own sentence for a refusal sits above
 * the buttons.
 *
 * A rule names the fields it changes and leaves the rest alone, so each job
 * under "Then use" starts off and is switched on to say something.
 */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const KINDS: { id: Trigger["kind"]; label: string }[] = [
  { id: "usage", label: "Plan nearly used up" },
  { id: "limit", label: "Plan has run out" },
  { id: "hours", label: "At certain hours" },
  { id: "budget", label: "Budget used up" },
  { id: "always", label: "Always" },
];

/** A trigger of a kind, with the fields that kind needs at their starting values. */
export function freshTrigger(kind: Trigger["kind"]): Trigger {
  const first = usageChoices()[0]?.value ?? "anthropic";
  switch (kind) {
    case "usage": return { kind, provider: first, window: "weekly", remainingAtMost: 10 };
    case "limit": return { kind, provider: first };
    case "hours": return { kind, days: [1, 2, 3, 4, 5], from: "22:00", to: "07:00" };
    case "budget": return { kind };
    case "always": return { kind };
  }
}

/** The engine a switched-on job starts with: the first one its role can take, so a fresh entry is never an unknown id. */
function firstOffered(role: "orchestrator" | "worker", readiness: readonly EngineReadiness[] | null): EngineChoice {
  const all = engineOptions(role, readiness);
  const o = all.find((x) => !x.disabled) ?? all[0];
  return { engine: o?.value ?? "", model: "" };
}

/** The engine's name from the provider table, never an id shown to the person. */
const engineName = (engine: string, role: "orchestrator" | "worker"): string =>
  engineOptions(role, null).find((o) => o.value === engine)?.label ?? engine;

/** A dot only when the chosen engine cannot take the role; a ready engine says nothing. */
function StepState({ engine, model, role, readiness }: {
  engine: string; model: string; role: "orchestrator" | "worker"; readiness: readonly EngineReadiness[] | null;
}) {
  const s = engineTileState(engine, role, readiness, false, model);
  if (s.tone === "ok" || s.tone === "checking") return null;
  return <span aria-hidden className="agx-rule-step-dot" data-tone={s.tone} title={s.reason} />;
}

/**
 * One step of a chain: the mark and name, the model, and the three controls,
 * always on one line and in the same columns. The model gives way first (it
 * ellipsizes and carries the whole value in its title), never the remove.
 */
function StepRow({ id, label, index, count, step, role, readiness, onChange, onMove, onRemove }: {
  id: string; label: string; index: number; count: number; step: EngineChoice;
  role: "orchestrator" | "worker"; readiness: readonly EngineReadiness[] | null;
  onChange: (c: EngineChoice) => void; onMove: (by: -1 | 1) => void; onRemove: () => void;
}) {
  const name = engineName(step.engine, role);
  return (
    <li className="agx-rule-step">
      <span aria-hidden className="agx-rule-step-n">{index + 1}</span>
      <span className="agx-rule-step-name" title={name}>
        <span aria-hidden className="agx-rule-step-mark">{engineLetter(step.engine)}</span>
        <span className="agx-rule-step-title">{name}</span>
        <StepState engine={step.engine} model={step.model} role={role} readiness={readiness} />
      </span>
      <input value={step.model} placeholder="its default model" spellCheck={false}
        id={`${id}-model-${index}`} aria-label={`${label}: model ${index + 1}`}
        title={step.model || "Its default model"}
        onChange={(e) => onChange({ ...step, model: e.target.value })}
        className={`t-mono agx-rule-model ${INPUT}`} style={{ ...INPUT_STYLE, height: 28 }} />
      <Button type="button" label="Move up" square size="regular" disabled={index === 0}
        onClick={() => onMove(-1)}>↑</Button>
      <Button type="button" label="Move down" square size="regular" disabled={index === count - 1}
        onClick={() => onMove(1)}>↓</Button>
      <Button type="button" label="Remove" square size="regular" disabled={count === 1}
        onClick={onRemove}><CloseIcon size={ICON.sm} /></Button>
    </li>
  );
}

/**
 * The engines as a menu, ready ones first. A disabled row is quiet and says why
 * in one line; pressing it does nothing.
 */
function AddStep({ label, role, readiness, onAdd }: {
  label: string; role: "orchestrator" | "worker"; readiness: readonly EngineReadiness[] | null;
  onAdd: (engine: string, options: readonly EngineOption[]) => void;
}) {
  const anchor = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const options = engineOptions(role, readiness);
  const ordered = [...options.filter((o) => !o.disabled), ...options.filter((o) => o.disabled)];
  return (
    <span ref={anchor} className="agx-rule-addwrap">
      <Button type="button" size="regular" aria-haspopup="menu" aria-expanded={open}
        label={`Add a step to ${label}`} onClick={() => setOpen((v) => !v)}>+ Add a step</Button>
      {open && (
        <AnchoredMenu anchor={anchor} align="left" minWidth={288} onClose={() => setOpen(false)}>
          {ordered.map((o) => (
            <button key={o.value} type="button" role="menuitem" disabled={!!o.disabled}
              data-engine={o.value} data-off={o.disabled ? "" : undefined}
              className="agx-step-pick" onClick={() => { setOpen(false); onAdd(o.value, options); }}>
              <span aria-hidden className="agx-rule-step-mark">{engineLetter(o.value)}</span>
              <span className="agx-step-pick-text">
                <span className="agx-step-pick-name">{o.label}</span>
                <span className="agx-step-pick-why">{o.disabled ? o.hint ?? "It cannot take this role here." : "Ready"}</span>
              </span>
            </button>
          ))}
        </AnchoredMenu>
      )}
    </span>
  );
}

/**
 * A chain as numbered steps, tried in order, then the one control that adds
 * one. A full chain says so instead of offering a step it would drop.
 */
export function ChainEditor({ id, label, chain, role, readiness, onChange }: {
  id: string;
  label: string;
  chain: Chain;
  role: "orchestrator" | "worker";
  readiness: readonly EngineReadiness[] | null;
  onChange: (c: Chain) => void;
}) {
  const set = (i: number, c: EngineChoice) => onChange(chain.map((x, j) => (j === i ? c : x)));
  return (
    <div className="agx-rule-chain" role="group" aria-label={label}>
      <ol className="agx-rule-steps">
        {chain.map((c, i) => (
          <StepRow key={i} id={id} label={label} index={i} count={chain.length} step={c}
            role={role} readiness={readiness} onChange={(next) => set(i, next)}
            onMove={(by) => onChange(chainMove(chain, i, by))} onRemove={() => onChange(chainRemove(chain, i))} />
        ))}
      </ol>
      {chain.length >= CHAIN_MAX ? (
        <p className="agx-rule-note">{CHAIN_FULL} {CHAIN_TAIL}</p>
      ) : (
        <div className="agx-rule-addrow">
          <AddStep label={label} role={role} readiness={readiness}
            onAdd={(engine, options) => { const n = chainAddFrom(chain, options, engine); if (n) onChange(n); }} />
          <span className="agx-rule-note">{CHAIN_TAIL}</span>
        </div>
      )}
    </div>
  );
}

type Left = Partial<Record<UsageProviderId, number>>;

/** One condition: its kind, the fields that kind needs, and the strip that shows when it applies. */
export function TriggerEditor({ id, t, now, left, onChange, onRemove, removable }: {
  id: string; t: Trigger; now: Date; left: Left; onChange: (t: Trigger) => void; onRemove: () => void; removable: boolean;
}) {
  const choices = usageChoices();
  const num = (v: string) => Math.max(1, Math.min(99, Math.round(Number(v) || 1)));
  const kind = KINDS.find((k) => k.id === t.kind)?.label ?? t.kind;
  return (
    <div className="agx-rule-cond" role="group" aria-label={`Condition: ${kind}`}>
      <div className="agx-rule-cond-top">
        <Select value={t.kind} title="Condition" style={SELECT_BOX} options={KINDS.map((k) => ({ value: k.id, label: k.label }))}
          onChange={(k) => { if (k !== t.kind) onChange(freshTrigger(k as Trigger["kind"])); }} />
        <span className="agx-rule-grow" />
        {removable && (
          <Button type="button" square size="regular" label="Remove this condition" onClick={onRemove}>
            <CloseIcon size={ICON.sm} />
          </Button>
        )}
      </div>
      {(t.kind === "usage" || t.kind === "limit") && (
        <div className="agx-rule-fields">
          <Select value={t.provider} title="Which plan" style={SELECT_BOX} options={choices}
            onChange={(p) => onChange({ ...t, provider: p as typeof t.provider })} />
          {t.kind === "usage" && (
            <>
              <Select value={t.window} title="Which window" style={SELECT_BOX}
                options={[{ value: "5h", label: "5 h window" }, { value: "weekly", label: "Weekly window" }, { value: "either", label: "Either window" }]}
                onChange={(w) => onChange({ ...t, window: w as typeof t.window })} />
              <label htmlFor={`${id}-pct`} className="agx-rule-fieldlabel">with at most</label>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <input id={`${id}-pct`} type="number" min={1} max={99} value={t.remainingAtMost}
                  onChange={(e) => onChange({ ...t, remainingAtMost: num(e.target.value) })}
                  className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 72, height: 28 }} />
                <span className="agx-rule-fieldlabel">% left</span>
              </span>
            </>
          )}
        </div>
      )}
      {t.kind === "usage" && <RuleStrip when={[t]} now={now} left={left} />}
      {(t.kind === "usage" || t.kind === "limit") && GAUGE_HELP() && (
        <p id={helpIdFor(`${id}-gauge`)} className="agx-rule-note">{GAUGE_HELP()}</p>
      )}
      {t.kind === "hours" && (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Days">
            {DAY_LABELS.map((d, i) => (
              <Chip key={d} on={t.days.includes(i)} resting
                onClick={() => onChange({ ...t, days: t.days.includes(i) ? t.days.filter((x) => x !== i) : [...t.days, i].sort() })}>{d}</Chip>
            ))}
          </div>
          <div className="agx-rule-fields">
            <input type="time" aria-label="From" value={t.from} onChange={(e) => onChange({ ...t, from: e.target.value })}
              className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 112, height: 28 }} />
            <span className="agx-rule-fieldlabel">to</span>
            <input type="time" aria-label="To" value={t.to} onChange={(e) => onChange({ ...t, to: e.target.value })}
              className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 112, height: 28 }} />
            <span className="agx-rule-note">This computer's time. It may cross midnight.</span>
          </div>
          <RuleStrip when={[t]} now={now} left={left} />
        </div>
      )}
    </div>
  );
}

/** A section of the sheet: its heading, an optional sentence, and one hairline above. */
function Sec({ id, title, sub, children }: { id: string; title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="agx-rule-sec" data-block={id}>
      <div className="agx-rule-sec-head">
        <h2 className="agx-rule-sec-h">{title}</h2>
        {sub && <p className="agx-rule-sec-sub">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

/** One job: its heading row (open or folded, on or off) and, open, its steps. */
function JobSection({ id, slot, title, chain, role, readiness, open, onOpen, onToggle, onChange }: {
  id: string; slot: string; title: string; chain: Chain | undefined; role: "orchestrator" | "worker";
  readiness: readonly EngineReadiness[] | null; open: boolean;
  onOpen: () => void; onToggle: () => void; onChange: (c: Chain) => void;
}) {
  const bodyOpen = !!chain && open;
  const steps = chain?.length ?? 0;
  return (
    <div className="agx-rule-job" data-on={chain ? "" : undefined}>
      <div className="agx-rule-job-head">
        {chain ? (
          <button type="button" className="agx-rule-job-open" aria-expanded={bodyOpen} onClick={onOpen}>
            <span aria-hidden className="agx-rule-caret" data-open={bodyOpen ? "" : undefined}>▸</span>
            <span className="agx-rule-job-title">{title}</span>
            <span className="agx-rule-job-count">{steps} {steps === 1 ? "step" : "steps"}</span>
          </button>
        ) : (
          <span className="agx-rule-job-open" data-static="">
            <span aria-hidden className="agx-rule-caret" data-off="" />
            <span className="agx-rule-job-title">{title}</span>
            <span className="agx-rule-job-count">keeps the page's choice</span>
          </span>
        )}
        <Button type="button" size="compact" on={!!chain} aria-pressed={!!chain}
          aria-label={`${title}: ${chain ? "on" : "off"}`} onClick={onToggle}>{chain ? "On" : "Off"}</Button>
      </div>
      {chain && open && (
        <div className="agx-rule-job-body">
          <ChainEditor id={`${id}-${slot}`} label={title} chain={chain} role={role} readiness={readiness} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

export interface RuleSheetProps {
  initial: PolicyRule | null;
  /** The flow's role names: the group labels and the preview print these. */
  flow?: FlowLike | null;
  policy: Policy;
  readiness: readonly EngineReadiness[] | null;
  /** "orbit", or "all projects": whose setting this edits. */
  scope: string;
  facts: { on(ruleId: string): boolean };
  left: Left;
  now: Date;
  /** Resolves to the server's sentence when it refuses, or null when it saved. */
  onSave: (rule: PolicyRule) => Promise<string | null>;
  onCancel: () => void;
  onDelete?: () => void;
}

type Job = { key: string; title: string; chain: Chain | undefined; role: "orchestrator" | "worker"; toggle: () => void; set: (c: Chain) => void };

/** The side sheet. Esc and the scrim close it; the person's place on the page is not moved. */
export function RuleSheet({ initial, flow, policy, readiness, scope, facts, left, now, onSave, onCancel, onDelete }: RuleSheetProps) {
  const uid = initial?.id ?? "new-rule";
  const [name, setName] = useState(initial?.name ?? "");
  const [when, setWhen] = useState<Trigger[]>(initial?.when ?? [freshTrigger("usage")]);
  const [orch, setOrch] = useState<Chain | undefined>(initial?.orchestrator);
  const [workers, setWorkers] = useState<Partial<Record<RoleId, Chain>>>(initial?.workers ?? {});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<{ holds: string; lines: string[] } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // The first job with steps is the one the sheet opens on.
  const [openJobs, setOpenJobs] = useState<Record<string, boolean>>(() => {
    const key = initial?.orchestrator ? "orchestrator" : ROLE_IDS.find((r) => initial?.workers?.[r]);
    return key ? { [key]: true } : {};
  });
  useEffect(() => { nameRef.current?.focus({ preventScroll: true }); }, []);

  const draft = (): PolicyRule => buildRule({ id: initial?.id ?? null, name, when, enabled: initial?.enabled ?? true, orch, workers }, policy);
  const submit = async () => {
    setError(null);
    const problem = ruleProblem({ name, orch, workers });
    if (problem) { setError(problem); return; }
    setBusy(true);
    const e = await onSave(draft()).catch(() => "Could not reach the server.");
    setBusy(false);
    if (e) setError(e);
  };

  const setWhenAt = (i: number, t: Trigger) => { setWhen(when.map((x, j) => (j === i ? t : x))); setTested(null); };
  const preview = ruleLine({ ...draft(), name: name.trim() || "This rule" }, flow);
  const jobs: Job[] = [
    {
      key: "orchestrator", title: "The main agent", chain: orch, role: "orchestrator",
      toggle: () => { setOrch(orch ? undefined : [firstOffered("orchestrator", readiness)]); setOpenJobs((o) => ({ ...o, orchestrator: true })); setTested(null); },
      set: (c) => { setOrch(c); setTested(null); },
    },
    ...WORKER_ROLES.map((r) => ({
      key: r.id, title: roleLabel(r.id, flow).plural, chain: workers[r.id], role: "worker" as const,
      toggle: () => {
        setWorkers((w) => { const n = { ...w }; if (n[r.id]) delete n[r.id]; else n[r.id] = [firstOffered("worker", readiness)]; return n; });
        setOpenJobs((o) => ({ ...o, [r.id]: true }));
        setTested(null);
      },
      set: (c: Chain) => { setWorkers((w) => ({ ...w, [r.id]: c })); setTested(null); },
    })),
  ];
  return (
    <>
      <div aria-hidden className="fixed inset-0 agx-scrim" style={{ zIndex: LAYER.settingsDialog }} onClick={onCancel} />
      <aside role="dialog" aria-modal="true" aria-label={initial ? `Edit ${initial.name}` : "New rule"} data-sheet="rule"
        onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); onCancel(); } }}
        className="fixed top-0 right-0 bottom-0 flex flex-col w-[min(560px,100vw)] agx-rule-sheet"
        style={{ zIndex: LAYER.settingsDialog, background: "var(--bg)", borderLeft: EDGE }}>
        <form className="flex flex-col min-h-0 flex-1" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="agx-rule-head" style={{ borderBottom: LINE }}>
            <span className="agx-rule-eyebrow">{initial ? "Editing" : "New"} condition for {scope}</span>
            <label htmlFor={`${uid}-name`} className="sr-only">Name</label>
            <input id={`${uid}-name`} ref={nameRef} value={name} maxLength={60} spellCheck={false} placeholder="Name this condition"
              onChange={(e) => setName(e.target.value)} className={INPUT} style={INPUT_STYLE} />
          </div>
          <div className="agx-rule-body overflow-y-auto overflow-x-hidden">
            <Sec id="when" title="When"
              sub={when.length > 1 ? "All of them have to be true." : "The condition that switches this rule on."}>
              {when.map((t, i) => (
                <TriggerEditor key={i} id={`${uid}-when-${i}`} t={t} now={now} left={left} removable={when.length > 1}
                  onChange={(n) => setWhenAt(i, n)} onRemove={() => { setWhen(when.filter((_, j) => j !== i)); setTested(null); }} />
              ))}
              <div className="agx-rule-addrow">
                <Button type="button" disabled={when.length >= TRIGGERS_MAX}
                  onClick={() => { setWhen([...when, freshTrigger("hours")]); setTested(null); }}>+ Add a condition</Button>
              </div>
            </Sec>
            <Sec id="then" title="Then use" sub="A job left off keeps the choice on the page.">
              <div className="agx-rule-jobs">
                {jobs.map((j) => (
                  <JobSection key={j.key} id={uid} slot={j.key} title={j.title} chain={j.chain} role={j.role} readiness={readiness}
                    open={!!openJobs[j.key]} onOpen={() => setOpenJobs((o) => ({ ...o, [j.key]: !o[j.key] }))}
                    onToggle={j.toggle} onChange={j.set} />
                ))}
              </div>
            </Sec>
            <Sec id="preview" title="What this would do">
              <p data-preview className="agx-rule-preview">{preview}</p>
            </Sec>
            <Sec id="test" title="Test it now" sub="Checks this draft against this moment. Nothing is started or saved.">
              <div>
                <Button type="button" onClick={() => setTested(testDraft(policy, draft(), facts, new Date(), left, readiness, flow))}>Test it now</Button>
              </div>
              {tested && (
                <div role="status" data-tested className="grid gap-1 text-[12px]" style={{ color: "var(--text)" }}>
                  <p className="m-0 font-medium">{tested.holds}</p>
                  <ul className="m-0 pl-4 grid gap-1">{tested.lines.map((l) => <li key={l}>{l}</li>)}</ul>
                </div>
              )}
            </Sec>
          </div>
          <footer className="agx-rule-foot" style={{ borderTop: LINE }}>
            {error && <div role="alert" className="agx-field-e">{error}</div>}
            <div className="agx-rule-foot-row">
              {onDelete && <Button type="button" tone="danger" onClick={onDelete}>Delete</Button>}
              <span className="agx-rule-grow" />
              <Button type="button" onClick={onCancel}>Cancel</Button>
              <Button type="submit" tone="primary" pending={busy}>Save for {scope}</Button>
            </div>
          </footer>
        </form>
      </aside>
    </>
  );
}
