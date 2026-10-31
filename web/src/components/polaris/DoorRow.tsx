import { useState } from "react";
import { SettingRow } from "../SettingRow.tsx";
import { StatusBadge } from "../SettingsKit.tsx";
import { Select } from "../Select.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, Segmented, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { HOURS, MINUTES, PARAM_COPY } from "../../lib/polarisCopy.ts";
import { showsParams, type DoorView, type LimitView } from "../../lib/polarisView.ts";
import type { DoorValue, LabelRule } from "../../../../shared/polaris.ts";

/** A whole number setting: fewer, the number, more. */
function CountParam({ label, value, min, max, disabled, onChange }: { label: string; value: number; min: number; max: number; disabled: boolean; onChange: (n: number) => void }) {
  return (
    <span className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text2)" }}>
      {label}
      <Button label={`Fewer: ${label}`} square size="compact" disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>{"−"}</Button>
      <span className="tabular-nums text-center w-[28px]" style={{ color: "var(--text)" }}>{value}</span>
      <Button label={`More: ${label}`} square size="compact" disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>+</Button>
    </span>
  );
}

const labelOf = (r: LabelRule) => `${r.label}${r.base ? ` on ${r.base}` : ""}${r.paths?.length ? ` for ${r.paths.join(", ")}` : ""}`;

/** The label rules the labels door checks, and one line to add a rule. */
function RuleList({ rules, disabled, onChange }: { rules: LabelRule[]; disabled: boolean; onChange: (r: LabelRule[]) => void }) {
  const [label, setLabel] = useState("");
  const [base, setBase] = useState("");
  const [paths, setPaths] = useState("");
  const add = () => {
    const l = label.trim();
    if (!l) return;
    const p = paths.split(",").map((x) => x.trim()).filter(Boolean);
    onChange([...rules, { label: l, ...(base.trim() ? { base: base.trim() } : {}), ...(p.length ? { paths: p } : {}) }]);
    setLabel(""); setBase(""); setPaths("");
  };
  return (
    <div className="grid gap-2">
      {rules.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="list" aria-label="Label rules">
          {rules.map((r, i) => (
            <span key={i} role="listitem" className="inline-flex items-center gap-1.5">
              <code className="t-mono text-[11.5px] rounded-lg px-2 py-1" style={{ background: "var(--surface-inset)" }}>{labelOf(r)}</code>
              <Button label={`Remove the rule for ${r.label}`} square size="compact" disabled={disabled} onClick={() => onChange(rules.filter((_, j) => j !== i))}><CloseIcon size={ICON.sm} /></Button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}>
        <input value={label} spellCheck={false} placeholder="label it needs" aria-label="Label a pull request needs" disabled={disabled} onChange={(e) => setLabel(e.target.value)} className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 150 }} />
        <input value={base} spellCheck={false} placeholder="base branch (any)" aria-label="Base branch the rule applies to" disabled={disabled} onChange={(e) => setBase(e.target.value)} className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 150 }} />
        <input value={paths} spellCheck={false} placeholder="paths, comma separated (any)" aria-label="Path prefixes the rule applies to" disabled={disabled} onChange={(e) => setPaths(e.target.value)} className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 220 }} />
        <Button disabled={disabled || !label.trim()} onClick={add}>Add rule</Button>
      </div>
    </div>
  );
}

