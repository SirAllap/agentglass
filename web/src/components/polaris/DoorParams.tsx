/*
 * The settings a door carries beside its mode, drawn under its row. One module
 * so the Polaris view and any later card edit the same keys, and so a key
 * without an editor is visible to a test (editorFor).
 */
import { useEffect, useState } from "react";
import { Select } from "../Select.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { MINUTES, PARAM_COPY } from "../../lib/polarisCopy.ts";
import { editorFor, type ParamEditor } from "../../lib/polarisView.ts";
import { DOOR_PARAMS, type DoorId, type DoorValue, type LabelRule } from "../../../../shared/polaris.ts";

const labelOf = (r: LabelRule) => `${r.label}${r.base ? ` on ${r.base}` : ""}${r.paths?.length ? ` for ${r.paths.join(", ")}` : ""}`;

/** A whole number setting: fewer, the number, more. */
function CountParam({ label, value, min, max, disabled, onChange }: {
  label: string; value: number; min: number; max: number; disabled: boolean; onChange: (n: number) => void;
}) {
  return (
    <span className="agx-pol-param">
      {label}
      <Button label={`Fewer: ${label}`} square size="compact" disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>−</Button>
      <span className="tabular-nums" style={{ minWidth: 22, textAlign: "center" }}>{value}</span>
      <Button label={`More: ${label}`} square size="compact" disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>+</Button>
    </span>
  );
}

/** The label that docks a pull request: typed, then committed on Enter or when it loses focus. */
function DockLabel({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (v: string) => void }) {
  const [label, setLabel] = useState(String(value ?? ""));
  // The stored label can change under an open field (another window saved): follow it, or the next blur writes the old text back.
  useEffect(() => { setLabel(String(value ?? "")); }, [value]);
  const commit = () => { const t = label.trim(); if (t && t !== value) onChange(t); else setLabel(String(value ?? "")); };
  return (
    <span className="agx-pol-param">
      Label that docks
      <input value={label} spellCheck={false} aria-label="Label that docks a pull request" disabled={disabled}
        onChange={(e) => setLabel(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 160 }} />
    </span>
  );
}

/** The pull requests docked by number, taken out one at a time. */
function ExcludedList({ numbers, disabled, onChange }: { numbers: number[]; disabled: boolean; onChange: (n: number[]) => void }) {
  return (
    <span className="agx-pol-param" role="list" aria-label="Excluded pull requests">
      {numbers.length === 0
        ? <span role="listitem">No pull request excluded by number.</span>
        : <span role="listitem">Excluded</span>}
      {numbers.map((n) => (
        <span key={n} role="listitem" className="inline-flex items-center gap-1.5">
          <code className="t-mono px-1.5 py-px" style={{ background: "var(--surface-inset)", borderRadius: 6 }}>#{n}</code>
          <Button label={`Undock #${n}`} square size="compact" disabled={disabled} onClick={() => onChange(numbers.filter((x) => x !== n))}><CloseIcon size={ICON.sm} /></Button>
        </span>
      ))}
    </span>
  );
}

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
    <span className="grid gap-2 w-full">
      {rules.length > 0 && (
        <span className="flex flex-wrap gap-1.5" role="list" aria-label="Label rules">
          {rules.map((r, i) => (
            <span key={i} role="listitem" className="inline-flex items-center gap-1.5">
              <code className="t-mono px-1.5 py-px" style={{ background: "var(--surface-inset)", borderRadius: 6 }}>{labelOf(r)}</code>
              <Button label={`Remove the rule for ${r.label}`} square size="compact" disabled={disabled} onClick={() => onChange(rules.filter((_, j) => j !== i))}><CloseIcon size={ICON.sm} /></Button>
            </span>
          ))}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-2" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}>
        <input value={label} spellCheck={false} placeholder="label it needs" aria-label="Label a pull request needs" disabled={disabled} onChange={(e) => setLabel(e.target.value)} className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 150 }} />
        <input value={base} spellCheck={false} placeholder="base branch (any)" aria-label="Base branch the rule applies to" disabled={disabled} onChange={(e) => setBase(e.target.value)} className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 150 }} />
        <input value={paths} spellCheck={false} placeholder="paths, comma separated (any)" aria-label="Path prefixes the rule applies to" disabled={disabled} onChange={(e) => setPaths(e.target.value)} className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 220 }} />
        <Button disabled={disabled || !label.trim()} onClick={add}>Add rule</Button>
      </span>
    </span>
  );
}

const MINUTE_CHOICES = (current: number) => [...new Set([...MINUTES, current])].sort((a, b) => a - b);

/** One key of a door, by the kind of editor editorFor says it needs. Null means no editor exists yet. */
function Editor({ kind, name, value, disabled, onChange }: {
  kind: ParamEditor; name: string; value: unknown; disabled: boolean; onChange: (v: unknown) => void;
}) {
  switch (kind) {
    case "text": return <DockLabel value={String(value ?? "")} disabled={disabled} onChange={onChange} />;
    case "list": return <ExcludedList numbers={Array.isArray(value) ? (value as number[]) : []} disabled={disabled} onChange={onChange} />;
    case "rules": return <RuleList rules={(value as LabelRule[]) ?? []} disabled={disabled} onChange={onChange} />;
    case "minutes": {
      const n = Number(value);
      return (
        <span className="agx-pol-param">
          No sooner than every
          <Select value={String(n)} disabled={disabled} title="Minutes between passes"
            className="agx-select rounded-lg px-2 py-1.5 text-[12px] outline-none w-[110px] justify-between"
            options={MINUTE_CHOICES(n).map((m) => ({ value: String(m), label: `${m} min` }))} onChange={(m) => onChange(Number(m))} />
        </span>
      );
    }
    case "count": {
      const copy = PARAM_COPY[name as keyof typeof PARAM_COPY];
      if (!copy) return null;
      return <CountParam label={copy.label} value={Number(value)} min={copy.min} max={copy.max} disabled={disabled} onChange={onChange} />;
    }
    default: return null;
  }
}

/** Every setting a door carries, one editor each, in the order shared/polaris.ts declares them. */
export function DoorParams({ door, value, disabled, onChange }: {
  door: DoorId; value: DoorValue; disabled: boolean; onChange: (patch: Record<string, unknown>) => void;
}) {
  const keys = Object.keys(DOOR_PARAMS[door]);
  if (keys.length === 0) return null;
  return (
    <div className="agx-pol-params">
      {keys.map((key) => {
        const kind = editorFor(door, key);
        return kind
          ? <Editor key={key} kind={kind} name={key} value={value[key]} disabled={disabled} onChange={(v) => onChange({ [key]: v })} />
          : <span key={key} className="agx-pol-error" role="alert">{`${door}.${key} has no editor in this view.`}</span>;
      })}
    </div>
  );
}

export { CountParam, RuleList };
