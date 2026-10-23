// What the finder's file operations draw: the right-click menu (Strata's, from
// lib/finderOps.menuFor), the prompt that asks for a name, and the confirmation
// that comes before a permanent delete. Nothing here decides anything: the
// model is lib/finderOps.ts, the doing is the server's (/fs/op).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Portal } from "../../Portal.tsx";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { LAYER } from "../../../lib/layers.ts";
import { nameProblem, stemEnd, type Item, type OpId } from "../../../lib/finderOps.ts";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { StrataIcon } from "./StrataIcon.tsx";

/** Strata's icon for each item (its file menu reference, shot 42). */
const ICON_OF: Record<OpId, string> = {
  "folder-with": "folder-plus", open: "external-link", "open-with": "app-window", preview: "eye", print: "printer", terminal: "terminal", "open-in": "external-link",
  cut: "scissors", copy: "copy", duplicate: "copy-plus", rename: "pencil", "move-to": "folder-input", "copy-to": "folder-output", compress: "package-plus",
  pin: "pin", customize: "palette", "copy-path": "route", "copy-name": "file-type", props: "info", trash: "trash", delete: "circle-x",
  "new-folder": "folder-plus", "new-file": "file-plus", paste: "clipboard-paste", "select-all": "list-checks", refresh: "refresh", hidden: "eye-off",
};

