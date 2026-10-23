// Where you are, as a path you can click or type.
//
// Breadcrumbs when it is a label; a text field with folder completion when it
// is clicked, because the path that matters is usually one that is faster to
// type than to click to. Completion asks the server for the typed folder's
// subfolders, so it offers what is really there and nothing it had to guess.
import { useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { completePath, crumbs, isFolder } from "../../../lib/finderMiller.ts";
import { EDGE, INPUT, INPUT_STYLE, LINE } from "../../workspace/Chrome.tsx";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { StrataIcon } from "./StrataIcon.tsx";

/** Strata shows where a completion lives as the tail of its parent, cut from the left: "…a/scratchpad/tree". */
export function parentHint(dir: string, keep = 20): string {
  const d = dir.replace(/\/+$/, "");
  return d.length <= keep ? d : `…${d.slice(d.length - keep)}`;
}

export function FinderPathBar({ path, home, onGo, signalEdit, onEditing }: { path: string; home: string; onGo: (path: string) => void; signalEdit: number; onEditing?: (on: boolean) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [dir, setDir] = useState<string | null>(null);
  const [hot, setHot] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const seen = useRef(signalEdit);

  useEffect(() => { onEditing?.(text !== null); }, [text !== null]);
  const edit = () => { setText(path.endsWith("/") ? path : `${path}/`); setTimeout(() => input.current?.select(), 0); };
  // Ctrl+L (the finder's own key) asks for the field from outside.
  useEffect(() => { if (signalEdit !== seen.current) { seen.current = signalEdit; edit(); } }, [signalEdit]);

  // Which folder is typed, and what is in it. The bar asks only when the folder part changes, not on every keystroke after it.
  const asked = text === null ? null : completePath(text, home, []).dir;
  useEffect(() => {
    if (!asked) { setPicks([]); setDir(null); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      void api.browseList(asked, 0, text!.slice(text!.lastIndexOf("/") + 1).startsWith("."), ctl.signal, 512)
        .then((p) => { if (!ctl.signal.aborted) { setDir(asked); setPicks(p.ok ? p.entries.filter(isFolder).map((e) => e.name).sort((a, b) => a.localeCompare(b)) : []); } })
        .catch(() => { /* a cancelled or failed ask offers nothing */ });
    }, 80);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [asked]);

  const shown = text !== null && dir === asked && asked ? completePath(text, home, picks).picks.slice(0, 8) : [];
  useEffect(() => setHot(0), [text]);

  const commit = (value: string) => {
    const v = value.trim();
    const full = v === "~" ? home : v.startsWith("~/") ? `${home.replace(/\/+$/, "")}/${v.slice(2)}` : v;
    setText(null);
    if (full.startsWith("/")) onGo(full.length > 1 ? full.replace(/\/+$/, "") : full);
  };
  const fill = (name: string) => { if (text !== null) setText(`${text.slice(0, text.lastIndexOf("/") + 1)}${name}/`); };

  if (text !== null) {
    return (
      <div className="relative flex-1 min-w-0 flex items-center gap-1">
        <input ref={input} autoFocus value={text} spellCheck={false} aria-label="Path" aria-autocomplete="list" aria-expanded={shown.length > 0}
          onChange={(e) => setText(e.target.value)} onBlur={() => setTimeout(() => setText(null), 120)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); setText(null); }
            else if (e.key === "Enter") { e.preventDefault(); commit(shown.length && hot > 0 ? `${text.slice(0, text.lastIndexOf("/") + 1)}${shown[hot]}` : text); }
            else if (e.key === "Tab") { e.preventDefault(); if (shown[hot]) fill(shown[hot]!); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => Math.min(shown.length - 1, h + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => Math.max(0, h - 1)); }
          }}
          className={`${INPUT} flex-1 min-w-0`} style={{ ...INPUT_STYLE, borderColor: "var(--primary)" }} />
        <button className="agx-btn rounded grid place-items-center shrink-0" style={{ width: HIT, height: HIT, color: "var(--text3)" }} title="Go (Enter)" aria-label="Go to this path" onMouseDown={(e) => { e.preventDefault(); commit(text); }}><StrataIcon set="act" name="check" size={ICON.sm} /></button>
        <button className="agx-btn rounded grid place-items-center shrink-0" style={{ width: HIT, height: HIT, color: "var(--text3)" }} title="Cancel (Esc)" aria-label="Cancel editing the path" onMouseDown={(e) => { e.preventDefault(); setText(null); }}><StrataIcon set="act" name="x" size={ICON.sm} /></button>
        {shown.length > 0 && (
          <div role="listbox" aria-label="Folders" className="absolute left-0 right-0 rounded-lg py-1 text-[12px] shadow-2xl" style={{ top: 34, zIndex: 5, background: "var(--surface-card)", border: EDGE }}>
            {shown.map((n, i) => (
              <div key={n} role="option" aria-selected={i === hot} onMouseDown={(e) => { e.preventDefault(); fill(n); }}
                className="px-3 flex items-center gap-2.5 cursor-pointer" style={{ minHeight: 34, background: i === hot ? "color-mix(in srgb, var(--primary) 14%, transparent)" : undefined }}>
                <StrataIcon set="act" name="folder" size={ICON.sm} />
                <span className="truncate flex-1 min-w-0">{n}/</span>
                <span className="shrink-0 text-[11px]" style={{ color: "var(--text3)" }}>{parentHint(dir ?? "")}</span>
              </div>
            ))}
            <div className="px-3 pt-2 pb-1 mt-1 flex gap-4 text-[11px]" style={{ borderTop: LINE, color: "var(--text3)" }}>
              <span><b style={{ color: "var(--text2)" }}>Tab</b> Complete</span><span><b style={{ color: "var(--text2)" }}>↑ / ↓</b> Choose</span><span><b style={{ color: "var(--text2)" }}>Enter</b> Open</span>
            </div>
          </div>
        )}
      </div>
    );
  }
  const parts = crumbs(path, home);
  // Strata draws the path bare: segments separated by a slash, the last one in the accent.
  return (
    <div className="flex-1 min-w-0 flex items-center gap-1 px-2 overflow-hidden cursor-text whitespace-nowrap" role="navigation" aria-label="Path"
      onClick={edit} style={{ minHeight: 30 }} title="Click to type a path (Ctrl+L)">
      {parts.map((c, i) => (
        <span key={c.path} className="flex items-center gap-1 min-w-0">
          {i > 0 && <span aria-hidden style={{ color: "var(--text4)" }}>/</span>}
          <button className="agx-btn rounded px-1 truncate" style={{ color: i === parts.length - 1 ? "var(--primary-ink)" : "var(--text3)" }}
            onClick={(e) => { e.stopPropagation(); onGo(c.path); }}>{c.label}</button>
        </span>
      ))}
    </div>
  );
}
