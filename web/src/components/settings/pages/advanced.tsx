import { useCallback, useEffect, useMemo, useState } from "react";
import { INPUT, INPUT_STYLE } from "../../workspace/Chrome.tsx";
import { api } from "../../../lib/api.ts";
import { Select } from "../../Select.tsx";
import { Switch } from "../../SettingRow.tsx";
import { SettingsPage, type PageSection } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { TouchTags } from "./ValueView.tsx";
import { splitTouch } from "./valueKind.ts";
import { TmuxRow } from "./TmuxRows.tsx";
import { TextCommitField, pushSaveToast, RESTART_MESSAGE } from "../save/index.ts";
import { mcpModesOf } from "../../../../../shared/mcpReadonly.ts";
import type { PageCtx } from "./ctx.ts";
import { ADVANCED_ROWS, ADVANCED_SECTIONS, filterAdvanced, type AdvRow } from "./advancedRows.ts";

type Held = { name: string; value: string } | null;
type Loaded = { state: "loading" } | { state: "failed" } | { state: "ok"; value: unknown; held: Held };

/** Stored value as the text a field shows. */
const shown = (r: AdvRow, v: unknown): string => {
  if (v === undefined || v === null) return "";
  if (r.kind === "list") return Array.isArray(v) ? v.join("\n") : String(v);
  return String(v);
};

/** Validate a typed number or text; returns the error line, or null. */
const checkNumber = (r: Extract<AdvRow, { kind: "number" }>) => (s: string): string | null => {
  const n = Number(s);
  if (s.trim() === "" || !Number.isFinite(n)) return "A number is needed";
  if (r.min !== undefined && n < r.min) return `At least ${r.min}`;
  if (r.max !== undefined && n > r.max) return `At most ${r.max}`;
  return null;
};

/** One writable machine row, read and written through the settings door by id (the same door an agent uses). */
function DoorRow({ row }: { row: AdvRow }) {
  const id = row.id as string;
  const [s, setS] = useState<Loaded>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [available, setAvailable] = useState<string[]>([]);
  const load = useCallback(() => {
    setS({ state: "loading" });
    void api.settingAtGlobal(id).catch(() => null).then((r) => {
      if (r?.ok) setS({ state: "ok", value: r.value, held: r.env ?? null });
      else setS({ state: "failed" });
    });
    if (row.kind === "mcp") void api.settingAtGlobal("workers.mcpServers.available").then((r) => { if (r.ok && Array.isArray(r.value)) setAvailable(r.value as string[]); }).catch(() => undefined);
  }, [id, row.kind]);
  useEffect(() => { load(); }, [load]);

  /** Write through the door; on success keep the new value and offer Undo that writes the old one back the same way. */
  const write = useCallback(async (next: unknown, old: unknown, offerUndo: boolean) => {
    setBusy(true); setNote("");
    const r = await api.settingAtSet(id, next, "").catch(() => ({ ok: false, applied: undefined as boolean | undefined, error: "Could not reach the server" }));
    setBusy(false);
    if (!r.ok) { setNote(r.error || "Could not save it"); return; }
    if (r.applied === false) { setNote("That change waits for you on the requests card."); return; }
    setS((cur) => (cur.state === "ok" ? { ...cur, value: next } : cur));
    if (offerUndo) pushSaveToast(row.restart ? RESTART_MESSAGE : "Saved", () => { void write(old, next, false); });
  }, [id, row.restart]);

  if (s.state !== "ok") {
    return (
      <SettingRow kind="link" label={row.label} help={s.state === "loading" ? row.touch : "This value could not be read. Nothing was changed."}
        linkText={s.state === "loading" ? "Reading…" : "Retry"} onOpen={s.state === "loading" ? undefined : load} />
    );
  }
  const { value, held } = s;
  const lock = !!held;
  const alert = note ? <span role="alert" className="text-[11px]" style={{ color: "var(--error-ink)" }}>{note}</span> : null;
  let control: React.ReactNode = null;
  if (row.kind === "bool") {
    // A limit switch stores "1" or "0"; a plain setting stores a boolean. The door says which by what it returned.
    const asText = typeof value === "string";
    const on = value === true || value === "1";
    control = (
      <button type="button" role="switch" aria-checked={on} aria-label={row.label} disabled={busy || lock} data-setting={id}
        onClick={() => void write(asText ? (on ? "0" : "1") : !on, value, true)} className="inline-flex">
        <Switch on={on} busy={busy} />
      </button>
    );
  } else if (row.kind === "choice") {
    control = <Select value={String(value ?? "")} busy={busy} disabled={lock} options={row.options} onChange={(v) => { if (v !== String(value ?? "")) void write(typeof value === "number" ? Number(v) : v, value, true); }} />;
  } else if (row.kind === "number") {
    control = <TextCommitField label={row.label} value={shown(row, value)} validate={checkNumber(row)} onSave={(v) => void write(Number(v), value, true)} />;
  } else if (row.kind === "text" || row.kind === "list") {
    control = <TextCommitField label={row.label} value={shown(row, value)} placeholder={row.kind === "list" || row.kind === "text" ? (row as { placeholder?: string }).placeholder : undefined} mono
      onSave={(v) => void write(row.kind === "list" ? v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean).join("\n") : v, value, true)} />;
  } else if (row.kind === "mcp") {
    const modes = mcpModesOf(value);
    const names = [...new Set([...available, ...Object.keys(modes)])];
    control = names.length === 0
      ? <span className="text-[12px]" style={{ color: "var(--text2)" }}>No tool servers found on this machine</span>
      : (
        <div className="flex flex-col gap-1.5 items-end">
          {names.map((n) => (
            <div key={n} className="flex items-center gap-2">
              <span className="font-mono text-[12px]">{n}</span>
              <Select value={modes[n] ?? "off"} busy={busy} disabled={lock}
                options={[{ value: "off", label: "Off" }, { value: "readOnly", label: "Read-only" }, { value: "all", label: "All" }]}
                onChange={(m) => {
                  const next: Record<string, string> = { ...modes };
                  if (m === "off") delete next[n]; else next[n] = m;
                  void write(next, modes, true);
                }} />
            </div>
          ))}
        </div>
      );
  }
  const ctl = <>{alert}{control}</>;
  const { what, when } = splitTouch(row.touch);
  const tag = <TouchTags when={when} restart={row.restart} />;
  if (lock) return <SettingRow kind="locked" label={row.label} help={what} tag={tag} control={ctl} reason="Set by the environment" />;
  return <SettingRow kind="control" label={row.label} help={what} tag={tag} control={ctl} />;
}

