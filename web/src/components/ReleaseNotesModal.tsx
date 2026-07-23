import { motion, AnimatePresence } from "motion/react";
import { useEffect } from "react";
import { Portal } from "./Portal.tsx";
import { Markdown } from "../lib/markdown.tsx";

/**
 * The notes for one release, in a dialog.
 *
 * Split out of WhatsNew because the notes now have two ways in, and only one of
 * them is automatic. WhatsNew decides *whether* to interrupt; About opens the
 * same thing because somebody asked. Neither decision belongs in the chrome, so
 * this component holds none of it — it renders what it is handed.
 *
 * Presentational on purpose, including the loading and error states. The
 * automatic caller never shows either (it stays silent rather than opening an
 * empty modal), but the manual one must: a button that opens nothing reads as
 * broken, and "could not reach github for the notes" is an answer.
 *
 * Above the settings dialog rather than beside it, since that is where the
 * manual route opens from. Equal z-index would leave the winner decided by DOM
 * order, which is not a thing to rely on.
 *
 * Shaped like SettingsModal — always mounted, `open` toggled — so the Portal
 * node is stable and AnimatePresence still gets to run the exit.
 */
export function ReleaseNotesModal({ open, tag, notes, title = "What's new", loading, error, footnote, onClose }: {
  open: boolean;
  tag: string;
  notes: string;
  title?: string;
  loading?: boolean;
  error?: string;
  /** Shown under the notes — e.g. that this build is some commits past the tag. */
  footnote?: string;
  onClose: () => void;
}) {
  // Captured, so Escape closes these notes and not whatever they opened over:
  // the settings dialog listens on the same window, in the bubble phase.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10010, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }}
              onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none" style={{ zIndex: 10011 }}>
              <motion.div
                role="dialog" aria-modal="true" aria-label={tag ? `${title} in ${tag}` : title}
                initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: 8 }}
                transition={{ type: "spring", stiffness: 340, damping: 30 }}
                className="w-[720px] max-w-[95vw] rounded-2xl flex flex-col pointer-events-auto overflow-hidden"
                style={{ maxHeight: "min(78vh, 640px)", background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>

                <div className="flex items-center gap-3 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>{title}</span>
                  {tag && <span className="chip" style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}>{tag}</span>}
                  <button onClick={onClose} className="ml-auto text-[18px] leading-none px-2 t-dim2 hover:opacity-70" aria-label="Close">✕</button>
                </div>

                <div className="px-5 py-4 overflow-y-auto agx-scroll text-[12.5px]" style={{ color: "var(--text2)" }}>
                  {loading
                    ? <div className="text-[11px] t-dim2">Reading the notes…</div>
                    : error
                      ? <div className="text-[11px]" style={{ color: "var(--warning)" }}>{error}</div>
                      : <Markdown text={notes} />}
                  {footnote && !loading && !error && (
                    <div className="mt-4 pt-3 border-t text-[10px] t-dim2" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                      {footnote}
                    </div>
                  )}
                </div>

                <div className="px-5 py-3 border-t shrink-0 flex justify-end" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <button onClick={onClose} autoFocus
                    className="text-[11.5px] px-3 py-1.5 rounded-lg font-medium"
                    style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 40%, transparent)" }}>
                    Got it
                  </button>
                </div>
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
