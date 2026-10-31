import { useEffect, useRef, type KeyboardEvent, type MutableRefObject, type PointerEvent, type RefObject } from "react";
import { clampDock, DOCK_MIN_PX, dockKeyWidth, dockMax } from "../../lib/prDock.ts";
import { NO_DRAG } from "../../lib/dragRegion.ts";

/**
 * The handle on the docked detail's left edge.
 *
 * While the pointer is down the width is written straight to the dock's
 * `flex-basis` (and the grip's own aria value): one write per move, no React
 * render of an eight-thousand-line panel, no transition, so the edge is under
 * the pointer 1:1. The width is handed back once, when the pointer goes up.
 * `live` holds the in-flight width so a render that lands mid-drag keeps it.
 *
 * Esc during a drag puts the width back (the grip is not focused while the
 * pointer is down, so the key is heard on the window). Double-click is the usual 620.
 */
export function DockGrip({ dock, live, width, panelPx, onCommit, onReset }: {
  dock: RefObject<HTMLElement | null>;
  live: MutableRefObject<number | null>;
  width: number;
  panelPx: number;
  onCommit: (px: number) => void;
  onReset: () => void;
}) {
  const me = useRef<HTMLDivElement>(null);
  const stop = useRef<(() => void) | null>(null);
  /* A drag still going when the grip goes away (the detail closes, Esc) lets go of its listeners. */
  useEffect(() => () => stop.current?.(), []);
  const paint = (px: number) => {
    if (dock.current) dock.current.style.flexBasis = `${px}px`;
    me.current?.setAttribute("aria-valuenow", String(px));
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* a pointer that is already gone: the window listeners still carry the drag */ }
    const x0 = e.clientX, w0 = width;
    const at = (x: number) => clampDock(w0 + x0 - x, panelPx);
    el.setAttribute("data-dragging", "");
    // On the window, not the grip: capture retargets a real mouse to the grip, but the move must also arrive when it is not (a drag driven by script, a pointer lost to a frame).
    const move = (ev: globalThis.PointerEvent) => { const px = at(ev.clientX); live.current = px; paint(px); };
    const end = (commit: boolean, x: number) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", esc, true);
      stop.current = null; live.current = null;
      el.removeAttribute("data-dragging");
      if (commit) onCommit(at(x)); else paint(w0);
    };
    const up = (ev: globalThis.PointerEvent) => end(true, ev.clientX);
    const cancel = () => end(false, x0);
    const esc = (ev: globalThis.KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); end(false, x0); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", esc, true);
    stop.current = () => end(false, x0);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = dockKeyWidth(e.key, e.shiftKey, width, panelPx);
    if (to == null) return;
    e.preventDefault();
    onCommit(to);
  };
  return (
    <div ref={me} role="separator" aria-orientation="vertical" aria-label="Resize the pull request panel"
      aria-valuenow={width} aria-valuemin={DOCK_MIN_PX} aria-valuemax={dockMax(panelPx)} tabIndex={0}
      title="Drag to resize · double-click for the usual width"
      className="agx-prgrip" style={NO_DRAG} data-pr-dock-grip
      onPointerDown={down} onDoubleClick={onReset} onKeyDown={key} />
  );
}
