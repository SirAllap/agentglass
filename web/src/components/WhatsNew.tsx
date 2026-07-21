import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { api, IS_DEMO } from "../lib/api.ts";
import { Markdown } from "../lib/markdown.tsx";
import { markSeen, releaseToAnnounce } from "../lib/whatsNew.ts";

/**
 * What changed, the first time the app runs a version it has not run before.
 *
 * Updating restarted the app and said nothing. The notes already exist — the
 * tag annotation is what the GitHub release is made from — so the app can show
 * them once instead of leaving you to go and find the release page, which
 * nobody does.
 *
 * Once. `releaseToAnnounce` decides, and it deliberately stays quiet on a fresh
 * install and on a downgrade; this component only renders what it is told.
 * Dismissing marks the version seen, and so does failing to load the notes: an
 * empty modal on every launch would be worse than no modal at all.
 */
export function WhatsNew() {
  const [tag, setTag] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (IS_DEMO) return;
    let live = true;
    // Deliberately after the first paint rather than racing it: the dashboard
    // connecting matters more than the notes, and the modal is not urgent.
    const t = setTimeout(() => {
      api.updateNotes()
        .then((r) => {
          if (!live || !r.tag) return;
          const announce = releaseToAnnounce(r.tag);
          if (!announce) return;
          if (!r.ok || !r.notes.trim()) { markSeen(r.tag); return; }
          setTag(announce);
          setNotes(r.notes);
        })
        .catch(() => { /* offline, or a browser tab the desktop gate refuses */ });
    }, 2500);
    return () => { live = false; clearTimeout(t); };
  }, []);

  const close = () => { if (tag) markSeen(tag); setTag(null); };

  useEffect(() => {
    if (!tag) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tag]);

  return (
    <AnimatePresence>
      {tag && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }}
            onClick={close} />
          <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none" style={{ zIndex: 10001 }}>
            <motion.div
              role="dialog" aria-modal="true" aria-label={`What's new in ${tag}`}
              initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: 8 }}
              transition={{ type: "spring", stiffness: 340, damping: 30 }}
              className="w-[720px] max-w-[95vw] rounded-2xl flex flex-col pointer-events-auto overflow-hidden"
              style={{ maxHeight: "min(78vh, 640px)", background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>

              <div className="flex items-center gap-3 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>What's new</span>
                <span className="chip" style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}>{tag}</span>
                <button onClick={close} className="ml-auto text-[18px] leading-none px-2 t-dim2 hover:opacity-70" aria-label="Close">✕</button>
              </div>

              <div className="px-5 py-4 overflow-y-auto agx-scroll text-[12.5px]" style={{ color: "var(--text2)" }}>
                <Markdown text={notes} />
              </div>

              <div className="px-5 py-3 border-t shrink-0 flex justify-end" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                <button onClick={close} autoFocus
                  className="text-[11.5px] px-3 py-1.5 rounded-lg font-medium"
                  style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 40%, transparent)" }}>
                  got it
                </button>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
