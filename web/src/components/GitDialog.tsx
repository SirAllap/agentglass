import { useEffect, useId, useRef, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { BranchIcon, InfoIcon, MergeIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { Button, EDGE, LINE } from "./workspace/Chrome.tsx";
import { ICON, HIT } from "../lib/iconSize.ts";
import { LAYER } from "../lib/layers.ts";
import { enterAction, dialogKeyScope, type GitTone } from "../lib/gitDialog.ts";

/**
 * The one frame every question in the Git panel is asked in.
 *
 * Four parts, always in this order: the QUESTION (a sentence ending in "?", an
 * icon tile in the dialog's tone, a close button in the same corner), the
 * COMMAND the answer would run when there is one, the BODY, and a FOOTER of
 * fixed height whose left side is one plain sentence (what pressing the button
 * does, or why it is off) and whose right side is Cancel then the action named
 * after what it does. Header and footer stay put; only the body scrolls, so
 * the buttons are reachable in a 420px-tall window.
 *
 * A dangerous question (`danger`) starts on Cancel and Enter does not say yes
 * to it: the red button needs a deliberate Tab and press.
 */

const TONE: Record<GitTone, { ink: string; icon: ReactNode }> = {
  primary: { ink: "var(--primary)", icon: <BranchIcon size={ICON.lg} /> },
  neutral: { ink: "var(--text2)", icon: <InfoIcon size={ICON.lg} /> },
  warn: { ink: "var(--warning)", icon: <WarningIcon size={ICON.lg} /> },
  danger: { ink: "var(--error)", icon: <WarningIcon size={ICON.lg} /> },
  merge: { ink: "var(--merged)", icon: <MergeIcon size={ICON.lg} /> },
};

const tint = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

export interface GitDialogProps {
  title: string;
  subtitle?: ReactNode;
  tone?: GitTone;
  /** Replaces the tone's default glyph. */
  icon?: ReactNode;
  /** The git the answer runs. Drawn as a preview block under the question. */
  command?: string;
  /** Adds "This cannot be undone." under the command. */
  cannotUndo?: boolean;
  /** Footer, left: one plain sentence. */
  reason?: ReactNode;
  /** Footer, right. `null` hides Cancel (a dialog with nothing to decline). */
  cancelLabel?: string | null;
  confirmLabel?: string;
  /** No confirm button at all when absent: a viewer, closed with its X. */
  onConfirm?: () => void;
  confirmDisabled?: boolean;
  /** The confirm button's own icon, left of the label. */
  confirmIcon?: ReactNode;
  danger?: boolean;
  /** Replaces both buttons: a step that is running and cannot be cancelled. */
  working?: ReactNode;
  onClose: () => void;
  /** A step is running and cannot be taken back: Escape, the scrim and the X do
   *  nothing. Defaults to true while `working` is shown. */
  locked?: boolean;
  /** Where the focus lands when it opens. Defaults to the primary action, or
   *  Cancel on a danger dialog. */
  initialFocus?: "cancel" | "confirm" | "input" | "none";
  /** Enter does not confirm: the dialog has its own keys (a list that takes
   *  j/k and Enter itself). Escape still closes it. */
  ownKeys?: boolean;
  /** Enter never confirms, whatever has the focus. */
  enterConfirms?: boolean;
  width?: number | string;
  /** The body takes no padding of its own: a list that runs to the edges. */
  flush?: boolean;
  children?: ReactNode;
}

export function GitDialog(p: GitDialogProps) {
  const tone = p.tone ?? (p.danger ? "danger" : "primary");
  const ink = TONE[tone].ink;
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const live = useRef(p);
  live.current = p;
  const focus = p.initialFocus ?? (p.danger ? "cancel" : p.onConfirm ? "confirm" : "none");
  const enterConfirms = p.enterConfirms ?? !p.danger;
  const locked = !!(p.locked ?? p.working);
  const frameRef = useRef<HTMLDivElement>(null);
  const close = () => { if (!live.current.locked && !live.current.working) live.current.onClose(); };

  useEffect(() => {
    // After the entrance frame, so the caret does not fight the animation.
    const t = setTimeout(() => {
      if (focus === "cancel") cancelRef.current?.focus();
      else if (focus === "confirm") confirmRef.current?.focus();
      else if (focus === "input") bodyRef.current?.querySelector<HTMLElement>("input,textarea")?.focus();
    }, 40);
    return () => clearTimeout(t);
  }, [focus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      const own = frameRef.current;
      const from = e.target instanceof Element ? e.target : document.activeElement;
      const all = document.querySelectorAll("[data-git-dialog]");
      const scope = dialogKeyScope({
        key: e.key, isTop: !!own && all[all.length - 1] === own,
        inOwn: !!own && !!from && own.contains(from),
        inMenu: !!from?.closest("[role=menu],[role=listbox],[data-menu-layer]"),
        inOtherDialog: !!from?.closest("[role=dialog]") && !(own && own.contains(from)),
      });
      if (scope === "ignore") return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); close(); return; }
      if (live.current.ownKeys) return;
      const el = document.activeElement;
      const onCancel = !!el && el === cancelRef.current;
      const what = enterAction({
        enterConfirms, focusOnCancel: onCancel,
        confirmDisabled: !live.current.onConfirm || !!live.current.confirmDisabled || !!live.current.working,
        inTextarea: el instanceof HTMLTextAreaElement,
      });
      // A focused button handles Enter itself (as a click); only the buttons
      // that must NOT act are stopped here.
      if (onCancel && !enterConfirms) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return; }
      if (el instanceof HTMLButtonElement && el !== confirmRef.current) return;
      if (what === "confirm") { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); live.current.onConfirm?.(); }
    };
    // Capture: the panel's own single-letter shortcuts listen on window too,
    // and a dialog on screen owns the keyboard until it is answered.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enterConfirms]);

  return (
    <Portal z={LAYER.gitDialog}>
      <AnimatePresence>
        <motion.div key="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 agx-scrim" onClick={close} />
        <div key="frame" className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none">
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }}
            ref={frameRef} role="dialog" aria-modal="true" aria-labelledby={id}
            className="pointer-events-auto w-full min-w-0 rounded-xl overflow-hidden flex flex-col"
            data-git-dialog={tone}
            style={{ maxWidth: p.width ?? 470, maxHeight: "calc(100dvh - 48px)", background: "var(--surface-card)", border: EDGE, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
          >
            <div className="shrink-0 flex items-start gap-3 px-4 pt-4 pb-3.5">
              <span className="shrink-0 grid place-items-center rounded-lg" aria-hidden
                style={{ width: 36, height: 36, color: ink, background: tint(ink, 10), boxShadow: `inset 0 0 0 1px ${tint(ink, 24)}` }}>
                {p.icon ?? TONE[tone].icon}
              </span>
              <div className="min-w-0 flex-1">
                <h3 id={id} className="m-0 text-[15px] font-semibold leading-[1.3]" style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{p.title}</h3>
                {p.subtitle && <div className="mt-0.5 text-[12.5px] leading-[1.45]" style={{ color: "var(--text3)", overflowWrap: "anywhere" }}>{p.subtitle}</div>}
              </div>
              {!locked && <CloseButton onClick={close} className="shrink-0 -mr-1.5 -mt-1" aria-label="Close" />}
            </div>

            <div ref={bodyRef} className="agx-dialog-body min-h-0 flex-1 overflow-y-auto flex flex-col gap-2.5"
              style={p.flush ? undefined : { padding: "2px 16px 16px" }} tabIndex={-1}>
              {p.command && (
                <div className="px-2.5 py-2 rounded-lg text-[11.5px] select-all"
                  style={{
                    fontFamily: "var(--font-mono, ui-monospace, monospace)", color: "var(--text)", wordBreak: "break-all",
                    background: p.danger ? tint("var(--error)", 9) : "var(--surface-inset)",
                    border: p.danger ? `1px solid ${tint("var(--error)", 30)}` : EDGE,
                  }}>{p.command}</div>
              )}
              {p.cannotUndo && <div className="text-[11.5px]" style={{ color: "var(--error-ink)" }}>This cannot be undone.</div>}
              {p.children}
            </div>

            <div className="shrink-0 flex items-center gap-2 px-4" style={{ borderTop: LINE, background: "var(--surface-nav)", minHeight: 48 }}>
              <span className="min-w-0 flex-1 py-2 text-[11.5px] leading-snug" style={{ color: "var(--text3)" }}>
                {p.reason ?? (p.danger ? "Enter does nothing here." : null)}
              </span>
              {p.working ?? (
                <>
                  {p.cancelLabel !== null && (
                    <Button buttonRef={cancelRef} onClick={close}>{p.cancelLabel ?? "Cancel"}</Button>
                  )}
                  {p.onConfirm && (
                    <Button buttonRef={confirmRef} tone={p.danger || tone === "danger" ? "danger" : tone === "warn" ? "warn" : "primary"}
                      onClick={p.onConfirm} disabled={p.confirmDisabled}>
                      {p.confirmIcon}{p.confirmLabel ?? (p.danger ? "Delete" : "Ok")}
                    </Button>
                  )}
                </>
              )}
            </div>
          </motion.div>
        </div>
      </AnimatePresence>
    </Portal>
  );
}

