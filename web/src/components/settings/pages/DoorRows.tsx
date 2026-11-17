import { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { Select } from "../../Select.tsx";
import { Switch } from "../../SettingRow.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { TextCommitField, pushSaveToast } from "../save/index.ts";
import { DoorValueRow } from "../../orchestration/DoorValueRow.tsx";
import { FLIGHT_PLAN_ROWS } from "../../orchestration/doorSpecs.ts";
import type { ScopeChoice } from "../scope/scopeModel.ts";

/** One stored setting, drawn as a shell row. `help` is one sentence, 14 words at most. */
export type DoorSpec = { id: string; label: string; help: string } & (
  | { kind: "bool" }
  | { kind: "choice"; options: { value: string; label: string }[] }
  | { kind: "number"; min?: number; max?: number }
  | { kind: "text"; placeholder?: string }
  | { kind: "list"; placeholder?: string }
);

const shown = (spec: DoorSpec, v: unknown): string => (v === undefined || v === null ? "" : spec.kind === "list" && Array.isArray(v) ? v.join(", ") : String(v));

const parse = (spec: DoorSpec, s: string): { ok: true; value: unknown } | { ok: false; error: string } => {
  if (spec.kind === "number") {
    const n = Number(s);
    if (s.trim() === "" || !Number.isFinite(n)) return { ok: false, error: "Use a number." };
    if (spec.min !== undefined && n < spec.min) return { ok: false, error: `Use ${spec.min} or more.` };
    if (spec.max !== undefined && n > spec.max) return { ok: false, error: `Use ${spec.max} or less.` };
    return { ok: true, value: n };
  }
  if (spec.kind === "list") return { ok: true, value: s.split(",").map((x) => x.trim()).filter(Boolean) };
  return { ok: true, value: s.trim() };
};

/** Read and written through the settings door, as an agent does: a change that must wait for the person says so. */
export function DoorRow({ spec, root }: { spec: DoorSpec; root: string }) {
  const [value, setValue] = useState<unknown>(undefined);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    setLoaded(false);
    void api.settingAt(spec.id, root).catch(() => null).then((r) => {
      if (!live) return;
      if (r?.ok) setValue(r.value);
      setLoaded(true);
    });
    return () => { live = false; };
  }, [spec.id, root]);

  const write = useCallback(async (to: unknown, back: unknown) => {
    const r = await api.settingAtSet(spec.id, to, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined }));
    if (!r.ok || r.applied === false) {
      setValue(back);
      pushSaveToast(r.ok ? "That change waits for you on the requests card" : "Could not save it", () => setValue(back));
      return false;
    }
    return true;
  }, [spec.id, root]);

  // The shell's save model: set at once, then Undo writes the old value back through the same writer.
  const apply = useCallback((to: unknown) => {
    const old = value;
    if (Object.is(old, to)) return;
    setValue(to);
    void write(to, old).then((ok) => { if (ok) pushSaveToast("Saved", () => { setValue(old); void write(old, to); }); });
  }, [value, write]);

  let control;
  if (spec.kind === "bool") {
    control = (
      <button type="button" role="switch" aria-checked={value === true} aria-label={spec.label} disabled={!loaded} onClick={() => apply(value !== true)}>
        <Switch on={value === true} />
      </button>
    );
  } else if (spec.kind === "choice") {
    control = <Select value={String(value ?? "")} disabled={!loaded} options={spec.options} onChange={(v) => apply(v)} />;
  } else {
    control = (
      <TextCommitField label={spec.label} value={shown(spec, value)} mono={spec.kind !== "text" || undefined}
        placeholder={spec.kind === "number" ? "" : spec.placeholder}
        validate={(v) => { const p = parse(spec, v); return p.ok ? null : p.error; }}
        onSave={(v) => { const p = parse(spec, v); if (p.ok && shown(spec, p.value) !== shown(spec, value)) apply(p.value); }} />
    );
  }
  return <SettingRow kind="control" settingId={spec.id} label={spec.label} help={spec.help} control={control} />;
}

/** The rows of one spec table, in order. The settings index reads the table named in `specs`. */
export function DoorRowList({ title: _title, specs, root, choice }: { title: string; specs: DoorSpec[]; root: string; choice?: ScopeChoice }) {
  // Under a scope control a Flight plan row is the scope-aware one: it shows its own tag and locks a machine value under one project.
  return <>{specs.map((s) => { const r = choice ? FLIGHT_PLAN_ROWS.find((x) => x.id === s.id) : undefined; return r ? <DoorValueRow key={s.id} spec={r} root={root} choice={choice} help={s.help} /> : <DoorRow key={s.id} spec={s} root={root} />; })}</>;
}
