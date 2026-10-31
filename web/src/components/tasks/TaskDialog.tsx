/*
 * The dialog the Tasks sources open for a short form or a question: New task,
 * the Local keys, Finish issue. One shell so the three look like one thing.
 *
 * What it is: a centred sheet, 520px at most, a header with a title and a close
 * button, a body, and a footer whose buttons sit on the right. A scrim behind it
 * dims the board and a press on it closes the dialog. The scrim is black at 40%,
 * not a mix of the text colour: on a dark theme the text is light and the mix
 * washed the board grey instead of dimming it. Escape closes it too
 * (useDismiss stops the key there, so the view behind does not also step back).
 *
 * Ceiling: no focus trap beyond autofocus on the first field the caller marks;
 * the page behind is dimmed and covered, not made inert.
 */
import { useRef, type ReactNode } from "react";
import { CloseButton } from "../CloseButton.tsx";
import { Portal } from "../Portal.tsx";
import { LAYER } from "../../lib/layers.ts";
import { NO_DRAG } from "../../lib/dragRegion.ts";
import { useDismiss } from "../../lib/useDismiss.ts";
import { EDGE, LINE } from "../workspace/Chrome.tsx";

export function TaskDialog({ title, onClose, children, footer, closable = true, width = 520 }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Buttons for the foot, right-aligned. A dialog that is only read has none. */
  footer?: ReactNode;
  /** False for a question that must be answered with one of its own buttons. */
  closable?: boolean;
  width?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, box, onClose);
  return (
    <Portal find z={LAYER.viewer}>
      <div className="fixed inset-0" style={{ ...NO_DRAG, background: "rgba(0, 0, 0, 0.4)" }} onClick={onClose} />
      <div ref={box} role="dialog" aria-modal="true" aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="fixed left-1/2 top-1/2 flex flex-col min-h-0 overflow-hidden"
        style={{
          ...NO_DRAG, transform: "translate(-50%, -50%)", width: `min(${width}px, 92vw)`, maxHeight: "88vh", borderRadius: 12,
          background: "var(--bg)", border: EDGE, boxShadow: "0 24px 60px -16px rgba(0,0,0,0.4)",
        }}>
        <header className="flex items-center gap-2 shrink-0" style={{ padding: "14px 16px 10px" }}>
          <h2 className="flex-1 min-w-0 truncate text-[14px]" style={{ fontWeight: 650, color: "var(--text)" }}>{title}</h2>
          {closable && <CloseButton onClick={onClose} title="Close (Esc)" />}
        </header>
        <div className="agx-scroll min-h-0 overflow-auto" style={{ padding: "0 16px 12px" }}>{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 shrink-0" style={{ padding: "10px 16px", borderTop: LINE }}>
            {footer}
          </footer>
        )}
      </div>
    </Portal>
  );
}
