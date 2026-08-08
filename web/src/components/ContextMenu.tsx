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

export function ContextMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

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

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <Portal>
      {/* Full-viewport catcher rather than a document mousedown listener: it
          also stops the click landing on whatever is underneath, which for a
          rail menu is usually a tab that would switch view on the way out. */}
      <div className="fixed inset-0" style={{ zIndex: 9998 }} onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={ref} role="menu"
        className="fixed p-1.5 rounded-xl flex flex-col text-[11px]"
        style={{
          top: pos.y, left: pos.x, minWidth: 184, zIndex: 9999,
          background: "color-mix(in srgb, var(--bg2) 97%, black)",
          border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)",
          boxShadow: "0 24px 60px -18px rgba(0,0,0,0.7)",
          backdropFilter: "blur(18px)",
        }}
      >
        {children}
      </div>
    </Portal>
  );
}

export function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button role="menuitem" onClick={onClick}
      className="px-2 py-1.5 rounded-lg text-left hover:bg-white/5 transition-colors"
      style={{ color: danger ? "var(--error)" : "var(--text2)" }}>
      {children}
    </button>
  );
}
