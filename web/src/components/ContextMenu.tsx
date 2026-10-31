/*
 * The right-click menu, once.
 *
 * This existed already and could not be used: it lived inside ViewRail.tsx as a
 * private function, so the second surface that wanted a context menu had the
 * choice between copying it or going without — and across the whole app there
 * were three right-clicks total. What was in there is good, and it is the part
 * nobody writes twice correctly: it measures itself after the first paint so it
 * can move out of the way of a window edge, it closes on Escape and on the
 * window losing focus, and it lays a full-viewport catcher underneath so the
 * click that dismisses it does not also land on whatever it was covering.
 *
 * Moved out verbatim rather than rewritten. The rail imports it under its old
 * name and behaves exactly as it did.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Portal } from "./Portal.tsx";
import { useCloseWithOwner } from "../lib/layerOwner.ts";
import { menuEventGuards } from "../lib/menuEvents.ts";
import { isMenuKey, menuIndex } from "../lib/menuNav.ts";
import { HIT, ICON } from "../lib/iconSize.ts";
import { EDGE } from "./workspace/Chrome.tsx";

/** `width` fixes the menu's width (a long menu with a second line per entry needs one) and the menu then scrolls inside the window instead of running off it. */
export function ContextMenu({ x, y, onClose, children, width, label, pop, plain }: {
  x: number; y: number; onClose: () => void; children: ReactNode; width?: number; label?: string; plain?: boolean;
  /** The popover skin of the pull-request mockup: the page's own ground, an 11px radius, a ring and a soft lift. */
  pop?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useCloseWithOwner(onClose, { at: { x, y } });

  // Measured after the first paint, because "does this fall off the bottom of
  // the window" cannot be answered before it has a height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 8),
      y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);

  // Where the keyboard was when it opened, so Escape (or any way out) puts it back
  // there: a menu that drops focus on the page leaves the next key going nowhere.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      // Arrows, Home and End move between rows. In a text box inside the menu
      // (a "new project" field) they are the caret's, so they are left alone.
      if (!isMenuKey(e.key) || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
      if (!items.length) return;
      e.preventDefault();
      e.stopPropagation();
      items[menuIndex(items.indexOf(document.activeElement as HTMLElement), e.key, items.length)]?.focus();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <Portal>
      {/* `display: contents`: a wrapper that exists only to hold the guards, and
          lays out as nothing. Without it every event in here bubbled through the
          React tree to whatever opened the menu — see lib/menuEvents.ts. */}
      <div style={{ display: "contents" }} {...menuEventGuards()}>
        {/* Full-viewport catcher rather than a document mousedown listener: it
            also stops the click landing on whatever is underneath, which for a
            rail menu is usually a tab that would switch view on the way out.
            It closes on the CLICK, not the mousedown: closing on the press
            removed it before the release, and the release then belonged to the
            row beneath. */}
        <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
        <div ref={ref} role="menu" aria-label={label}
          className={`fixed flex flex-col ${pop ? "" : "p-1.5 rounded-xl gap-0.5 text-[11px]"}`}
          style={{
            top: pos.y, left: pos.x, minWidth: width ?? 184, zIndex: 9999,
            ...(width && !pop ? { width, maxHeight: "min(560px, calc(100vh - 16px))", overflowY: "auto" as const } : null),
            /* The card menu keeps its header fixed and scrolls the list itself (PrCardMenu), so the box clips and never scrolls. */
            ...(pop ? { width, maxHeight: "min(560px, calc(100vh - 32px))", overflow: "hidden" as const } : null),
            ...(pop ? {
              borderRadius: 11, background: "var(--bg)",
              boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent), 0 2px 6px rgba(0,0,0,0.08), 0 14px 34px -14px rgba(0,0,0,0.35)",
            } : {
              background: plain ? "var(--bg)" : "color-mix(in srgb, var(--bg2) 97%, black)",
              border: EDGE,
              boxShadow: "0 24px 60px -18px rgba(0,0,0,0.7)",
              backdropFilter: "blur(18px)",
            }),
          }}
        >
          {children}
        </div>
      </div>
    </Portal>
  );
}

export function MenuItem({ onClick, danger, autoFocus, children }: { onClick: () => void; danger?: boolean; autoFocus?: boolean; children: ReactNode }) {
  return (
    <button role="menuitem" onClick={onClick} autoFocus={autoFocus}
      className="px-2 py-1.5 rounded-lg text-left hover:bg-white/5 transition-colors"
      style={{ color: danger ? "var(--error)" : "var(--text2)" }}>
      {children}
    </button>
  );
}

/**
 * A row for the menus drawn with AnchoredMenu: one line at HIT, an icon in its
 * own box so rows with and without one keep the words in line, the shortcut at
 * the right edge, and a reason in the tooltip when it is off.
 *
 * `MenuItem` above is the context menu's plainer row and is left as it was;
 * this is the one the Terminal's strip menus share, so the "+" menu, the
 * commands popover and the sessions switcher read as one family.
 */
export function MenuRow({ onClick, icon, kbd, hint, danger, disabled, title, current, children }: {
  onClick: () => void; icon?: ReactNode; kbd?: string; danger?: boolean; disabled?: boolean; title?: string;
  /** A plain word on the right, quieter than a key cap: what the row is about. */
  hint?: string;
  /** The row names where you already are: a dot, and the row is not a way anywhere. */
  current?: boolean; children: ReactNode;
}) {
  return (
    <button type="button" role="menuitem" onClick={onClick} disabled={disabled} title={title}
      className="agx-mi w-full text-left flex items-center gap-2 px-2.5 text-[11px] whitespace-nowrap disabled:opacity-45 disabled:cursor-not-allowed"
      style={{ minHeight: HIT, color: danger ? "var(--error)" : "var(--text2)" }}>
      {icon !== undefined && <span className="shrink-0 grid place-items-center" style={{ width: ICON.sm, height: ICON.sm }}>{icon}</span>}
      <span className="min-w-0 truncate">{children}</span>
      {current && <span aria-hidden className="shrink-0 rounded-full" style={{ width: 6, height: 6, background: "var(--primary)" }} />}
      {hint && <span className="ml-auto shrink-0 text-[10.5px]" style={{ color: "var(--text3)" }}>{hint}</span>}
      {kbd && <kbd className="ml-auto shrink-0 text-[10px] px-1 rounded" style={{ background: "var(--surface-inset)", color: "var(--text3)" }}>{kbd}</kbd>}
    </button>
  );
}

/** A hairline between groups of rows. */
export const MenuRule = () => <div role="separator" style={{ height: 1, background: "var(--surface-line)", margin: "4px 2px" }} />;
