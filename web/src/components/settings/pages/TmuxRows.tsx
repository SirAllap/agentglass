import { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { Select } from "../../Select.tsx";
import { INPUT, INPUT_STYLE, Segmented } from "../../workspace/Chrome.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { TextCommitField, pushSaveToast } from "../save/index.ts";
import { TouchTags } from "./ValueView.tsx";
import { splitTouch } from "./valueKind.ts";
import { useCustomPrefix } from "./customPrefix.ts";

type Tmux = Awaited<ReturnType<typeof api.tmuxStatus>>;
export type TmuxField = "mode" | "override" | "path" | "binary" | "customPrefix" | "prefix" | "runsOn";

const PREFIXES = [
  { value: "", label: "C-b (tmux default)" },
  { value: "C-a", label: "C-a (screen)" },
  { value: "C-f", label: "C-f" },
  { value: "C-Space", label: "C-Space" },
];

/** The tmux engine rows of Advanced > Terminal engine, saved the moment they change (Undo from the toast). */
export function TmuxRow({ field, label, help: touch }: { field: TmuxField; label: string; help: string }) {
  const { what: help, when } = splitTouch(touch);
  const tag = <TouchTags when={when} />;
  const [st, setSt] = useState<Tmux | null>(null);
  const [down, setDown] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [custom, setCustom] = useCustomPrefix();
  const load = useCallback(() => api.tmuxStatus().then((r) => { setSt(r); setDown(false); }).catch(() => setDown(true)), []);
  useEffect(() => { void load(); }, [load]);
  // The custom flag is shared across row instances (customPrefix.ts); a prefix not in the list is custom too.
  const prefix = st?.prefix || "";
  const listed = PREFIXES.some((p) => p.value === prefix);

  const fail = (e?: string) => setNote(e || "Could not save it");
  /** Save one field now; on success offer Undo that writes the old values back. */
  const save = async (send: () => Promise<{ ok: boolean; error?: string }>, undo: () => Promise<{ ok: boolean; error?: string }>) => {
    setNote(null);
    const r = await send().catch(() => ({ ok: false, error: "Could not reach the server" }));
    if (!r.ok) { fail(r.error); return; }
    await load();
    pushSaveToast("Saved", () => { void undo().then(() => load()); });
  };

  if (down) return <SettingRow kind="link" label={label} help="Could not read this value, so nothing was changed." linkText="Retry" onOpen={() => void load()} />;
  if (!st) return <SettingRow kind="control" label={label} help={help} tag={tag} control={<span role="status" className="text-[12px]" style={{ color: "var(--text2)" }}>Reading…</span>} />;
  const alert = note ? <span role="alert" className="text-[11px]" style={{ color: "var(--error-ink)" }}>{note}</span> : null;
  const row = (control: React.ReactNode, extra?: { agentNever?: string }) => <SettingRow kind="control" label={label} help={help} tag={tag} {...extra} control={<>{alert}{control}</>} />;

  switch (field) {
    case "binary": {
      const old = st.source;
      return row(<Segmented track label={label} value={st.source as "auto" | "bundled" | "system" | "custom"}
        options={[{ id: "auto", label: "Auto" }, { id: "bundled", label: "Bundled" }, { id: "system", label: "System" }, { id: "custom", label: "Custom" }]}
        onChange={(v) => void save(() => api.tmuxSettingsSave({ source: v, path: v === "custom" ? st.bin.path || "" : undefined }), () => api.tmuxSettingsSave({ source: old, path: old === "custom" ? st.bin.path || "" : undefined }))} />);
    }
    case "path": {
      if (st.source !== "custom") return <SettingRow kind="locked" label={label} help={help} tag={tag} reason="Used only when the binary is Custom" control={<span className="text-[12px]">{st.bin.path || "None"}</span>} />;
      const old = st.bin.path || "";
      return row(<TextCommitField label={label} mono value={old} placeholder="/path/to/tmux"
        onSave={(v) => void save(() => api.tmuxSettingsSave({ source: "custom", path: v }), () => api.tmuxSettingsSave({ source: "custom", path: old }))} />);
    }
    case "prefix": {
      const old = prefix;
      return row(<Select value={listed && !custom ? prefix : "custom"} align="right"
        options={[...PREFIXES, { value: "custom", label: "Custom…" }]}
        onChange={(v) => { if (v === "custom") { setCustom(true); return; } setCustom(false); void save(() => api.tmuxSettingsSave({ prefix: v }), () => api.tmuxSettingsSave({ prefix: old })); }} />);
    }
    case "customPrefix": {
      if (listed && !custom) return <SettingRow kind="locked" label={label} help={help} tag={tag} reason="Pick Custom in Prefix key to use it" control={<span className="text-[12px]">{prefix || "C-b"}</span>} />;
      const old = prefix;
      return row(<TextCommitField label={label} mono value={old} placeholder="C-a"
        onSave={(v) => void save(() => api.tmuxSettingsSave({ prefix: v.trim() }), () => api.tmuxSettingsSave({ prefix: old }))} />);
    }
    case "mode": {
      const old = st.confMode;
      return row(<Segmented track label={label} value={st.confMode as "append" | "replace"}
        options={[{ id: "append", label: "Append" }, { id: "replace", label: "Replace" }]}
        onChange={(v) => void save(() => api.tmuxConfSave(v, st.override), () => api.tmuxConfSave(old, st.override))} />);
    }
    case "override": {
      const old = st.override;
      return <OverrideRow label={label} help={help} tag={tag} value={old} note={alert}
        onSave={(v) => void save(() => api.tmuxConfSave(st.confMode, v), () => api.tmuxConfSave(st.confMode, old))} />;
    }
    case "runsOn": {
      const old = st.terminal || "engine";
      return row(<Segmented track label={label} value={old as "engine" | "desk"}
        options={[{ id: "engine", label: "Pane engine" }, { id: "desk", label: "My own tmux" }]}
        onChange={(v) => void save(() => api.tmuxSettingsSave({ terminal: v }), () => api.tmuxSettingsSave({ terminal: old }))} />,
        { agentNever: "which tmux a shell runs in, held by the server: it changes what runs a shell, so the owner chooses it" });
    }
  }
}

/** Multi-line tmux lines, committed on blur (Escape cancels); tmux checks them before they apply. */
function OverrideRow({ label, help, tag, value, onSave, note }: { label: string; help: string; tag: React.ReactNode; value: string; onSave: (v: string) => void; note: React.ReactNode }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <SettingRow kind="control" label={label} help={help} tag={tag} control={
      <div className="flex flex-col items-end gap-1">
        {note}
        {editing ? (
          <textarea aria-label={label} value={draft} rows={Math.min(8, Math.max(4, draft.split("\n").length))} spellCheck={false} autoFocus onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { setEditing(false); if (draft !== value) onSave(draft); }}
            onKeyDown={(e) => { if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
            placeholder={"# set -g mouse on"} className={`t-mono w-[320px] ${INPUT}`} style={{ ...INPUT_STYLE, height: "auto", resize: "vertical", maxHeight: "12.5em" }} />
        ) : (
          <pre data-tmux-code aria-label={label} className="t-mono w-[320px] m-0 px-2 py-1.5 rounded text-[11px] overflow-auto whitespace-pre" style={{ background: "var(--bg3)", color: draft ? "var(--text)" : "var(--text2)", maxHeight: "8.5em", resize: "vertical" }}>{draft || "# set -g mouse on"}</pre>
        )}
        {!editing && <button type="button" onClick={() => setEditing(true)} className="text-[12px] underline" style={{ color: "var(--accent)" }}>Edit</button>}
      </div>} />
  );
}
