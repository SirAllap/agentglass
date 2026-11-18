import { useCallback, useEffect, useState } from "react";
import { SettingRow } from "../settings/shell/SettingRow.tsx";
import { SettingsCard } from "../SettingsKit.tsx";
import { Select } from "../Select.tsx";
import { Switch } from "../SettingRow.tsx";
import { TextCommitField, pushSaveToast, RESTART_MESSAGE } from "../settings/save/index.ts";
import { api } from "../../lib/api.ts";
import { ENV_LIMITS } from "../../../../shared/envLimits.ts";
import { ScopeTag } from "../settings/scope/ScopeControl.tsx";
import { ScopeFilter, useReportRow } from "../settings/scope/ledger.tsx";
import { LOCKED_TEXT, rowTag, type ScopeChoice, type ScopeRow } from "../settings/scope/scopeModel.ts";

/** How a setting's value is drawn. `list` is a comma-separated array of text. A stored shape with its own editor
 *  elsewhere (a role, a launch flag, the policy) is not a door row: it is read on Inspect, where a raw value belongs. */
export type DoorKind =
  | { kind: "bool" }
  | { kind: "choice"; options: { value: string; label: string }[] }
  | { kind: "number"; min?: number; max?: number }
  | { kind: "text"; placeholder?: string }
  | { kind: "list"; placeholder?: string };

export type DoorRowSpec = { id: string; label: string; hint: string; /** A machine value: it cannot differ per project, so a page with the scope control locks it under "Only <project>". */ machine?: true; /** The row may be held by an environment variable: the door says which, and the row locks. */ lockable?: true; /** The value is read only at start: the toast says so. */ restart?: true } & DoorKind;

const toShown = (spec: DoorRowSpec, v: unknown): string => {
  if (v === undefined || v === null) return "";
  if (spec.kind === "list") return Array.isArray(v) ? v.join(", ") : String(v);
  return String(v);
};

const fromShown = (spec: DoorRowSpec, s: string): { ok: true; value: unknown } | { ok: false; error: string } => {
  if (spec.kind === "number") {
    const n = Number(s);
    if (s.trim() === "" || !Number.isFinite(n)) return { ok: false, error: "Use a number." };
    if (spec.min !== undefined && n < spec.min) return { ok: false, error: `Use ${spec.min} or more.` };
    if (spec.max !== undefined && n > spec.max) return { ok: false, error: `Use ${spec.max} or less.` };
    return { ok: true, value: n };
  }
  if (spec.kind === "list") return { ok: true, value: s.split(",").map((x) => x.trim()).filter(Boolean) };
  return { ok: true, value: s };
};

/**
 * One setting of the settings door, read and written where it lives: the same door an agent uses, so a change
 * that must wait for the person waits here too ("applied: false") and the row says so instead of showing it saved.
 * It saves the way every Settings row does: a switch or a choice at once with an Undo toast, a text or number on
 * blur or Enter. `root` is the project; a machine-wide setting ignores it. `help` replaces the spec's hint.
 */