export function ContextMenu({ at, head, groups, onPick, onClose }: {
  at: { x: number; y: number }; head: { title: string; sub: string } | null; groups: Item[][]; onPick: (i: Item) => void; onClose: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Opens at the pointer and is pulled back inside the window, so a click near an edge opens inward.
  // Placed again whenever the menu changes size: the icons arrive after the first measure, and a menu measured short hangs off the bottom.
  useLayoutEffect(() => {
    const place = () => {
      const w = el.current?.offsetWidth ?? 300, h = el.current?.offsetHeight ?? 0;
      setPos({ left: Math.max(8, Math.min(at.x, window.innerWidth - w - 8)), top: Math.max(8, Math.min(at.y, window.innerHeight - h - 8)) });
    };
    place();
    const ro = typeof ResizeObserver === "function" && el.current ? new ResizeObserver(place) : null;
    if (ro && el.current) ro.observe(el.current);
    return () => ro?.disconnect();
  }, [at]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [onClose]);
  return (
    <Portal z={LAYER.menu}>
      <div className="fixed inset-0" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={el} role="menu" aria-label="File menu" className="fixed rounded-lg text-[12px] shadow-2xl py-1.5"
        style={{ width: 310, left: pos?.left ?? -9999, top: pos?.top ?? -9999, background: "var(--surface-card)", border: EDGE, color: "var(--text)", maxHeight: "calc(100vh - 16px)", overflowY: "auto" }}>
        {head && (
          <div className="px-3.5 pt-1.5 pb-2" style={{ borderBottom: LINE }}>
            <div className="truncate" style={{ color: "var(--primary-ink)", fontWeight: 600 }}>{head.title}</div>
            <div className="truncate text-[11px]" style={{ color: "var(--text3)" }} title={head.sub}>{head.sub}</div>
          </div>
        )}
        {groups.map((g, gi) => (
          <div key={gi} className="py-1" style={gi > 0 ? { borderTop: LINE } : undefined}>
            {g.map((i) => (
              <button key={i.id} role="menuitem" disabled={i.disabled} title={i.later ? `${i.later} is not built yet` : undefined} onClick={() => { onPick(i); }}
                className="agx-btn w-full flex items-center gap-2.5 px-3.5 text-left disabled:opacity-40" style={{ minHeight: 28, color: i.danger ? "var(--error-ink)" : "var(--text)" }}>
                <span className="shrink-0 flex" style={{ color: i.danger ? "var(--error-ink)" : "var(--primary-ink)" }}><StrataIcon set="act" name={ICON_OF[i.id]} size={ICON.sm} /></span>
                <span className="flex-1 min-w-0 truncate">{i.label}</span>
                {i.keys && <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>{i.keys}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </Portal>
  );
}

/** A box laid over the finder, as the unsaved-changes one is: inside the finder's own root, so it is never clipped or lost behind the palette. */
export function Sheet({ label, children, onClose, width = 380 }: { label: string; children: React.ReactNode; onClose: () => void; width?: number }) {
  // Escape closes it wherever the focus is: a box that opened without taking the focus must not be left standing.
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [onClose]);
  return (
    <div role="dialog" aria-label={label} aria-modal="true" className="absolute inset-0 grid place-items-center p-4" style={{ background: "color-mix(in srgb, var(--bg) 70%, transparent)", zIndex: 9, gridTemplateColumns: "minmax(0, 1fr)" }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onClose(); }}>
      <div className="rounded-xl p-4 text-[12px]" style={{ background: "var(--surface-card)", border: EDGE, width, maxWidth: "100%" }}>{children}</div>
    </div>
  );
}

/** A name typed in the row it belongs to: a rename (`was` is the name) or a new folder or file (`was` is null, the row is added on top). */
export interface InlineEdit {
  dir: string; was: string | null; isDir: boolean; initial: string; taken: readonly string[];
  run: (name: string) => void; end: () => void;
}

/** Strata's in-place editor: the stem is selected, Enter keeps it, Escape or a click elsewhere drops it. The server's name rule is said under the field. */
export function InlineName({ edit, rowH, icon }: { edit: InlineEdit; rowH: number; icon: React.ReactNode }) {
  const [v, setV] = useState(edit.initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { const i = input.current; if (i) { i.focus(); i.setSelectionRange(0, edit.isDir ? edit.initial.length : stemEnd(edit.initial)); } }, [edit.initial, edit.isDir]);
  const problem = v === edit.initial && edit.was !== null ? null : nameProblem(v, edit.taken, edit.was ?? undefined);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    const n = v.trim();
    if (keep && n !== edit.was && !nameProblem(n, edit.taken, edit.was ?? undefined)) { edit.end(); edit.run(n); } else edit.end();
  };
  const inRow = edit.was !== null;
  return (
    <div className={inRow ? "flex-1 min-w-0 relative" : "flex items-center gap-2 px-2.5 mx-1 rounded-md relative"} style={inRow ? undefined : { height: rowH, background: "color-mix(in srgb, var(--primary) 16%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--primary) 38%, transparent)" }}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      {!inRow && <span className="shrink-0 flex">{icon}</span>}
      <input ref={input} value={v} onChange={(e) => setV(e.target.value)} spellCheck={false} aria-label={edit.was ? `Rename ${edit.was}` : "New name"} aria-invalid={!!problem}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); if (!problem) finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } }}
        onBlur={() => finish(!problem)} className={`${inRow ? "w-full" : "flex-1"} min-w-0 bg-transparent outline-none text-[12px]`} style={{ color: "var(--text)", height: rowH - 4, boxShadow: inRow ? "0 0 0 1px var(--primary)" : undefined, borderRadius: 4 }} />
      {problem && <span role="alert" className="absolute left-2 right-2 rounded-md px-2 py-1 text-[11px] truncate" style={{ top: rowH + 2, background: "var(--surface-card)", border: EDGE, color: "var(--error-ink)", zIndex: 4 }}>{problem}</span>}
    </div>
  );
}

/** The question before something that cannot be taken back: what goes, how many, and the word on the button. */
export function ConfirmDialog({ title, body, confirm, onConfirm, onClose }: { title: string; body: string; confirm: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet label={title} onClose={onClose}>
      <b className="block text-[13px] mb-1">{title}</b>
      <p className="m-0 mb-3" style={{ color: "var(--text3)" }}>{body}</p>
      <div className="flex justify-end gap-2">
        <button autoFocus className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={onClose}>Cancel</button>
        <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE, color: "var(--error-ink)" }} onClick={onConfirm}>{confirm}</button>
      </div>
    </Sheet>
  );
}
