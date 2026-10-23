// A menu that hangs off a button and is never clipped by the column it came from.
//
// The columns scroll sideways and the palette clips its children, so a menu
// drawn inside either loses an edge. It is a Portal at the menu layer with a
// backdrop that closes it on any click elsewhere — one element, which a click
// that stops propagation cannot outrun — and it is clamped to the window so a
// button near the right edge opens inward instead of off the screen.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Portal } from "../../Portal.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { LAYER } from "../../../lib/layers.ts";
import { DoneIcon } from "../../../lib/glyphIcons.tsx";
import { StrataIcon } from "./StrataIcon.tsx";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { MENU_ROW } from "../../../lib/finderMenu.ts";
import { useMenuKeys } from "./useMenuKeys.ts";

export function Popover({ anchor, onClose, width = 220, children, label }: { anchor: DOMRect; onClose: () => void; width?: number; children: ReactNode; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const h = el.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
    const below = anchor.bottom + 8;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, anchor.top - 4 - h) : below;
    setAt({ left, top });
  }, [anchor, width]);
  // Focus stays in the palette's search box while a menu is open, so Escape never reaches the menu: it is taken here, or it would close the whole finder.
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [onClose]);
  useMenuKeys(el);
  return (
    <Portal z={LAYER.menu}>
      <div className="fixed inset-0" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={el} role="menu" data-finder-menu aria-label={label} className="fixed rounded-lg text-[12px] shadow-2xl py-1.5"
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
        style={{ width, left: at?.left ?? -9999, top: at?.top ?? -9999, background: "var(--surface-card)", border: EDGE, color: "var(--text)", maxHeight: "calc(100vh - 16px)", overflowY: "auto" }}>
        {children}
      </div>
    </Portal>
  );
}

export function MenuCap({ children }: { children: ReactNode }) {
  return <div className="px-3.5 pt-2 pb-1 text-[10.5px] uppercase tracking-[0.1em]" style={{ color: "var(--text3)", fontWeight: 600 }}>{children}</div>;
}

/** `icon`: the name of one of Strata's action icons, drawn in the accent before the label, as Strata's menus do. */
export function MenuItem({ children, onClick, on, hint, disabled, icon }: { children: ReactNode; onClick: () => void; on?: boolean; hint?: string; disabled?: boolean; icon?: string }) {
  return (
    <button role="menuitemcheckbox" aria-checked={on} disabled={disabled} onClick={onClick}
      className={`${MENU_ROW} flex items-center gap-2 px-3 text-left disabled:opacity-40`} style={{ minHeight: 34, color: "var(--text)" }}>
      {icon && <span style={{ color: "var(--primary-ink)" }}><StrataIcon set="act" name={icon} size={ICON.sm} /></span>}
      <span className="flex-1 min-w-0 truncate">{children}</span>
      {hint && <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>{hint}</span>}
      <span aria-hidden className="w-3 flex justify-center" style={{ color: "var(--primary-ink)" }}>{on ? <DoneIcon size={ICON.xs} /> : null}</span>
    </button>
  );
}

export const MenuRule = () => <div className="my-1" style={{ borderTop: LINE }} />;
