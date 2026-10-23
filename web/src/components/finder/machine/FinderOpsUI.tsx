// What the finder's file operations draw: the right-click menu (Strata's, from
// lib/finderOps.menuFor), the prompt that asks for a name, and the confirmation
// that comes before a permanent delete. Nothing here decides anything: the
// model is lib/finderOps.ts, the doing is the server's (/fs/op).
import { isAppChord } from "../../../lib/finderKeys.ts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Portal } from "../../Portal.tsx";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { LAYER } from "../../../lib/layers.ts";
import { nameProblem, outsidePress, stemEnd, type Item, type OpId } from "../../../lib/finderOps.ts";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { StrataIcon } from "./StrataIcon.tsx";
import { MENU_EDGE, MENU_ROW, MENU_ROW_H, MENU_RULE } from "../../../lib/finderMenu.ts";
import { spatialNext, type Way } from "../../../lib/finderSpatial.ts";
import { useMenuKeys } from "./useMenuKeys.ts";
import { useDialogEscape } from "./useDialogEscape.ts";

/** Strata's icon for each item (its file menu reference, shot 42). */
const ICON_OF: Record<OpId, string> = {
  "folder-with": "folder-plus", open: "external-link", "open-with": "app-window", preview: "eye", print: "printer", terminal: "terminal", "open-in": "external-link",
  cut: "scissors", copy: "copy", duplicate: "copy-plus", rename: "pencil", "move-to": "folder-input", "copy-to": "folder-output", compress: "package-plus",
  pin: "pin", customize: "palette", "copy-path": "route", "copy-name": "file-type", props: "info", trash: "trash", delete: "circle-x",
  "new-folder": "folder-plus", "new-file": "file-plus", paste: "clipboard-paste", "select-all": "list-checks", refresh: "refresh", hidden: "eye-off",
  action: "play", actions: "play",
};

/** Where a submenu opens: to the right of its entry, or to the left when the window ends there, and pulled up so it does not hang off the bottom. */
export function subPlace(r: DOMRect, w: number, h: number): { left: number; top: number } {
  const right = r.right + 4, left = r.left - w - 4, room = window.innerWidth - MENU_EDGE;
  const down = Math.max(MENU_EDGE, Math.min(r.top - 6, window.innerHeight - h - MENU_EDGE));
  if (right + w <= room) return { left: right, top: down };
  if (left >= MENU_EDGE) return { left, top: down };
  // Neither side has room (a narrow window): it opens just below its own entry, so it never covers it.
  return { left: Math.max(MENU_EDGE, room - w), top: Math.max(MENU_EDGE, Math.min(r.bottom + 4, window.innerHeight - h - MENU_EDGE)) };
}

/** One right click while a menu is open closes it and asks the thing under the pointer for its own menu (Strata's popover does the same), so the person does not click twice. */
export function retarget(x: number, y: number): void {
  const under = document.elementsFromPoint(x, y).find((el) => !el.closest("[data-menu-backdrop], [role=menu]"));
  under?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2, view: window }));
}