/** `head → base`: where the work is and what it is measured against. The head
 *  is the one that may be cut (it is the long one); the base is always whole. */
export function RefStrip({ head, base, tone = "primary" }: { head: string; base: string; tone?: GitTone }) {
  const ink = TONE[tone].ink;
  const chip = "inline-flex items-center gap-1.5 px-2 rounded-md text-[11.5px]";
  return (
    <div className="flex items-center gap-2 min-w-0 rounded-lg px-2.5 py-2" style={{ background: "var(--surface-inset)", border: EDGE }}>
      <span className={`${chip} min-w-0`} title={head} style={{ height: 22, color: ink, background: tint(ink, 10), border: `1px solid ${tint(ink, 28)}`, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
        <BranchIcon size={ICON.xs} /><span className="truncate">{head}</span>
      </span>
      <span className="shrink-0" style={{ color: "var(--text3)" }} aria-label="onto">→</span>
      <span className={`${chip} shrink-0`} title={base} style={{ height: 22, color: "var(--text2)", border: EDGE, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{base}</span>
    </div>
  );
}

/** A failure in the dialog's own words, with the way out. */
export function DialogError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[12px]"
      style={{ color: "var(--error-ink)", background: tint("var(--error)", 10), border: `1px solid ${tint("var(--error)", 28)}` }}>
      <WarningIcon size={ICON.md} />
      <span className="min-w-0 flex-1" style={{ overflowWrap: "anywhere" }}>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 text-[11.5px] px-2.5 rounded-lg font-medium"
          style={{ height: HIT - 4, color: "var(--text)", border: EDGE, background: "var(--surface-card)" }}>Try again</button>
      )}
    </div>
  );
}

/** Rows in the exact shape of the real ones, while the data is read. */
export function DialogSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-1.5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rounded-lg motion-safe:animate-pulse" style={{ height: 32, background: "var(--surface-inset)", border: EDGE, opacity: 1 - i * 0.15 }} />
      ))}
      <span className="text-[11px]" style={{ color: "var(--text3)" }}>{label}</span>
    </div>
  );
}
