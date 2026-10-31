import { useEffect, useRef, useState, type ReactNode } from "react";
import { lastWasKey } from "./inputMode.ts";

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * The card over the Flying view: Escape closes it, Tab stays inside it, and focus
 * goes back to what opened it. A press on the scrim closes it too. It fades in,
 * unless it was opened from the keyboard.
 */
export function CardPopover({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const still = useRef(lastWasKey());
  const [shown, setShown] = useState(still.current);
  /* What opened the card is read once, at the first render: the effect below must not re-run when the parent hands in a new onClose, or it would take something inside the card for the opener. */
  const opener = useRef<HTMLElement | null>(null);
  if (opener.current === null && typeof document !== "undefined") opener.current = document.activeElement as HTMLElement | null;
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const f = requestAnimationFrame(() => setShown(true));
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close.current(); return; }
      if (e.key !== "Tab" || !root.current) return;
      const els = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!els.length) return;
      const at = els.indexOf(document.activeElement as HTMLElement);
      const end = e.shiftKey ? at <= 0 : at === els.length - 1;
      if (end) { e.preventDefault(); els[e.shiftKey ? els.length - 1 : 0]!.focus(); }
    };
    window.addEventListener("keydown", key, true);
    return () => { cancelAnimationFrame(f); window.removeEventListener("keydown", key, true); opener.current?.focus?.(); };
  }, []);
  return (
    <div className="pv ps pv-scrim" ref={root} data-state={shown ? undefined : "enter"} data-still={still.current ? "" : undefined} onMouseDown={(e) => { if (e.target === e.currentTarget) close.current(); }}>
      <div className="pv-pop" role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>
  );
}