/** Advanced: every writable machine setting, each with the one line saying when you would touch it. */
export function AdvancedSettingsPage({ c }: { c?: Pick<PageCtx, "setPane"> }) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => filterAdvanced(ADVANCED_ROWS, q), [q]);
  const sections: PageSection[] = ADVANCED_SECTIONS.flatMap((title): PageSection[] => {
    const mine = rows.filter((r) => r.section === title);
    if (mine.length === 0) return [];
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return [{
      id, title, kind: "normal",
      body: (
        <Section id={id} title={title}>
          {mine.map((r) => r.kind === "link"
            ? <SettingRow key={r.key} kind="link" label={r.label} help={splitTouch(r.touch).what} tag={<TouchTags when={splitTouch(r.touch).when} />} linkText={r.linkText} onOpen={() => c?.setPane(r.pane as never)} />
            : r.kind === "tmux"
              ? <TmuxRow key={r.key} field={r.field} label={r.label} help={r.touch} />
              : <DoorRow key={r.key} row={r} />)}
        </Section>
      ),
    }];
  });
  if (sections.length === 0) {
    sections.push({ id: "none", title: "No match", kind: "normal", body: <p className="text-[13px]" style={{ color: "var(--text2)" }}>{`No setting matches "${q.trim()}"`}</p> });
  }
  return (
    <SettingsPage title="Advanced" purpose="Machine settings, each with when you would touch it."
      scopeSlot={(
        <div className="flex flex-col gap-2">
          <p data-banner className="text-[12px]" style={{ color: "var(--text2)" }}>Read once when the app starts. Change a value, then restart.</p>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter advanced settings" placeholder="Filter by label or help"
            className={`${INPUT} w-full max-w-[360px]`} style={INPUT_STYLE} />
        </div>
      )}
      sections={sections} />
  );
}