/** The dock label and the numbers excluded by hand. */
function DockParams({ value, disabled, onChange }: { value: DoorValue; disabled: boolean; onChange: (p: Record<string, unknown>) => void }) {
  const [label, setLabel] = useState(String(value.label ?? ""));
  const excluded = Array.isArray(value.excluded) ? (value.excluded as number[]) : [];
  const commit = () => { const t = label.trim(); if (t && t !== value.label) onChange({ label: t }); else setLabel(String(value.label ?? "")); };
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: "var(--text2)" }}>
        Label that docks
        <input value={label} spellCheck={false} aria-label="Label that docks a pull request" disabled={disabled} onChange={(e) => setLabel(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 160 }} />
      </div>
      {excluded.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]" style={{ color: "var(--text2)" }} role="list" aria-label="Excluded pull requests">
          Excluded
          {excluded.map((n) => (
            <span key={n} role="listitem" className="inline-flex items-center gap-1.5">
              <code className="t-mono text-[11.5px] rounded-lg px-2 py-1" style={{ background: "var(--surface-inset)" }}>#{n}</code>
              <Button label={`Undock #${n}`} square size="compact" disabled={disabled} onClick={() => onChange({ excluded: excluded.filter((x) => x !== n) })}><CloseIcon size={ICON.sm} /></Button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** The extra settings a door carries, under its row. Null when it has none or its mode does not use them. */
function Params({ v, disabled, onChange }: { v: DoorView; disabled: boolean; onChange: (p: Record<string, unknown>) => void }) {
  const val = v.value;
  switch (v.door) {
    case "dock": return <DockParams value={val} disabled={disabled} onChange={onChange} />;
    case "labels": return <RuleList rules={(val.rules as LabelRule[]) ?? []} disabled={disabled} onChange={(rules) => onChange({ rules })} />;
    case "lookAgain":
      return (
        <span className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text2)" }}>
            No sooner than every
            <Select value={String(val.minutes)} disabled={disabled} title="Minutes between passes" className="agx-select rounded-lg px-2 py-1.5 text-[12px] outline-none w-[110px] justify-between"
              options={[...new Set([...MINUTES, Number(val.minutes)])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: `${m} min` }))} onChange={(m) => onChange({ minutes: Number(m) })} />
          </span>
          <CountParam {...PARAM_COPY.steps} value={Number(val.steps)} disabled={disabled} onChange={(steps) => onChange({ steps })} />
        </span>
      );
    default: return null;
  }
}

/** One door: its sentence, its choice of how, the settings under it, and where its value comes from. */
export function DoorRow({ v, disabled, onMode, onParams, onReset }: {
  v: DoorView; disabled: boolean;
  onMode: (mode: string) => void;
  onParams: (patch: Record<string, unknown>) => void;
  /** In a project, a door with its own value goes back to the global one. */
  onReset?: () => void;
}) {
  return (
    <SettingRow
      label={
        <span className="inline-flex flex-wrap items-center gap-2">
          {v.name}
          {v.mark && <StatusBadge tone={v.mark === "Live" ? "warn" : "off"}>{v.mark}</StatusBadge>}
          {v.isNew && <StatusBadge tone="info">New</StatusBadge>}
        </span>
      }
      hint={<>{v.what}{v.source && <> <b>{v.source}.</b></>}</>}
      detail={{ summary: "Example, and what stays yours", body: <><span>Example: {v.example}</span><br /><span>You keep: {v.keep}</span></> }}
      control={
        <span className="inline-flex items-center gap-2">
          <Segmented track label={v.name} value={v.value.mode} options={v.options} disabled={disabled} onChange={onMode} />
          {onReset && <Button size="compact" disabled={disabled} title="Take this door from the global settings again" onClick={onReset}>Use global</Button>}
        </span>
      }
      below={showsParams(v.door, v.value.mode) ? <Params v={v} disabled={disabled} onChange={onParams} /> : undefined}
      wide
    />
  );
}

/** One number that caps a door, in the Limits group. Dimmed while its door is off: it takes effect when the door is on. */
export function LimitRow({ v, disabled, onChange }: { v: LimitView; disabled: boolean; onChange: (n: number) => void }) {
  const control = v.param === "hours"
    ? (
      <Select value={String(v.value)} disabled={disabled} title="Hours a pull request drifts before a course is proposed" className="agx-select rounded-lg px-2 py-1.5 text-[12px] outline-none w-[100px] justify-between"
        options={HOURS.map((h) => ({ value: String(h), label: `${h} h` }))} onChange={(h) => onChange(Number(h))} />
    )
    : <CountParam {...PARAM_COPY[v.param]} value={v.value} disabled={disabled} onChange={onChange} />;
  return (
    <SettingRow label={<span className="inline-flex flex-wrap items-center gap-2">{v.name}{!v.on && <StatusBadge tone="off">Door is off</StatusBadge>}</span>}
      hint={<>{v.hint} Belongs to “{v.doorName}”.{v.source && <> <b>{v.source}.</b></>}</>}
      control={control} />
  );
}