export function DoorValueRow({ spec, root, choice, help }: { spec: DoorRowSpec; root: string; choice?: ScopeChoice; help?: string }) {
  const [value, setValue] = useState<unknown>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reads, setReads] = useState(0);
  const [note, setNote] = useState("");
  const [held, setHeld] = useState<{ name: string; value: string } | null>(null);
  /** What All projects hold, and whether this project holds a value of its own: what the scope tag compares. */
  const [general, setGeneral] = useState<unknown>(undefined);
  const [scoped, setScoped] = useState(false);
  const machine = !!spec.machine || !!spec.lockable;
  useEffect(() => {
    if (!choice || !root || machine) { setGeneral(undefined); return; }
    let live = true;
    void api.settingAtGlobal(spec.id).catch(() => null).then((r) => { if (live && r?.ok) setGeneral(r.value); });
    return () => { live = false; };
  }, [spec.id, root, choice, machine]);
  useEffect(() => {
    let live = true;
    setLoaded(false); setFailed(false);
    void (spec.lockable ? api.settingAtGlobal(spec.id) : api.settingAt(spec.id, root)).catch(() => null).then((r) => {
      if (!live) return;
      if (r?.ok) { setValue(r.value); setScoped(!!root && !!(r as { scopedSet?: boolean }).scopedSet); setHeld((r as { env?: { name: string; value: string } | null }).env ?? null); }
      else setFailed(true);
      setLoaded(true);
    });
    return () => { live = false; };
  }, [spec.id, root, reads]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Write one value. Answers whether it was kept; a refusal or a wait puts the old value back and says why. */
  const write = useCallback(async (to: unknown, back: unknown): Promise<boolean> => {
    setNote("");
    const r = await api.settingAtSet(spec.id, to, root).catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server." }));
    if (!r.ok) { setValue(back); setNote(r.error || "Could not save it."); return false; }
    if (r.applied === false) { setValue(back); setNote("That change waits for you on the requests card."); return false; }
    setScoped(!!root);
    return true;
  }, [spec.id, root]);
  /** The shell's save model: set at once, then Undo writes the old value back through the same writer. */
  const apply = useCallback((to: unknown, toast = true) => {
    const old = value;
    if (JSON.stringify(old) === JSON.stringify(to)) return;
    setValue(to);
    void write(to, old).then((ok) => {
      if (ok && toast) pushSaveToast(spec.restart ? RESTART_MESSAGE : "Saved", () => { setValue(old); void write(old, to); });
    });
  }, [value, write, spec.restart]);

  const row: ScopeRow<unknown> = { id: spec.id, general, own: scoped && loaded && general !== undefined && JSON.stringify(value) !== JSON.stringify(general) ? value : undefined, machine };
  const tag = choice ? rowTag(row, choice, (v) => toShown(spec, v) || "empty") : ({ kind: "none" } as const);
  useReportRow(spec.id, tag.kind === "differs");
  // Under "Only <project>" a machine value is locked: the control stays, greyed, and says why. An environment variable locks it too.
  const lockReason = held ? "Set by the environment" : choice === "project" && machine ? LOCKED_TEXT : null;
  // A locked row says why once, in its reason line: the same sentence again as a tag is noise.
  const showTag = tag.kind !== "none" && !(tag.kind === "locked" && lockReason);
  const extra = (showTag || held || note) ? (
    <>
      {showTag && <div className="mt-1"><ScopeTag tag={tag} onReset={() => apply(general)} /></div>}
      {held && <div className="mt-1 text-[11px]" style={{ color: "var(--text2)" }}><span className="font-mono">{held.name}</span> = <span className="font-mono">{held.value || "(empty)"}</span></div>}
      {note && <div role="alert" className="mt-1 text-[12px]" style={{ color: "var(--error-ink)" }}>{note}</div>}
    </>
  ) : undefined;
  const helpText = help ?? spec.hint;

  // A value that could not be read is said in plain words with a way to try again, never as a raw error or a stored shape.
  if (failed) {
    return <ScopeFilter differs={tag.kind === "differs"}><SettingRow kind="link" settingId={spec.id} label={spec.label} help="This value could not be read. Nothing was changed." linkText="Retry" onOpen={() => setReads((n) => n + 1)} /></ScopeFilter>;
  }

  let control: React.ReactNode;
  const off = !loaded;
  if (spec.kind === "bool") {
    control = <button type="button" role="switch" aria-checked={value === true} aria-label={spec.label} disabled={off} onClick={() => apply(value !== true)}><Switch on={value === true} /></button>;
  } else if (spec.kind === "choice") {
    control = <Select value={String(value ?? "")} disabled={off} options={spec.options} onChange={(v) => apply(v)} />;
  } else {
    control = (
      <TextCommitField label={spec.label} value={toShown(spec, value)} mono={spec.kind === "list" || undefined}
        placeholder={spec.kind === "text" || spec.kind === "list" ? spec.placeholder : undefined}
        validate={(v) => { const p = fromShown(spec, v); return p.ok ? null : p.error; }}
        onSave={(v) => { const p = fromShown(spec, v); if (p.ok) apply(p.value, false); }} />
    );
  }
  return (
    <ScopeFilter differs={tag.kind === "differs"}>
      {lockReason
        ? <SettingRow kind="locked" settingId={spec.id} label={spec.label} help={helpText} control={control} reason={lockReason} tag={extra} />
        : <SettingRow kind="control" settingId={spec.id} label={spec.label} help={helpText} control={control} tag={extra} />}
    </ScopeFilter>
  );
}

/** The first sentence of a longer hint: a row's help is one sentence. The restart note a hint may end with is said by the toast. */
export const oneSentence = (hint: string): string => hint.split(/(?<=[.!?])\s+/)[0] ?? hint;

/** A card of door rows, one per spec. */
export function DoorCard({ title, specs, root, choice, children }: { title: string; specs: DoorRowSpec[]; root: string; choice?: ScopeChoice; children?: React.ReactNode }) {
  return (
    <SettingsCard title={title}>
      {specs.map((s) => <DoorValueRow key={s.id} spec={s} root={root} choice={choice} />)}
      {children}
    </SettingsCard>
  );
}

/** The limits the environment can also hold, one row each from the shared table: a set variable locks its row. */
export function EnvLimitsCard({ root, title = "Limits" }: { root: string; title?: string }) {
  return (
    <SettingsCard title={title}>
      {ENV_LIMITS.map((l) => (
        <DoorValueRow key={l.id} root={root} spec={{
          id: l.id, label: l.label, lockable: true,
          hint: oneSentence(l.hint), ...(l.restart ? { restart: true as const } : {}),
          ...(l.kind === "switch" ? { kind: "bool" as const } : l.kind === "number" ? { kind: "number" as const, min: l.min, max: l.max } : { kind: "text" as const }),
        } as DoorRowSpec} />
      ))}
    </SettingsCard>
  );
}
