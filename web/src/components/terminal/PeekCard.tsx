/*
 * The card that says what a window is, when the pointer rests on its tab.
 *
 * Name, project, the Alt number that jumps to it, the branch (and its pull
 * request when the panel knows it), and one sentence for its state. It draws
 * over the pane, never beside it, and takes no pointer events: it is a label,
 * not a place to go, so the pointer can leave the tab through it.
 *
 * The timing is lib/peekCard.ts. This file owns the one setTimeout and the
 * window listeners that put the card away; nothing here polls.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LAYER } from "../../lib/layers.ts";
import { PEEK_HIDE_EVENTS, PEEK_IDLE, peekEnter, peekFire, peekHide, type PeekState } from "../../lib/peekCard.ts";
import { BranchIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import type { Mark } from "../../lib/windowMark.ts";
import { Portal } from "../Portal.tsx";
import { WindowMarkIcon } from "./WindowMarkIcon.tsx";
import { EDGE } from "../workspace/Chrome.tsx";

export interface PeekFacts {
  name: string;
  project: string | null;
  /** The Alt+N that jumps here, when the window has a number. */
  number: number | null;
  branch: string | null;
  /** "#318 open" and the like; null when the panel has no pull request for it. */
  pr: string | null;
  sentence: string;
  /** The window's mark and its words, so the card opens with the same sign the tab wears. */
  mark?: { kind: Mark; label: string } | null;
}

const GAP = 6;
const MARGIN = 8;
const WIDTH = 260;

/** Which tab the pointer is on and whether its card is up. Listeners hang off the strip's tablist element. */
export function usePeek(el: HTMLElement | null): { id: string | null; warm: boolean; rect: DOMRect | null } {
  const [state, setState] = useState<PeekState>(PEEK_IDLE);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const ref = useRef(state);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const put = useCallback((s: PeekState) => { ref.current = s; setState(s); }, []);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  const hide = useCallback(() => {
    clear();
    put(peekHide(ref.current, Date.now()));
    setRect(null);
  }, [put]);

  useEffect(() => {
    if (!el) return;
    const tabOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>('[role="tab"][data-window]') : null);
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const tab = tabOf(e.target);
      const id = tab?.dataset.window ?? null;
      if (!tab || !id) { hide(); return; }
      if (ref.current.id === id) return;
      clear();
      const { state: next, wait } = peekEnter(ref.current, id, Date.now());
      put(next);
      setRect(tab.getBoundingClientRect());
      if (wait > 0) timer.current = setTimeout(() => { timer.current = null; put(peekFire(ref.current, id)); }, wait);
    };
    el.addEventListener("pointerover", over);
    el.addEventListener("pointerleave", hide);
    for (const ev of PEEK_HIDE_EVENTS) window.addEventListener(ev, hide, { capture: true, passive: true });
    window.addEventListener("blur", hide);
    return () => {
      el.removeEventListener("pointerover", over);
      el.removeEventListener("pointerleave", hide);
      for (const ev of PEEK_HIDE_EVENTS) window.removeEventListener(ev, hide, { capture: true });
      window.removeEventListener("blur", hide);
      clear();
    };
  }, [el, hide, put]);

  return { id: state.shown ? state.id : null, warm: state.warm, rect };
}

export function PeekCard({ facts, rect, warm }: { facts: PeekFacts; rect: DOMRect; warm: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    const below = rect.bottom + GAP;
    // Under the tab; above it when there is no room below (a strip docked low).
    const top = below + h + MARGIN > window.innerHeight ? Math.max(MARGIN, rect.top - GAP - h) : below;
    setPos({ left: Math.max(MARGIN, Math.min(rect.left, window.innerWidth - WIDTH - MARGIN)), top });
  }, [rect, facts.sentence]);
  const meta = [facts.branch, facts.pr].filter(Boolean).join(" · ");
  return (
    <Portal z={LAYER.menu}>
      <div ref={box} role="tooltip"
        className="fixed rounded-xl px-3 py-2 flex flex-col gap-1 text-[11px] leading-snug"
        style={{
          left: pos?.left ?? 0, top: pos?.top ?? 0, width: WIDTH, pointerEvents: "none",
          visibility: pos ? "visible" : "hidden",
          background: "var(--surface-card)", border: EDGE, color: "var(--text2)",
          boxShadow: "var(--surface-lift), 0 18px 44px -14px var(--shadow)",
          transformOrigin: "top left",
          animation: warm ? undefined : "agx-peek-in 120ms cubic-bezier(0.23, 1, 0.32, 1)",
        }}>
        <div className="flex items-center gap-2 min-w-0">
          {facts.mark && <WindowMarkIcon mark={facts.mark.kind} label={facts.mark.label} />}
          <span className="min-w-0 break-all font-semibold text-[12px]" style={{ color: "var(--text)" }}>{facts.name}</span>
          {facts.project && <span className="truncate text-[11px]" style={{ color: "var(--text3)" }}>· {facts.project}</span>}
          {facts.number !== null && (
            <kbd className="ml-auto shrink-0 text-[10.5px] px-1 rounded" style={{ background: "var(--surface-inset)", color: "var(--text3)" }}>Alt+{facts.number}</kbd>
          )}
        </div>
        {meta && (
          <div className="flex items-center gap-1.5 min-w-0 text-[10.5px] font-mono" style={{ color: "var(--text3)" }}>
            {facts.branch && <BranchIcon size={ICON.xs} />}<span className="truncate">{meta}</span>
          </div>
        )}
        <div style={facts.mark?.kind === "needs-you" ? { color: "var(--warning-ink)", fontWeight: 600 } : undefined}>{facts.sentence}</div>
      </div>
    </Portal>
  );
}