export function ContextMenu({ at, head, groups, onPick, onClose }: {
  at: { x: number; y: number }; head: { title: string; sub: string } | null; groups: Item[][]; onPick: (i: Item) => void; onClose: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [sub, setSub] = useState<{ items: Item[]; rect: DOMRect } | null>(null);
  const subEl = useRef<HTMLDivElement>(null);
  const closeSub = useCallback(() => setSub(null), []);
  // The main list has the keys until a submenu is open; then the submenu has them and Left hands them back.
  useMenuKeys(el, { enabled: !sub, first: "fill" });
  useMenuKeys(subEl, { enabled: !!sub, onLeft: closeSub });
  // Opens at the pointer and is pulled back inside the window, so a click near an edge opens inward.
  // Placed again whenever the menu changes size: the icons arrive after the first measure, and a menu measured short hangs off the bottom.
  useLayoutEffect(() => {
    const place = () => {
      const w = el.current?.offsetWidth ?? 300, h = el.current?.offsetHeight ?? 0;
      setPos({ left: Math.max(MENU_EDGE, Math.min(at.x, window.innerWidth - w - MENU_EDGE)), top: Math.max(MENU_EDGE, Math.min(at.y, window.innerHeight - h - MENU_EDGE)) });
    };
    place();
    const ro = typeof ResizeObserver === "function" && el.current ? new ResizeObserver(place) : null;
    if (ro && el.current) ro.observe(el.current);
    return () => ro?.disconnect();
  }, [at]);
  useEffect(() => { el.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [onClose]);
  return (
    <Portal z={LAYER.menu}>
      <div data-menu-backdrop className="fixed inset-0" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); retarget(e.clientX, e.clientY); }} />
      <div ref={el} role="menu" data-finder-menu aria-label="File menu" tabIndex={-1} className="fixed rounded-lg text-[12px] shadow-2xl py-1.5 outline-none"
        style={{ width: 310, left: pos?.left ?? -9999, top: pos?.top ?? -9999, background: "var(--surface-card)", border: EDGE, color: "var(--text)", maxHeight: `calc(100vh - ${MENU_EDGE * 2}px)`, overflowY: "auto" }}>
        {head && (
          <div className="px-3.5 pt-1.5 pb-2">
            <div className="truncate" style={{ color: "var(--primary-ink)", fontWeight: 600 }}>{head.title}</div>
            <div className="truncate text-[11px]" style={{ color: "var(--text3)" }} title={head.sub}>{head.sub}</div>
          </div>
        )}
        {groups.map((g, gi) => (
          <div key={gi} className="py-1" style={gi > 0 ? { borderTop: MENU_RULE } : undefined}>
            {g.map((i) => (
              <button key={i.id + (i.action ?? "")} role="menuitem" aria-haspopup={i.sub ? "menu" : undefined} aria-expanded={i.sub ? sub?.items === i.sub : undefined} disabled={i.disabled} title={i.later ? `${i.later} is not built yet` : undefined}
                onMouseEnter={(e) => { if (i.sub) setSub({ items: i.sub, rect: e.currentTarget.getBoundingClientRect() }); else setSub(null); }}
                onClick={(e) => { if (i.sub) setSub({ items: i.sub, rect: e.currentTarget.getBoundingClientRect() }); else onPick(i); }}
                className={`${MENU_ROW} flex items-center gap-2.5 px-3 text-left disabled:opacity-40`} style={{ minHeight: MENU_ROW_H, color: i.danger ? "var(--error-ink)" : "var(--text)" }}>
                <span className="shrink-0 flex" style={{ color: i.danger ? "var(--error-ink)" : "var(--primary-ink)" }}><StrataIcon set="act" name={ICON_OF[i.id]} size={ICON.sm} /></span>
                <span className="flex-1 min-w-0 truncate">{i.label}</span>
                {i.keys && <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>{i.keys}</span>}
                {i.sub && <StrataIcon set="act" name="chevron-right" size={ICON.sm} />}
              </button>
            ))}
          </div>
        ))}
      </div>
      {sub && (
        <div ref={subEl} role="menu" data-finder-menu aria-label="Actions" className="fixed rounded-lg text-[12px] shadow-2xl py-1.5"
          style={{ width: 260, ...subPlace(sub.rect, 260, sub.items.length * (MENU_ROW_H + 1) + 12), background: "var(--surface-card)", border: EDGE, color: "var(--text)", maxHeight: `calc(100vh - ${MENU_EDGE * 2}px)`, overflowY: "auto" }}>
          {sub.items.map((i) => (
            <button key={i.action ?? i.id} role="menuitem" disabled={i.disabled} title={i.disabled ? i.label : undefined} onClick={() => onPick(i)}
              className={`${MENU_ROW} flex items-center gap-2.5 px-3 text-left disabled:opacity-40`} style={{ minHeight: MENU_ROW_H }}>
              <span className="shrink-0 flex" style={{ color: "var(--primary-ink)" }}><StrataIcon set="act" name="play" size={ICON.sm} /></span>
              <span className="flex-1 min-w-0 truncate">{i.label}</span>
            </button>
          ))}
        </div>
      )}
    </Portal>
  );
}

/** The modal layer's arrows (Strata's): from a button, ArrowLeft/Right/Up/Down focus the control that lies that way on screen. A text field keeps its own arrows. */
export function spatialKey(e: React.KeyboardEvent): boolean {
  const way = e.key as Way;
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(way) || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
  const from = (e.target as HTMLElement).closest("button");
  if (!from) return false;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled)")].filter((c) => c.getClientRects().length > 0);
  const at = all.indexOf(from);
  if (at < 0) return false;
  const to = spatialNext(all.map((c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }), at, way);
  e.preventDefault();
  if (to !== null) all[to]!.focus();
  return true;
}

