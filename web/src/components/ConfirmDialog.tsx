import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";

/**
 * The app's own confirm/prompt, because the browser's belong to the browser.
 *
 * `window.confirm` renders in the OS chrome: a different typeface, a different
 * button order per platform, no relationship to the panel that raised it. In a
 * flow that then opens one of our own modals — pick what to keep, here is what
 * it costs — the seam is the loudest thing on screen, and a dialog that reads
 * as foreign is a dialog people click through without reading. That matters
 * most for exactly the questions this app asks, which are about deleting
 * things.
 *
 * It also blocks the JS thread, which is the second half of the same problem:
 * nothing can show a spinner, disable a button, or repaint while it is up.
 *
 * So: same surface as the rest of the panel, resolved through a promise so the
 * calling code keeps reading top to bottom.
 *
 *   if (!(await ask({ title: "Delete branch?", danger: true }))) return;
 */

export type ConfirmSpec = {
  title: string;
  /** Shown under the title, newlines preserved. */
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button — for anything that destroys work. */
  danger?: boolean;
  /** Turns this into a prompt: the resolved value is the typed string, or null
   *  if cancelled. */
  input?: { label?: string; initial?: string; placeholder?: string };
};

type Pending = ConfirmSpec & { resolve: (v: boolean | string | null) => void };

export function ConfirmDialog({ pending }: { pending: Pending | null }) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isPrompt = !!pending?.input;

  useEffect(() => {
    if (!pending) return;
    setText(pending.input?.initial ?? "");
    // Focus after the entrance frame so the caret doesn't fight the animation.
    const t = setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 40);
    return () => clearTimeout(t);
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); pending.resolve(isPrompt ? null : false); }
      // Enter confirms, but not while a prompt's field is empty — that is the
      // one case where the obvious keystroke would submit nothing.
      else if (e.key === "Enter" && (!isPrompt || text.trim())) {
        e.preventDefault(); e.stopPropagation();
        pending.resolve(isPrompt ? text.trim() : true);
      }
    };
    // Capture: the panel's own single-letter shortcuts listen on window too,
    // and a dialog on screen owns the keyboard until it is answered.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, text, isPrompt]);

  return (
    <AnimatePresence>
      {pending && (
        <Portal>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0" style={{ zIndex: 10004, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }}
            onClick={() => pending.resolve(isPrompt ? null : false)} />
          <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10005 }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.98, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }}
              className="pointer-events-auto w-full max-w-[520px] rounded-xl overflow-hidden"
              style={{ background: "var(--bg2)", border: "1px solid var(--border)", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
              role="dialog" aria-modal="true"
            >
              <div className="px-4 py-3.5">
                <div className="text-[13px] font-medium" style={{ color: "var(--text)" }}>{pending.title}</div>
                {pending.body && (
                  <div className="text-[11.5px] mt-2 whitespace-pre-wrap leading-relaxed" style={{ color: "var(--text3)" }}>{pending.body}</div>
                )}
                {isPrompt && (
                  <div className="mt-3">
                    {pending.input!.label && <div className="text-[10.5px] mb-1" style={{ color: "var(--text3)" }}>{pending.input!.label}</div>}
                    <input
                      ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
                      placeholder={pending.input!.placeholder}
                      className="w-full text-[12px] px-2 py-1.5 rounded outline-none"
                      style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
                    />
                  </div>
                )}
              </div>
              <div className="px-4 py-2.5 flex items-center justify-end gap-2" style={{ borderTop: "1px solid var(--border)" }}>
                <button onClick={() => pending.resolve(isPrompt ? null : false)}
                  className="text-[11px] px-2.5 py-1 rounded"
                  style={{ color: "var(--text2)", border: "1px solid var(--border)" }}>
                  {pending.cancelLabel ?? "Cancel"}
                </button>
                <button onClick={() => pending.resolve(isPrompt ? text.trim() : true)}
                  disabled={isPrompt && !text.trim()}
                  className="text-[11px] px-2.5 py-1 rounded font-medium disabled:opacity-40"
                  style={{ color: "var(--bg)", background: pending.danger ? "var(--error)" : "var(--primary)" }}>
                  {pending.confirmLabel ?? (pending.danger ? "Delete" : "Ok")}
                </button>
              </div>
            </motion.div>
          </div>
        </Portal>
      )}
    </AnimatePresence>
  );
}

/**
 * `const { ask, askText, dialog } = useDialogs()` — render `dialog`, await the
 * rest. One pending question at a time, which is all any of these flows need.
 */
export function useDialogs() {
  const [pending, setPending] = useState<Pending | null>(null);
  const done = (resolve: (v: never) => void) => (v: never) => { setPending(null); resolve(v); };

  const ask = (spec: ConfirmSpec): Promise<boolean> =>
    new Promise<boolean>((resolve) => setPending({ ...spec, resolve: done(resolve as never) as never }));

  const askText = (spec: ConfirmSpec & { input: NonNullable<ConfirmSpec["input"]> }): Promise<string | null> =>
    new Promise<string | null>((resolve) => setPending({ ...spec, resolve: done(resolve as never) as never }));

  return { ask, askText, dialog: <ConfirmDialog pending={pending} /> };
}
