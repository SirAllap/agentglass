import { useState } from "react";
import { Field, SELECT_BOX, SettingsForm, helpIdFor } from "../SettingsKit.tsx";
import { Select } from "../Select.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, Chip, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { CHAIN_MAX, ROLE_IDS, TRIGGERS_MAX, type Chain, type EngineChoice, type Policy, type PolicyRule, type Trigger } from "../../../../shared/orchestration.ts";
import { WORKER_ROLES, type RoleId } from "../../../../shared/workerRoles.ts";
import type { EngineReadiness } from "../../../../shared/types.ts";
import {
  CHAIN_TAIL, GAUGE_HELP, chainAdd, chainMove, chainRemove, engineOptions, newRuleId, usageChoices,
} from "./orchestrationCopy.ts";

/**
 * One rule, edited in a stacked form: its name, when it applies, and what it
 * puts in place. Nothing is saved until the one Save at the end, and the
 * server's own sentence for a refusal sits under it.
 *
 * A rule names the fields it changes and leaves the rest alone, so each part
 * under "Then" starts off and is switched on to say something.
 */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const KINDS: { value: Trigger["kind"]; label: string }[] = [
  { value: "usage", label: "A plan is running low" },
  { value: "limit", label: "A plan has run out" },
  { value: "hours", label: "It is a certain time" },
  { value: "budget", label: "The project's budget is used up" },
  { value: "always", label: "Always" },
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

const STARTING_CHOICE: EngineChoice = { engine: "", model: "" };

/** Pick the first engine the select would offer, so a fresh entry is never an unknown id. */
function firstOffered(role: "orchestrator" | "worker", readiness: readonly EngineReadiness[] | null): EngineChoice {
  const o = engineOptions(role, readiness).find((x) => !x.disabled) ?? engineOptions(role, readiness)[0];
  return o ? { engine: o.value, model: "" } : STARTING_CHOICE;
}

export function ChainEditor({ id, label, chain, role, readiness, onChange }: {
  id: string;
  label: string;
  chain: Chain;
  role: "orchestrator" | "worker";
  readiness: readonly EngineReadiness[] | null;
  onChange: (c: Chain) => void;
}) {
  const options = engineOptions(role, readiness);
  const set = (i: number, c: EngineChoice) => onChange(chain.map((x, j) => (j === i ? c : x)));
  return (
    <div className="grid gap-2" role="group" aria-label={label}>
      {chain.map((c, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] tabular-nums" style={{ color: "var(--text3)", width: 16 }}>{i + 1}.</span>
          <Select value={c.engine} title={`${label}: engine ${i + 1}`} style={SELECT_BOX}
            options={options.map((o) => ({ value: o.value, label: o.label, disabled: o.disabled, hint: o.hint }))}
            onChange={(v) => set(i, { engine: v, model: "" })} />
          <input value={c.model} placeholder="its default model" spellCheck={false}
            id={`${id}-model-${i}`} aria-label={`${label}: model ${i + 1}`}
            onChange={(e) => set(i, { ...c, model: e.target.value })}
            className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 180 }} />
          <Button type="button" label="Move up" square disabled={i === 0} onClick={() => onChange(chainMove(chain, i, -1))}>↑</Button>
          <Button type="button" label="Move down" square disabled={i === chain.length - 1} onClick={() => onChange(chainMove(chain, i, 1))}>↓</Button>
          <Button type="button" label="Remove" square disabled={chain.length === 1} onClick={() => onChange(chainRemove(chain, i))}><CloseIcon size={ICON.sm} /></Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={chain.length >= CHAIN_MAX} onClick={() => onChange(chainAdd(chain, firstOffered(role, readiness)))}>
          Add a fallback
        </Button>
        <span className="text-[12px]" style={{ color: "var(--text3)" }}>{chain.length >= CHAIN_MAX ? `${CHAIN_MAX} at most. ` : ""}{CHAIN_TAIL}</span>
      </div>
    </div>
  );
}

function TriggerEditor({ id, t, onChange, onRemove, removable }: {
  id: string; t: Trigger; onChange: (t: Trigger) => void; onRemove: () => void; removable: boolean;
}) {
  const choices = usageChoices();
  const num = (v: string) => Math.max(1, Math.min(99, Math.round(Number(v) || 1)));
  return (
    <div className="grid gap-2 rounded-lg p-3" style={{ background: "var(--surface-inset)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={t.kind} title="Condition" style={SELECT_BOX} options={KINDS}
          onChange={(k) => onChange(freshTrigger(k as Trigger["kind"]))} />
        {removable && <Button type="button" onClick={onRemove}>Remove this condition</Button>}
      </div>
      {(t.kind === "usage" || t.kind === "limit") && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={t.provider} title="Which plan" style={SELECT_BOX} options={choices}
            onChange={(p) => onChange({ ...t, provider: p as typeof t.provider })} />
          {t.kind === "usage" && (
            <>
              <Select value={t.window} title="Which window" style={SELECT_BOX}
                options={[{ value: "5h", label: "5 h window" }, { value: "weekly", label: "Weekly window" }, { value: "either", label: "Either window" }]}
                onChange={(w) => onChange({ ...t, window: w as typeof t.window })} />
              <label htmlFor={`${id}-pct`} className="text-[12px]" style={{ color: "var(--text2)" }}>with at most</label>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <input id={`${id}-pct`} type="number" min={1} max={99} value={t.remainingAtMost}
                  onChange={(e) => onChange({ ...t, remainingAtMost: num(e.target.value) })}
                  className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 72 }} />
                <span className="text-[12px]" style={{ color: "var(--text2)" }}>% left</span>
              </span>
            </>
          )}
        </div>
      )}
      {(t.kind === "usage" || t.kind === "limit") && GAUGE_HELP() && (
        <p id={helpIdFor(`${id}-gauge`)} className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>{GAUGE_HELP()}</p>
      )}
      {t.kind === "hours" && (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Days">
            {DAY_LABELS.map((d, i) => (
              <Chip key={d} on={t.days.includes(i)} resting
                onClick={() => onChange({ ...t, days: t.days.includes(i) ? t.days.filter((x) => x !== i) : [...t.days, i].sort() })}>{d}</Chip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input type="time" aria-label="From" value={t.from} onChange={(e) => onChange({ ...t, from: e.target.value })}
              className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 112 }} />
            <span className="text-[12px]" style={{ color: "var(--text2)" }}>to</span>
            <input type="time" aria-label="To" value={t.to} onChange={(e) => onChange({ ...t, to: e.target.value })}
              className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 112 }} />
            <span className="text-[12px]" style={{ color: "var(--text3)" }}>This computer's time. It may cross midnight.</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** What the form edits: the rule without its id, which is made when it is saved. */
export function RuleForm({ initial, policy, readiness, onSave, onCancel, onDelete }: {
  initial: PolicyRule | null;
  policy: Policy;
  readiness: readonly EngineReadiness[] | null;
  /** Resolves to the server's sentence when it refuses, or null when it saved. */
  onSave: (rule: PolicyRule) => Promise<string | null>;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const uid = initial?.id ?? "new-rule";
  const [name, setName] = useState(initial?.name ?? "");
  const [when, setWhen] = useState<Trigger[]>(initial?.when ?? [freshTrigger("usage")]);
  const [orch, setOrch] = useState<Chain | undefined>(initial?.orchestrator);
  const [workers, setWorkers] = useState<Partial<Record<RoleId, Chain>>>(initial?.workers ?? {});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!name.trim()) { setError("Give the rule a name: it is what the Lantern and the log show."); return; }
    if (!orch && !ROLE_IDS.some((r) => workers[r])) { setError("A rule has to change something: switch on the chair or one of the roles."); return; }
    const rule: PolicyRule = {
      id: initial?.id ?? newRuleId(policy, name), name: name.trim(), when, enabled: initial?.enabled ?? true,
      ...(orch ? { orchestrator: orch } : {}),
      ...(ROLE_IDS.some((r) => workers[r]) ? { workers: Object.fromEntries(ROLE_IDS.filter((r) => workers[r]).map((r) => [r, workers[r]])) as PolicyRule["workers"] } : {}),
    };
    setBusy(true);
    const e = await onSave(rule).catch(() => "Could not reach the server.");
    setBusy(false);
    if (e) setError(e);
  };

  const setWhenAt = (i: number, t: Trigger) => setWhen(when.map((x, j) => (j === i ? t : x)));
  return (
    <SettingsForm label={initial ? `Edit ${initial.name}` : "New rule"} onSubmit={() => void submit()}>
      <Field label="Name" htmlFor={`${uid}-name`} help="What the Lantern and the log call it.">
        <input id={`${uid}-name`} value={name} maxLength={60} spellCheck={false} onChange={(e) => setName(e.target.value)}
          aria-describedby={helpIdFor(`${uid}-name`)} className={INPUT} style={INPUT_STYLE} />
      </Field>

      <div className="agx-field">
        <span className="agx-field-l">When</span>
        {when.map((t, i) => (
          <TriggerEditor key={i} id={`${uid}-when-${i}`} t={t} removable={when.length > 1}
            onChange={(n) => setWhenAt(i, n)} onRemove={() => setWhen(when.filter((_, j) => j !== i))} />
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={when.length >= TRIGGERS_MAX} onClick={() => setWhen([...when, freshTrigger("hours")])}>Add a condition</Button>
          <span className="text-[12px]" style={{ color: "var(--text3)" }}>{when.length > 1 ? "All of them have to hold." : ""}</span>
        </div>
      </div>

      <div className="agx-field">
        <span className="agx-field-l">Then</span>
        <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>A part left off keeps the choice above.</p>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Chip on={!!orch} resting onClick={() => setOrch(orch ? undefined : [firstOffered("orchestrator", readiness)])}>The chair</Chip>
            {orch && <ChainEditor id={`${uid}-orch`} label="The chair" chain={orch} role="orchestrator" readiness={readiness} onChange={setOrch} />}
          </div>
          {WORKER_ROLES.map((r) => {
            const c = workers[r.id];
            return (
              <div key={r.id} className="grid gap-2">
                <Chip on={!!c} resting onClick={() => setWorkers((w) => {
                  const n = { ...w };
                  if (n[r.id]) delete n[r.id]; else n[r.id] = [firstOffered("worker", readiness)];
                  return n;
                })}>{r.title}s</Chip>
                {c && <ChainEditor id={`${uid}-${r.id}`} label={`${r.title}s`} chain={c} role="worker" readiness={readiness}
                  onChange={(n) => setWorkers((w) => ({ ...w, [r.id]: n }))} />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="agx-sform-actions">
        <Button type="submit" tone="primary" pending={busy}>Save rule</Button>
        <Button type="button" onClick={onCancel}>Cancel</Button>
        {onDelete && <Button type="button" tone="danger" onClick={onDelete}>Delete rule</Button>}
      </div>
      {error && <div role="alert" className="agx-field-e">{error}</div>}
    </SettingsForm>
  );
}