/** A box laid over the finder, as the unsaved-changes one is: inside the finder's own root, so it is never clipped or lost behind the palette. */
export function Sheet({ label, children, onClose, width = 380 }: { label: string; children: React.ReactNode; onClose: () => void; width?: number }) {
  useDialogEscape(onClose);
  return (
    <div role="dialog" aria-label={label} aria-modal="true" className="absolute inset-0 grid place-items-center p-4" style={{ background: "color-mix(in srgb, var(--bg) 70%, transparent)", zIndex: 9, gridTemplateColumns: "minmax(0, 1fr)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && e.button === 0) onClose(); }}
      onKeyDown={(e) => { if (!isAppChord(e)) e.stopPropagation(); if (e.key === "Escape") onClose(); else spatialKey(e); }}>
      <div className="rounded-xl p-4 text-[12px]" style={{ background: "var(--surface-card)", border: EDGE, width, maxWidth: "100%" }}>{children}</div>
    </div>
  );
}

/** Strata's header on every dialog: a tinted tile with the icon, the title over a quieter line, and a close button on the right, over a rule. */
export function DialogHead({ icon, title, sub, onClose }: { icon: React.ReactNode; title: string; sub?: string; onClose: () => void }) {
  return (
    <div className="flex items-center gap-3 pb-3 mb-3" style={{ borderBottom: LINE }}>
      <span className="grid place-items-center rounded-lg shrink-0" style={{ width: 40, height: 40, background: "color-mix(in srgb, var(--primary) 22%, transparent)", color: "var(--primary-ink)" }}>{icon}</span>
      <div className="min-w-0 flex-1"><b className="block text-[13px] truncate" title={title}>{title}</b>{sub && <span className="block truncate text-[11px]" style={{ color: "var(--text3)" }}>{sub}</span>}</div>
      <button type="button" aria-label="Close" title="Close" className="agx-btn rounded-md grid place-items-center shrink-0" style={{ width: HIT - 6, height: HIT - 6, color: "var(--text3)" }} onClick={onClose}><StrataIcon set="act" name="x" size={ICON.sm} /></button>
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
  const box = useRef<HTMLDivElement>(null);
  // Outside the field: a press submits a rename and drops a new entry; scrolling the list drops either (Strata's editor). The wheel stands for scrolling: the editor's own scroll-into-view must not cancel it.
  useEffect(() => {
    const press = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) finish(outsidePress(inRow) === "submit" && !problem); };
    const wheel = () => finish(false);
    document.addEventListener("pointerdown", press, true);
    window.addEventListener("wheel", wheel, { capture: true, passive: true });
    return () => { document.removeEventListener("pointerdown", press, true); window.removeEventListener("wheel", wheel, true); };
  });
  return (
    <div ref={box} className={inRow ? "flex-1 min-w-0 relative" : "flex items-center gap-2 px-2.5 mx-1 rounded-md relative"} style={inRow ? undefined : { height: rowH, background: "color-mix(in srgb, var(--primary) 16%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--primary) 38%, transparent)" }}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      {!inRow && <span className="shrink-0 flex">{icon}</span>}
      <input ref={input} value={v} onChange={(e) => setV(e.target.value)} spellCheck={false} aria-label={edit.was ? `Rename ${edit.was}` : "New name"} aria-invalid={!!problem}
        onKeyDown={(e) => { if (!isAppChord(e)) e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); if (!problem) finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } }}
        onBlur={() => finish(inRow && !problem)} className={`${inRow ? "w-full" : "flex-1"} min-w-0 bg-transparent outline-none text-[12px]`} style={{ color: "var(--text)", height: rowH - 4, boxShadow: inRow ? "0 0 0 1px var(--primary)" : undefined, borderRadius: 4 }} />
      {problem && <span role="alert" className="absolute left-2 right-2 rounded-md px-2 py-1 text-[11px] truncate" style={{ top: rowH + 2, background: "var(--surface-card)", border: EDGE, color: "var(--error-ink)", zIndex: 4 }}>{problem}</span>}
    </div>
  );
}

/** Strata's Ask on a drop across volumes: copy is the default answer, Move is the other, and Esc or Cancel drops nothing. */
export function TransferDialog({ n, onPick, onClose }: { n: number; onPick: (op: "copy" | "move") => void; onClose: () => void }) {
  return (
    <Sheet label="Copy or move" onClose={onClose}>
      <b className="block text-[13px] mb-1">{n === 1 ? "Copy or move this item?" : `Copy or move these ${n} items?`}</b>
      <p className="m-0 mb-3" style={{ color: "var(--text3)" }}>The destination is on another volume.</p>
      <div className="flex justify-end gap-2">
        <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={onClose}>Cancel</button>
        <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={() => onPick("move")}>Move</button>
        <button autoFocus className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE, borderColor: "var(--primary)", color: "var(--primary-ink)" }} onClick={() => onPick("copy")}>Copy</button>
      </div>
    </Sheet>
  );
}

/** The question before something that cannot be taken back: what goes, how many, and the word on the button. */
export function ConfirmDialog({ title, body, confirm, onConfirm, onClose }: { title: string; body: string; confirm: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet label={title} onClose={onClose}>
      <b className="block text-[13px] mb-1">{title}</b>
      <p className="m-0 mb-3" style={{ color: "var(--text3)" }}>{body}</p>
      {/* Left/h and Right/l: Cancel and Confirm, whichever has the focus (Strata's). */}
      <div className="flex justify-end gap-2" onKeyDown={(e) => {
        const way = e.ctrlKey || e.altKey || e.metaKey ? null : e.key === "ArrowLeft" || e.key === "h" ? 0 : e.key === "ArrowRight" || e.key === "l" ? 1 : null;
        if (way === null) return;
        e.preventDefault(); e.stopPropagation();
        e.currentTarget.querySelectorAll<HTMLElement>("button")[way]?.focus();
      }}>
        <button autoFocus className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={onClose}>Cancel</button>
        <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE, color: "var(--error-ink)" }} onClick={onConfirm}>{confirm}</button>
      </div>
    </Sheet>
  );
}
