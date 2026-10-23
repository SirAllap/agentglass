import { useEffect, useRef, useState, type ReactNode } from "react";
import { SELECT_BOX, helpIdFor } from "../SettingsKit.tsx";
import { Select } from "../Select.tsx";
import { EngineTile } from "./EngineTile.tsx";
import { EngineTiles } from "./EngineTiles.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, Chip, EDGE, INPUT, LINE, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { LAYER } from "../../lib/layers.ts";
import { CHAIN_MAX, ROLE_IDS, TRIGGERS_MAX, type Chain, type EngineChoice, type Policy, type PolicyRule, type Trigger } from "../../../../shared/orchestration.ts";
import { RuleStrip } from "./RuleStrips.tsx";
import { WORKER_ROLES, type RoleId } from "../../../../shared/workerRoles.ts";
import type { EngineReadiness } from "../../../../shared/types.ts";
import type { UsageProviderId } from "../../../../shared/orchestration.ts";
import {
  CHAIN_FULL, CHAIN_TAIL, GAUGE_HELP, chainAddFrom, chainMove, chainRemove, engineOptions, newRuleId, ruleLine, testDraft, usageChoices,
} from "./orchestrationCopy.ts";

/**
 * One rule, edited in a side sheet that opens over the page where the person
 * pressed Add or Edit: its name, when it applies (with the strip that shows it),
 * what it puts in place (as steps of tiles), the sentence the draft makes, and
 * a dry run of it against this moment. Nothing is saved until Save, Esc and
 * Cancel change nothing, and the server's own sentence for a refusal sits under
 * the buttons.
 *
 * A rule names the fields it changes and leaves the rest alone, so each part
 * under "Then" starts off and is switched on to say something.
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

/** The engine a switched-on part starts with: the first one its role can take, so a fresh entry is never an unknown id. */
function firstOffered(role: "orchestrator" | "worker", readiness: readonly EngineReadiness[] | null): EngineChoice {
  const o = engineOptions(role, readiness).find((x) => !x.disabled) ?? engineOptions(role, readiness)[0];
  return { engine: o?.value ?? "", model: "" };
}

