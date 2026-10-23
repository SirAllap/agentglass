// Where you are, as a path you can click or type.
//
// Breadcrumbs when it is a label; a text field with folder completion when it
// is clicked, because the path that matters is usually one that is faster to
// type than to click to. Completion asks the server for the typed folder's
// subfolders, so it offers what is really there and nothing it had to guess.
import { useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { COMPLETE_PAGE, completePath, stepPick, tabComplete, crumbFades, crumbLabel, crumbs, hierarchy, isFolder } from "../../../lib/finderMiller.ts";
import { MenuItem, Popover } from "./Popover.tsx";
import { EDGE, INPUT, INPUT_STYLE, LINE } from "../../workspace/Chrome.tsx";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { StrataIcon } from "./StrataIcon.tsx";
import type { Volume } from "../../../../../shared/types.ts";
import { activates } from "../../../lib/finderPointer.ts";
import { isRemoteAddress, remoteView } from "../../../lib/finderRemote.ts";

/** Strata shows where a completion lives as the tail of its parent, cut from the left: "…a/scratchpad/tree". */
export function parentHint(dir: string, keep = 20): string {
  const d = dir.replace(/\/+$/, "");
  return d.length <= keep ? d : `…${d.slice(d.length - keep)}`;
}

/** What "Copy path" puts on the clipboard: the address under a remote, the path anywhere else. */
export function pathToCopy(path: string, remote: { uri: string } | null): string {
  return remote ? remote.uri : path;
}

export function FinderPathBar({ path, home, onGo, signalEdit, onEditing, volumes = [], onRemote, onFail }: { path: string; home: string; onGo: (path: string) => void; signalEdit: number; onEditing?: (on: boolean) => void; volumes?: readonly Volume[]; onRemote?: (address: string) => void; onFail?: (message: string) => void }) {
  /** A folder of a mounted remote is shown and edited as its address, as Strata does. */
  const remote = remoteView(path, volumes);
  const [text, setText] = useState<string | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [dir, setDir] = useState<string | null>(null);
  const [hot, setHot] = useState(0);
  /** The selection was moved by a key: Tab completes it, where an untouched one is only the first. */
  const [moved, setMoved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  /** The hierarchy menu: open at the pointer, as Strata's is. */
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const copy = () => {
    void navigator.clipboard.writeText(pathToCopy(path, remote)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => { /* a browser that refuses the clipboard has nothing to say about it */ });
  };
  const seen = useRef(signalEdit);
  const strip = useRef<HTMLDivElement>(null);
  const [fades, setFades] = useState({ left: false, right: false });
  const measureFades = () => { const el = strip.current; if (el) { const f = crumbFades(el.scrollLeft, el.clientWidth, el.scrollWidth); setFades((o) => (o.left === f.left && o.right === f.right ? o : f)); } };
  // A new place rests at its end, where the folder you are in is; a resize keeps the fades honest.
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    measureFades();
    const ro = new ResizeObserver(() => { el.scrollLeft = el.scrollWidth; measureFades(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [path, text === null]);

  useEffect(() => { onEditing?.(text !== null); }, [text !== null]);
  const edit = () => { const shownPath = remote ? remote.uri : path; setText(shownPath.endsWith("/") ? shownPath : `${shownPath}/`); setTimeout(() => input.current?.select(), 0); };
  // Ctrl+L (the finder's own key) asks for the field from outside.
  useEffect(() => { if (signalEdit !== seen.current) { seen.current = signalEdit; edit(); } }, [signalEdit]);

  // Which folder is typed, and what is in it. The bar asks only when the folder part changes, not on every keystroke after it.
  const asked = text === null || isRemoteAddress(text) ? null : completePath(text, home, []).dir;
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

  const shown = text !== null && dir === asked && asked ? completePath(text, home, picks).picks.slice(0, 50) : [];
  useEffect(() => { setHot(0); setMoved(false); }, [text]);

  const commit = (value: string) => {
    const v = value.trim();
    const full = v === "~" ? home : v.startsWith("~/") ? `${home.replace(/\/+$/, "")}/${v.slice(2)}` : v;
    setText(null);
    if (isRemoteAddress(v)) { onRemote?.(v); return; }
    if (!full.startsWith("/")) { onFail?.(`"${v}" is not a path or an address.`); return; }
    const to = full.length > 1 ? full.replace(/\/+$/, "") : full;
    // Strata checks the folder before it goes there and says why it cannot, instead of showing an empty place.
    void api.browseList(to, 0, false, undefined, 1)
      .then((p) => { if (p.ok) onGo(to); else onFail?.(p.error || `Cannot open ${to}.`); })
      .catch(() => onFail?.(`Cannot open ${to}.`));
  };
  const fill = (name: string) => { if (text !== null) setText(`${text.slice(0, text.lastIndexOf("/") + 1)}${name}`); };

  if (text !== null) {
    return (
      <div className="relative flex-1 min-w-0 flex items-center gap-1">
        <input ref={input} autoFocus value={text} placeholder="Enter a path or URI…" spellCheck={false} aria-label="Path" aria-autocomplete="list" aria-expanded={shown.length > 0}
          onChange={(e) => setText(e.target.value)} onBlur={() => setTimeout(() => setText(null), 120)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); setText(null); }
            else if (e.key === "Enter") { e.preventDefault(); commit(shown.length ? `${text.slice(0, text.lastIndexOf("/") + 1)}${shown[hot]}` : text); }
            else if (e.key === "Tab") { e.preventDefault(); const r = tabComplete(text.slice(text.lastIndexOf("/") + 1), shown, hot, moved); if (r.fill !== null) fill(r.fill); else { setHot(r.hot); setMoved(true); } }
            else if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) { /* Strata ignores the selection keys with a modifier */ }
            else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "PageDown" || e.key === "PageUp") {
              e.preventDefault();
              const by = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "PageDown" ? COMPLETE_PAGE : -COMPLETE_PAGE;
              setHot((h) => stepPick(h, shown.length, by)); setMoved(true);
            }
          }}
          className={`${INPUT} flex-1 min-w-0`} style={{ ...INPUT_STYLE, borderColor: "var(--primary)" }} />
        <button className="agx-btn rounded grid place-items-center shrink-0" style={{ width: HIT, height: HIT, color: "var(--text3)" }} title="Go (Enter)" aria-label="Go to this path" onMouseDown={(e) => { e.preventDefault(); commit(text); }}><StrataIcon set="act" name="check" size={ICON.sm} /></button>
        <button className="agx-btn rounded grid place-items-center shrink-0" style={{ width: HIT, height: HIT, color: "var(--text3)" }} title="Cancel (Esc)" aria-label="Cancel editing the path" onMouseDown={(e) => { e.preventDefault(); setText(null); }}><StrataIcon set="act" name="x" size={ICON.sm} /></button>
        {shown.length > 0 && (
          <div role="listbox" aria-label="Folders" className="absolute left-0 right-0 rounded-lg py-1 text-[12px] shadow-2xl" style={{ top: 34, zIndex: 5, background: "var(--surface-card)", border: EDGE }}>
            {shown.map((n, i) => (
              <div key={n} role="option" aria-selected={i === hot} onMouseDown={(e) => { e.preventDefault(); fill(`${n}/`); }}
                className="px-3 flex items-center gap-2.5 cursor-pointer" style={{ minHeight: 34, background: i === hot ? "color-mix(in srgb, var(--primary) 14%, transparent)" : undefined }}>
                <StrataIcon set="act" name="folder" size={ICON.sm} />
                <span className="truncate flex-1 min-w-0">{n}/</span>
                <span className="shrink-0 text-[11px]" style={{ color: "var(--text3)" }}>{parentHint(dir ?? "")}</span>
              </div>
            ))}
            <div className="px-3 pt-2 pb-1 mt-1 flex gap-4 text-[11px]" style={{ borderTop: LINE, color: "var(--text3)" }}>
              <span><b style={{ color: "var(--text2)" }}>Tab</b> Complete</span><span><b style={{ color: "var(--text2)" }}>↑ / ↓</b> Choose</span><span><b style={{ color: "var(--text2)" }}>Enter</b> Open</span><span><b style={{ color: "var(--text2)" }}>Esc</b> Cancel</span>
            </div>
          </div>
        )}
      </div>
    );
  }
  // Under a remote the first crumb is the address of the mount and the rest are its folders.
  const parts: { label: string; path: string }[] = remote
    ? [{ label: remote.root, path: remote.mountPoint }, ...path.slice(remote.mountPoint.length).split("/").filter(Boolean).map((seg, i, all) => ({ label: seg, path: `${remote.mountPoint}/${all.slice(0, i + 1).join("/")}` }))]
    : crumbs(path, home);
  // Strata draws the path bare: segments separated by a slash, the last one in the accent. A crumb is never squeezed to fit: the bar scrolls, rests at the end, and fades the side that has more path.
  return (
    <div className="relative flex-1 min-w-0 flex">
    {/* In the flow, not over the crumbs: a fade drawn over the strip dimmed the first letters of the last crumb whenever it rested at the left edge (measured at 360 px: 3 px under it). */}
    {fades.left && <span aria-hidden data-crumb-more className="shrink-0 grid place-items-center pointer-events-none" style={{ width: 16, color: "var(--text4)" }}>…</span>}
    <div ref={strip} className="flex-1 min-w-0 flex items-center gap-1 px-2 overflow-x-auto cursor-text whitespace-nowrap" role="navigation" aria-label="Path" onScroll={measureFades} onWheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}
      onClick={(e) => { if (activates(e.button, "click")) edit(); }} style={{ minHeight: 30, scrollbarWidth: "none" }} title="Click to type a path (Ctrl+L)"
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu(new DOMRect(e.clientX, e.clientY, 1, 1)); }}>
      {parts.map((c, i) => (
        <span key={c.path} className="flex items-center gap-1 shrink-0">
          {i > 0 && <span aria-hidden className="px-1.5" style={{ color: "var(--text4)" }}>/</span>}
          <button className="agx-btn rounded px-1 shrink-0" title={crumbLabel(c.label) !== c.label ? c.label : undefined} data-drop-path={i < parts.length - 1 ? c.path : undefined} data-drop-kind="crumb" style={{ color: i === parts.length - 1 ? "var(--primary-ink)" : "var(--text3)", fontWeight: i === parts.length - 1 ? 700 : 400 }}
            onClick={(e) => { e.stopPropagation(); if (!activates(e.button, "click")) return; if (i === parts.length - 1) edit(); else onGo(c.path); }}>{crumbLabel(c.label)}</button>
        </span>
      ))}
      <button type="button" className="agx-btn rounded grid place-items-center shrink-0" style={{ width: HIT, height: HIT, color: copied ? "var(--primary-ink)" : "var(--text3)" }} title={copied ? "Path copied" : "Copy path"} aria-label="Copy path"
        onClick={(e) => { e.stopPropagation(); copy(); }}><StrataIcon set="act" name={copied ? "check" : "copy"} size={ICON.sm} /></button>
      {/* Inside the bar in the DOM: a click on the menu must not reach the bar and start typing. */}
      {menu && (
        <span onClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
        <Popover anchor={menu} onClose={() => setMenu(null)} width={200} label="Path hierarchy">
          {hierarchy(parts).map((h) => (
            <MenuItem key={h.path} icon={h.icon} on={h.current} onClick={() => { setMenu(null); if (!h.current) onGo(h.path); }}>{h.label}</MenuItem>
          ))}
        </Popover>
        </span>
      )}
    </div>
    {fades.right && <span aria-hidden className="absolute right-0 top-0 bottom-0 pointer-events-none" style={{ width: 24, background: "linear-gradient(to left, var(--surface-card), transparent)" }} />}
    </div>
  );
}
