// The filter deck on a narrow window: a sheet from the bottom edge over a scrim,
// not a block that pushes the board down. A real dialog: focus moves in, Tab
// stays inside, Escape and a press on the scrim close it, and focus goes back to
// the button that opened it. Popovers it opens (the rule editor, the syntax
// help) sit above it, and Escape closes the topmost of them first.
import { useEffect, type ReactNode } from "react";
import { Portal } from "./Portal.tsx";
import { LAYER } from "../lib/layers.ts";
import { useModalDialog } from "../lib/focusTrap.ts";
import { Button, EDGE } from "./workspace/Chrome.tsx";

export function PrFilterSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const modal = useModalDialog(true, title);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <Portal z={LAYER.settings}>
      <div className="fixed inset-0" style={{ background: "color-mix(in srgb, var(--bg) 55%, rgba(0,0,0,.45))" }} onMouseDown={onClose} data-sheet-scrim />
      <div {...modal} data-sheet className="fixed inset-x-0 bottom-0 flex flex-col outline-none"
        style={{ maxHeight: "85vh", background: "var(--bg)", border: EDGE, borderBottom: 0, borderRadius: "16px 16px 0 0", boxShadow: "0 -18px 40px -12px rgba(0,0,0,.35)" }}>
        <div className="flex items-center px-4 pt-3 pb-2">
          <span className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>{title}</span>
          <Button size="compact" tone="primary" className="ml-auto" onClick={onClose}>Done</Button>
        </div>
        <div className="overflow-y-auto agx-scroll px-4 pb-4">{children}</div>
      </div>
    </Portal>
  );
}