/**
 * A chain as numbered steps, tried in order, then the tiles to add one with.
 * A step can move, go (the last one cannot) and name a model; a tile that
 * cannot run says why once and adds nothing when pressed.
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
    <div className="grid gap-2" role="group" aria-label={label}>
      <ol className="m-0 p-0 grid gap-2 list-none">
        {chain.map((c, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <EngineTile engine={c.engine} model={c.model} role={role} readiness={readiness} position={i + 1} />
            <input value={c.model} placeholder="its default model" spellCheck={false}
              id={`${id}-model-${i}`} aria-label={`${label}: model ${i + 1}`}
              onChange={(e) => set(i, { ...c, model: e.target.value })}
              className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 180 }} />
            <Button type="button" label="Move up" square disabled={i === 0} onClick={() => onChange(chainMove(chain, i, -1))}>↑</Button>
            <Button type="button" label="Move down" square disabled={i === chain.length - 1} onClick={() => onChange(chainMove(chain, i, 1))}>↓</Button>
            <Button type="button" label="Remove" square disabled={chain.length === 1} onClick={() => onChange(chainRemove(chain, i))}><CloseIcon size={ICON.sm} /></Button>
          </li>
        ))}
      </ol>
      {chain.length >= CHAIN_MAX ? (
        <span className="text-[12px]" style={{ color: "var(--text3)" }}>{CHAIN_FULL} {CHAIN_TAIL}</span>
      ) : (
        <>
          <span className="text-[12px] font-medium" style={{ color: "var(--text)" }}>Add a step</span>
          <EngineTiles role={role} readiness={readiness} label={`${label}: add a step`}
            onPick={(engine, options) => { const n = chainAddFrom(chain, options, engine); if (n) onChange(n); }} />
          <span className="text-[12px]" style={{ color: "var(--text3)" }}>Press a tile to add it as the next step. {CHAIN_TAIL}</span>
        </>
      )}
    </div>
  );
}

type Left = Partial<Record<UsageProviderId, number>>;

function TriggerEditor({ id, t, now, left, onChange, onRemove, removable }: {
  id: string; t: Trigger; now: Date; left: Left; onChange: (t: Trigger) => void; onRemove: () => void; removable: boolean;
}) {
  const choices = usageChoices();
  const num = (v: string) => Math.max(1, Math.min(99, Math.round(Number(v) || 1)));
  return (
    <div className="grid gap-3 rounded-lg p-3 min-w-0" style={{ background: "var(--surface-inset)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Condition">
          {KINDS.map((k) => <Chip key={k.id} on={t.kind === k.id} resting onClick={() => { if (k.id !== t.kind) onChange(freshTrigger(k.id)); }}>{k.label}</Chip>)}
        </div>
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
      {t.kind === "usage" && <RuleStrip when={[t]} now={now} left={left} />}
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
          <RuleStrip when={[t]} now={now} left={left} />
        </div>
      )}
    </div>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 min-w-0">
      <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>{label}</span>
      {children}
    </div>
  );
}

export interface RuleSheetProps {
  initial: PolicyRule | null;
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

/** The side sheet. Esc and the scrim close it; the person's place on the page is not moved. */
export function RuleSheet({ initial, policy, readiness, scope, facts, left, now, onSave, onCancel, onDelete }: RuleSheetProps) {
  const uid = initial?.id ?? "new-rule";
  const [name, setName] = useState(initial?.name ?? "");
  const [when, setWhen] = useState<Trigger[]>(initial?.when ?? [freshTrigger("usage")]);
  const [orch, setOrch] = useState<Chain | undefined>(initial?.orchestrator);
  const [workers, setWorkers] = useState<Partial<Record<RoleId, Chain>>>(initial?.workers ?? {});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<{ holds: string; lines: string[] } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus({ preventScroll: true }); }, []);

  const draft = (): PolicyRule => ({
    id: initial?.id ?? newRuleId(policy, name), name: name.trim(), when, enabled: initial?.enabled ?? true,
    ...(orch ? { orchestrator: orch } : {}),
    ...(ROLE_IDS.some((r) => workers[r]) ? { workers: Object.fromEntries(ROLE_IDS.filter((r) => workers[r]).map((r) => [r, workers[r]])) as PolicyRule["workers"] } : {}),
  });
  const submit = async () => {
    setError(null);
    if (!name.trim()) { setError("Give the rule a name: it is what the Lantern and the log show."); return; }
    if (!orch && !ROLE_IDS.some((r) => workers[r])) { setError("A rule has to change something: switch on the main agent or one of the jobs."); return; }
    setBusy(true);
    const e = await onSave(draft()).catch(() => "Could not reach the server.");
    setBusy(false);
    if (e) setError(e);
  };

  const setWhenAt = (i: number, t: Trigger) => { setWhen(when.map((x, j) => (j === i ? t : x))); setTested(null); };
  const preview = ruleLine({ ...draft(), name: name.trim() || "This rule" });
  const jobs: { key: string; title: string; chain: Chain | undefined; role: "orchestrator" | "worker"; toggle: () => void; set: (c: Chain) => void }[] = [
    { key: "orchestrator", title: "The main agent", chain: orch, role: "orchestrator", toggle: () => setOrch(orch ? undefined : [firstOffered("orchestrator", readiness)]), set: setOrch },
    ...WORKER_ROLES.map((r) => ({
      key: r.id, title: `${r.title}s`, chain: workers[r.id], role: "worker" as const,
      toggle: () => setWorkers((w) => { const n = { ...w }; if (n[r.id]) delete n[r.id]; else n[r.id] = [firstOffered("worker", readiness)]; return n; }),
      set: (c: Chain) => setWorkers((w) => ({ ...w, [r.id]: c })),
    })),
  ];
  return (
    <>
      <div aria-hidden className="fixed inset-0 agx-scrim" style={{ zIndex: LAYER.settingsDialog }} onClick={onCancel} />
      <aside role="dialog" aria-modal="true" aria-label={initial ? `Edit ${initial.name}` : "New rule"} data-sheet="rule"
        onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); onCancel(); } }}
        className="fixed top-0 right-0 bottom-0 flex flex-col w-[min(560px,100vw)]"
        style={{ zIndex: LAYER.settingsDialog, background: "var(--bg)", borderLeft: EDGE }}>
        <form className="flex flex-col min-h-0 flex-1" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="grid gap-1 p-4" style={{ borderBottom: LINE }}>
            <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>
              {initial ? "Editing" : "New"} condition for {scope}
            </span>
            <label htmlFor={`${uid}-name`} className="sr-only">Name</label>
            <input id={`${uid}-name`} ref={nameRef} value={name} maxLength={60} spellCheck={false} placeholder="Name this condition"
              onChange={(e) => setName(e.target.value)} className={INPUT} style={INPUT_STYLE} />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 grid gap-5 content-start">
            <Block label="When">
              {when.map((t, i) => (
                <TriggerEditor key={i} id={`${uid}-when-${i}`} t={t} now={now} left={left} removable={when.length > 1}
                  onChange={(n) => setWhenAt(i, n)} onRemove={() => { setWhen(when.filter((_, j) => j !== i)); setTested(null); }} />
              ))}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" disabled={when.length >= TRIGGERS_MAX} onClick={() => setWhen([...when, freshTrigger("hours")])}>Add a condition</Button>
                <span className="text-[12px]" style={{ color: "var(--text3)" }}>{when.length > 1 ? "All of them have to hold." : ""}</span>
              </div>
            </Block>
            <Block label="Then use">
              <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>A job left off keeps the choice on the page.</p>
              {jobs.map((j) => (
                <div key={j.key} className="grid gap-2 min-w-0">
                  <div><Chip on={!!j.chain} resting onClick={() => { j.toggle(); setTested(null); }}>{j.title}</Chip></div>
                  {j.chain && <ChainEditor id={`${uid}-${j.key}`} label={j.title} chain={j.chain} role={j.role} readiness={readiness}
                    onChange={(c) => { j.set(c); setTested(null); }} />}
                </div>
              ))}
            </Block>
            <Block label="What this would do">
              <p data-preview className="m-0 text-[13px] rounded-lg p-3 break-words" style={{ background: "var(--surface-inset)", color: "var(--text)" }}>{preview}</p>
            </Block>
            <Block label="Test it now">
              <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>Checks this draft against this moment. Nothing is started or saved.</p>
              <div><Button type="button" onClick={() => setTested(testDraft(policy, draft(), facts, new Date(), left, readiness))}>Test it now</Button></div>
              {tested && (
                <div role="status" data-tested className="grid gap-1 text-[12px]" style={{ color: "var(--text)" }}>
                  <p className="m-0 font-medium">{tested.holds}</p>
                  <ul className="m-0 pl-4 grid gap-1">{tested.lines.map((l) => <li key={l}>{l}</li>)}</ul>
                </div>
              )}
            </Block>
          </div>
          <div className="grid gap-2 p-4" style={{ borderTop: LINE }}>
            {error && <div role="alert" className="agx-field-e">{error}</div>}
            <div className="flex flex-wrap items-center gap-2">
              {onDelete && <Button type="button" tone="danger" onClick={onDelete}>Delete</Button>}
              <span className="flex-1" />
              <Button type="button" onClick={onCancel}>Cancel</Button>
              <Button type="submit" tone="primary" pending={busy}>Save for {scope}</Button>
            </div>
          </div>
        </form>
      </aside>
    </>
  );
}

