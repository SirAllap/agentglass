import { useEffect, useRef, type ReactNode } from "react";
import { Portal } from "../Portal.tsx";
import { Button, EDGE, LINE } from "../workspace/Chrome.tsx";
import { LAYER } from "../../lib/layers.ts";

/**
 * "View more" on an installed plugin: its picture and everything the compact
 * row leaves out. One shape for any plugin, long text scrolls in the body and
 * the header and footer stay put, so Close is reachable at any window height.
 * Escape closes it before anything else sees the key.
 * Focus is a modal's too: it moves into the dialog on open, Tab and Shift+Tab
 * cycle inside it, and on close it goes back to what opened it (View more).
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** The element Tab should land on next inside `root`, wrapping at both ends; null when focus may move on its own. */
export function trapTarget(items: readonly HTMLElement[], active: Element | null, back: boolean): HTMLElement | null {
  if (items.length === 0) return null;
  const first = items[0], last = items[items.length - 1];
  const i = active ? items.indexOf(active as HTMLElement) : -1;
  if (i === -1) return back ? last : first;
  if (back && i === 0) return last;
  if (!back && i === items.length - 1) return first;
  return null;
}

export function PluginModal({ title, subtitle, picture, onClose, children }: {
  title: string; subtitle: string; picture: ReactNode; onClose: () => void; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    box.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab" || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      const inside = box.current.contains(document.activeElement) && document.activeElement !== box.current ? document.activeElement : null;
      const to = trapTarget(items, inside, e.shiftKey);
      if (to) { e.preventDefault(); to.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <Portal>
      <div className="fixed inset-0 agx-scrim" style={{ zIndex: LAYER.settingsDialog }} onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: LAYER.settingsDialog + 1 }}>
        <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} data-plugin-modal=""
          className="pointer-events-auto w-full min-w-0 max-w-[640px] rounded-xl overflow-hidden flex flex-col outline-none"
          style={{ maxHeight: "calc(100dvh - 48px)", background: "var(--surface-card)", border: EDGE, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
          <div className="shrink-0">{picture}</div>
          <div className="px-4 pt-3 pb-2 shrink-0">
            <div className="text-[14px] font-medium" style={{ color: "var(--text)" }}>{title}</div>
            <div className="mt-0.5 text-[11.5px]" style={{ color: "var(--text3)" }}>{subtitle}</div>
          </div>
          <div className="px-0 pb-2 flex-1 min-h-0 overflow-y-auto" tabIndex={0} aria-label={`${title} details`}>{children}</div>
          <div className="px-4 py-2.5 shrink-0 flex items-center justify-end" style={{ borderTop: LINE }}>
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
