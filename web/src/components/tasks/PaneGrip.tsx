/*
 * The detail pane of the Local and GitHub sources: its width, remembered, and the
 * grip on its left edge. The ClickUp and Jira boards draw the same grip inline
 * for their card pane; this is the one the two simpler lists share so the pane
 * drags, snaps back on a double click and moves with the arrow keys the same way.
 *
 * Ceiling: the width is per source, not per window size; a narrower window clamps
 * it on the next drag rather than on resize.
 */
import { useEffect, useRef, useState } from "react";

const DEFAULT_W = 380;
const clamp = (w: number): number => {
  const room = typeof window === "undefined" ? 1100 : window.innerWidth - 420;
  return Math.max(280, Math.min(Math.max(520, Math.min(900, room)), Math.round(w)));
};

export function usePaneWidth(key: string) {
  const [w, setW] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      if (Number.isFinite(saved) && saved > 0) return clamp(saved);
    } catch { /* private mode */ }
    return DEFAULT_W;
  });
  useEffect(() => { try { localStorage.setItem(key, String(w)); } catch { /* private mode */ } }, [key, w]);
  return { width: w, set: (n: number) => setW(clamp(n)), reset: () => setW(DEFAULT_W), nudge: (d: number) => setW((cur) => clamp(cur + d)) };
}

export function PaneGrip({ pane }: { pane: ReturnType<typeof usePaneWidth> }) {
  const dragging = useRef(false);
  return (
    <div role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label="Drag to resize the pane"
      title="Drag to resize · double-click for the usual width"
      onDoubleClick={pane.reset}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); pane.nudge(e.shiftKey ? 40 : 12); }
        else if (e.key === "ArrowRight") { e.preventDefault(); pane.nudge(e.shiftKey ? -40 : -12); }
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pane.reset(); }
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragging.current = true;
        // Measured against the window's right edge, so a dropped move does not leave the pane behind the pointer.
        const right = window.innerWidth;
        const move = (ev: PointerEvent) => { if (dragging.current) pane.set(right - ev.clientX); };
        const up = () => {
          dragging.current = false;
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      className="shrink-0 self-stretch"
      style={{ width: 5, marginLeft: -2, marginRight: -3, cursor: "col-resize", zIndex: 5 }} />
  );
}
