// The preview's Editing tab: the file in a text box, saved in place.
//
// A plain textarea, because nothing in the repo is an editor and a dependency
// for one box is not worth it: the browser gives undo (Ctrl+Z), selection and
// IME for free. What it cannot give is the rules, and those live in
// lib/finderEdit.ts (what may be edited, line endings, when closing asks) and in
// the server's saveText (boundary, mtime guard, cap). An edit that is not saved
// stays as a draft for the file, so moving to another row loses nothing; closing
// with drafts open asks first (MachineFinder).
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { clearDraft, exitDecision, fromEditor, getDraft, setDraft, toEditor } from "../../../lib/finderEdit.ts";
import { humanBytes } from "../../../lib/paletteModel.ts";
import { HIT } from "../../../lib/iconSize.ts";
import type { FileFacts } from "../../../../../shared/types.ts";
import { EDGE } from "../../workspace/Chrome.tsx";
import { CODE_FONT_STYLE } from "../../diff/DiffLines.tsx";

type Note = { kind: "ok" | "warn"; text: string; reload?: boolean } | null;

export function FileEditor({ path, facts, onDone }: { path: string; facts: FileFacts; onDone: () => void }) {
  const start = useMemo(() => {
    const d = getDraft(path);
    if (d) return { text: d.text, saved: d.saved, eol: d.eol, mtime: d.mtime };
    const e = toEditor(facts.text ?? "");
    return { text: e.text, saved: e.text, eol: e.eol, mtime: facts.mtime };
  }, [path, facts.mtime, facts.text]);
  const [text, setText] = useState(start.text);
  const [saved, setSaved] = useState(start.saved);
  const eol = useRef(start.eol);
  const mtime = useRef(start.mtime);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== saved;

  useEffect(() => { setDraft(path, { text, saved, eol: eol.current, mtime: mtime.current }); }, [path, text, saved]);
  useEffect(() => { box.current?.focus(); }, [path]);
  /* The window asks before it is closed or reloaded with an edit open. */
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = async (): Promise<boolean> => {
    if (busy || !dirty) return !busy;
    setBusy(true); setNote(null);
    try {
      const r = await api.previewSave(path, fromEditor(text, eol.current), mtime.current);
      if (r.ok && typeof r.mtime === "number") { mtime.current = r.mtime; setSaved(text); clearDraft(path); setNote({ kind: "ok", text: `Saved · ${humanBytes(r.bytes ?? 0)}` }); return true; }
      setNote({ kind: "warn", text: r.error ?? "The file could not be saved", reload: !!r.conflict }); return false;
    } catch { setNote({ kind: "warn", text: "The file could not be saved: the server did not answer" }); return false; }
    finally { setBusy(false); }
  };
  /* Take what is on disk now and drop the edit: the answer to a conflict. */
  const reload = async () => {
    const f = await api.previewFacts(path);
    if (!f.ok || typeof f.text !== "string") { setNote({ kind: "warn", text: f.error ?? "The file could not be read" }); return; }
    const e = toEditor(f.text);
    eol.current = e.eol; mtime.current = f.mtime; setText(e.text); setSaved(e.text); clearDraft(path); setNote({ kind: "ok", text: "Reloaded from disk" });
  };
  const done = () => { if (exitDecision(dirty ? 1 : 0, "done") === "ask") setAsking(true); else onDone(); };
  const discard = () => { clearDraft(path); setAsking(false); onDone(); };

  const btn = "agx-btn px-2.5 rounded-md text-[11px] disabled:opacity-40";
  return (
    <div className="flex flex-col min-w-0 flex-1 min-h-0" style={{ minHeight: 240 }}>
      <div className="flex items-center gap-1.5 pb-2 shrink-0 flex-wrap">
        <button className={btn} style={{ minHeight: HIT - 6, background: "var(--text)", color: "var(--bg)" }} disabled={!dirty || busy} onClick={() => void save()} title="Save (Ctrl+S)">{busy ? "Saving…" : "Save"}</button>
        <button className={btn} style={{ minHeight: HIT - 6, border: EDGE, color: "var(--text2)" }} disabled={!dirty} onClick={() => { setText(saved); setNote(null); }} title="Throw away the changes since the last save">Revert</button>
        <button className={btn} style={{ minHeight: HIT - 6, border: EDGE, color: "var(--text2)" }} onClick={done} title="Back to reading">Done</button>
        <span className="text-[11px]" role="status" aria-live="polite" style={{ color: "var(--warning-ink)" }}>{dirty ? "● Unsaved changes" : ""}</span>
      </div>
      {asking && (
        <div role="alertdialog" aria-label="Unsaved changes" className="flex items-center gap-2 flex-wrap mb-2 px-2.5 py-1.5 rounded-md text-[11.5px]" style={{ border: EDGE, background: "var(--surface-card)" }}>
          <span className="flex-1 min-w-0">Unsaved changes.</span>
          <button className={btn} style={{ minHeight: HIT - 6, border: EDGE }} onClick={() => setAsking(false)}>Cancel</button>
          <button className={btn} style={{ minHeight: HIT - 6, background: "var(--text)", color: "var(--bg)" }} onClick={() => void save().then((ok) => { if (ok) { setAsking(false); onDone(); } else setAsking(false); })}>Save</button>
          <button className={btn} style={{ minHeight: HIT - 6, border: EDGE, color: "var(--warning-ink)" }} onClick={discard}>Discard</button>
        </div>
      )}
      {note && (
        <p role={note.kind === "warn" ? "alert" : "status"} className="m-0 mb-2 text-[11px]" style={{ color: note.kind === "warn" ? "var(--warning-ink)" : "var(--text3)" }}>
          {note.text}{note.reload && <> <button className="agx-btn underline" onClick={() => void reload()}>Reload from disk</button> (drops this edit)</>}
        </p>
      )}
      <textarea ref={box} value={text} spellCheck={false} aria-label={`Edit ${facts.name}`} wrap="off"
        onChange={(e) => { setText(e.target.value); if (note?.kind === "ok") setNote(null); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
          else if (e.key === "Escape") { e.preventDefault(); done(); }
          else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey) {
            e.preventDefault();
            const t = e.currentTarget; const a = t.selectionStart; const b = t.selectionEnd;
            /* execCommand keeps the browser's undo stack; setting value would wipe it. */
            if (!document.execCommand("insertText", false, "\t")) { setText(text.slice(0, a) + "\t" + text.slice(b)); }
          }
        }}
        className="flex-1 min-h-0 w-full rounded-md p-2 text-[11.5px] leading-[1.55] resize-none agx-scroll"
        style={{ ...CODE_FONT_STYLE, border: EDGE, background: "var(--bg)", color: "var(--text)", tabSize: 4, whiteSpace: "pre", overflow: "auto" }} />
    </div>
  );
}
