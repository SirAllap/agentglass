// The Ctrl+K overlay: Strata's global search, over Home.
//
// Names are fuzzy and come from the server's incremental index; Contents is the
// existing text search. The overlay holds its own focus and its own keys, so
// the finder behind it does not move while somebody types.
import { useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { hitTarget, emptyText, stepHot, whereText, type HitTarget, type SearchHit } from "../../../lib/finderSearch.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { FolderIcon, FileIcon, SearchIcon } from "../../../lib/glyphIcons.tsx";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { MenuCap, MenuItem, Popover } from "./Popover.tsx";
import { StrataIcon } from "./StrataIcon.tsx";

interface Row extends SearchHit { text?: string; line?: number }

export function FinderSearch({ home, onTarget, onClose }: { home: string; onTarget: (t: HitTarget) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [contents, setContents] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [hot, setHot] = useState(0);
  const [status, setStatus] = useState<"idle" | "building" | "ready">("idle");
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    if (!q.trim() || (contents && q.trim().length < 2)) { setRows([]); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      const base = home.replace(/\/+$/, "");
      const ask = contents
        ? api.diskGrep(home, q.trim()).then((r) => { setStatus("ready"); return r.ok ? r.hits.map((h): Row => ({ path: `${base}/${h.rel}`, dir: false, text: h.text.trim(), line: h.line })) : []; })
        : api.diskIndexSearch(q.trim(), ctl.signal).then((r) => { setStatus(r.building ? "building" : "ready"); return r.ok ? r.hits.map((h): Row => ({ path: h.path, dir: h.dir })) : []; });
      void ask.then((r) => { if (!ctl.signal.aborted) { setRows(r); setHot(0); } }).catch(() => { /* a cancelled ask answers nothing */ });
    }, 60);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, contents, home]);

  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [hot, rows]);

  const choose = (i: number, alt: boolean) => { const r = rows[i]; if (r) { onTarget(hitTarget(r, alt)); onClose(); } };
  const note = emptyText(q, status, rows.length);

  return (
    <div role="dialog" aria-label="Search" className="absolute inset-0 flex justify-center items-start p-4" style={{ zIndex: 9, background: "color-mix(in srgb, var(--bg) 55%, transparent)", backdropFilter: "blur(3px)" }} onMouseDown={onClose}>
      <div className="flex flex-col rounded-xl overflow-hidden w-full min-h-0" style={{ maxWidth: 640, maxHeight: "min(70%, 560px)", marginTop: "8%", background: "var(--surface-card)", border: EDGE, boxShadow: "0 24px 60px -20px #000" }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-3.5 shrink-0" style={{ minHeight: 44, borderBottom: LINE }}>
          <span className="flex" style={{ color: "var(--text3)" }}><SearchIcon size={ICON.sm} /></span>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Search files and folders"
            placeholder={contents ? "Search inside files…" : "Search files and folders…"} className="flex-1 min-w-0 bg-transparent outline-none text-[13px]" style={{ color: "var(--text)" }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => stepHot(h, 1, rows.length)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => stepHot(h, -1, rows.length)); }
              else if (e.key === "Enter") { e.preventDefault(); choose(hot, e.altKey); }
              else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); onClose(); }
            }} />
          <button type="button" className="agx-btn rounded-md grid place-items-center shrink-0" style={{ width: 26, height: 26, color: contents ? "var(--primary-ink)" : "var(--text3)" }} title="Search settings" aria-label="Search settings" aria-haspopup="menu"
            onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}><StrataIcon set="act" name="sliders-horizontal" size={ICON.sm} /></button>
        </div>
        <div ref={list} role="listbox" aria-label="Results" className="agx-scroll flex-1 min-h-0 overflow-y-auto" style={{ minHeight: 200 }}>
          {note ? <div className="h-full grid place-items-center text-[12px] p-6 text-center" style={{ color: "var(--text3)", minHeight: 200 }}>{note}</div> : rows.map((r, i) => (
            <div key={`${r.path}:${r.line ?? ""}`} role="option" aria-selected={i === hot} onMouseMove={() => setHot(i)} onClick={() => choose(i, false)}
              className="flex items-center gap-2.5 px-3.5 cursor-pointer" style={{ minHeight: 34, background: i === hot ? "color-mix(in srgb, var(--primary) 14%, transparent)" : undefined }}>
              <span className="shrink-0 flex" style={{ color: "var(--text3)" }}>{r.dir ? <FolderIcon size={ICON.sm} /> : <FileIcon size={ICON.sm} />}</span>
              <span className="min-w-0 flex-1 flex flex-col py-1">
                <span className="truncate text-[12.5px]" style={{ fontWeight: 500 }}>{r.path.slice(r.path.lastIndexOf("/") + 1)}{r.line ? <span style={{ color: "var(--text4)", fontWeight: 400 }}> : {r.line}</span> : null}</span>
                <span className="truncate text-[10.5px]" style={{ color: "var(--text3)" }}>{r.text ?? whereText(r.path, home)}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 px-3.5 shrink-0 text-[10.5px]" style={{ minHeight: 30, borderTop: LINE, color: "var(--text3)" }}>
          <span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>Alt</kbd>+<kbd>↵</kbd> open containing folder</span>
        </div>
      </div>
      {menu && (
        <Popover anchor={menu} onClose={() => { setMenu(null); input.current?.focus(); }} width={240} label="Search settings">
          <MenuCap>Search in</MenuCap>
          <MenuItem on={!contents} onClick={() => { setContents(false); setMenu(null); input.current?.focus(); }}>File and folder names</MenuItem>
          <MenuItem on={contents} onClick={() => { setContents(true); setMenu(null); input.current?.focus(); }}>Inside files (Contents)</MenuItem>
        </Popover>
      )}
    </div>
  );
}
