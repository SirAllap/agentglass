/*
 * What closing a window shows: the question, when there is one, and the toast
 * that offers to take it back.
 *
 * The question hangs from the tab that was closed (an inline confirm, not a
 * modal: nothing else on screen needs to be dimmed to ask one thing). Keep it
 * has the focus, so Enter does the safe thing. The toast is a status, not an
 * alert, and its clock stops while the pointer or the keyboard is on it.
 */
import { useEffect, useRef, useState } from "react";
import { useCloseWithOwner } from "../../lib/layerOwner.ts";
import { LAYER } from "../../lib/layers.ts";
import { placeMenu, type Placement } from "../../lib/menuPlacement.ts";
import { menuEventGuards } from "../../lib/menuEvents.ts";
import { UndoIcon } from "../../lib/glyphIcons.tsx";
import { CloseIcon } from "../workspace/icons.tsx";
import { HIT, ICON } from "../../lib/iconSize.ts";
import type { ClosedToast, CloseAsk } from "../../lib/useWindowClose.ts";
import { Portal } from "../Portal.tsx";
import { Button, EDGE, tintEdge } from "../workspace/Chrome.tsx";

/** How long "Closed x · Reopen" stays. */
export const TOAST_MS = 5000;

export function CloseConfirm({ ask, onStop, onKeep }: { ask: CloseAsk; onStop: () => void; onKeep: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const keepBtn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<Placement | null>(null);
  useCloseWithOwner(onKeep);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = ask.anchor ?? { left: window.innerWidth / 2, right: window.innerWidth / 2, top: 40, bottom: 40 };
    setPos(placeMenu(a, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, "left"));
  }, [ask]);
  useEffect(() => { if (pos) keepBtn.current?.focus({ preventScroll: true }); }, [pos === null]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onKeep(); } };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onKeep);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("blur", onKeep); };
  }, [onKeep]);

  return (
    <Portal z={LAYER.menu}>
      <div style={{ display: "contents" }} {...menuEventGuards()}>
        <div data-menu-layer className="fixed inset-0" onClick={onKeep} onContextMenu={(e) => { e.preventDefault(); onKeep(); }} />
        <div ref={ref} role="alertdialog" aria-label={ask.verdict.title} data-menu-layer
          className="fixed flex flex-col gap-2 rounded-xl p-3"
          style={{
            top: pos?.top ?? 0, left: pos?.left ?? 0, width: 292, visibility: pos ? "visible" : "hidden",
            background: "var(--surface-card)", border: tintEdge("var(--error)", 30),
            boxShadow: "var(--surface-lift), 0 18px 44px -14px var(--shadow)",
          }}>
          <div className="flex flex-col gap-0.5">
            <span className="text-[12px] font-semibold" style={{ color: "var(--text)" }}>{ask.verdict.title}</span>
            <span className="text-[11.5px] leading-snug" style={{ color: "var(--text2)" }}>{ask.verdict.body}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="compact" tone="danger" onClick={onStop}>{ask.verdict.stop}</Button>
            <Button size="compact" tone="plain" buttonRef={keepBtn} onClick={onKeep}>Keep it</Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/** Rendered inside the pane area: it is the Terminal's own note, not the app's. */
export function ReopenToast({ toast, onReopen, onDismiss }: { toast: ClosedToast; onReopen: () => void; onDismiss: () => void }) {
  const [held, setHeld] = useState(false);
  // The parent hands a new onDismiss on every render, and the Terminal
  // re-renders constantly; with it in the deps the timer restarted each time
  // and the toast never left. The latest callback is read from a ref instead.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (held) return;
    const t = setTimeout(() => dismiss.current(), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast.n, held]);
  return (
    <div role="status" key={toast.n}
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}
      className="agx-card-in absolute flex items-center gap-3 rounded-xl pl-3 pr-1.5 py-1.5"
      style={{
        left: "50%", translate: "-50% 0", bottom: 56, zIndex: LAYER.pane,
        color: "var(--text)", background: "var(--surface-card)", border: "1px solid var(--surface-line)",
        boxShadow: "var(--surface-lift)",
      }}>
      <span className="text-[11.5px]">{toast.sentence}</span>
      <button type="button" onClick={onReopen}
        className="inline-flex items-center gap-1 rounded-lg px-2 text-[11.5px] font-semibold transition-[background-color,transform] duration-150 active:scale-[0.97] hover:brightness-110 motion-reduce:transition-none"
        style={{ height: 24, color: "var(--text)", background: "var(--surface-inset)" }}>
        <UndoIcon size={ICON.xs} />Reopen
      </button>
      <button type="button" aria-label="Dismiss" onClick={onDismiss}
        className="inline-grid place-items-center rounded-lg transition-[background-color,transform] duration-150 active:scale-[0.97] hover:bg-[var(--surface-inset)] motion-reduce:transition-none"
        style={{ width: HIT, height: HIT, color: "var(--text3)" }}>
        <CloseIcon size={ICON.xs} />
      </button>
    </div>
  );
}
