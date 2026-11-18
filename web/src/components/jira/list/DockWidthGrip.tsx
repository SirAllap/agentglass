import { useEffect, useRef, type KeyboardEvent, type MutableRefObject, type PointerEvent, type RefObject } from "react";
import { clampDockResize, DOCK_MIN, dockResizeKey, dockResizeMax } from "./tabsModel.ts";
import { tipAttr } from "../../../lib/tip.ts";

/**
 * The handle on the docked card's left edge, same shape as the pull request panel's (PrPanel's `DockGrip`): while the
 * pointer is down the width is written straight to the dock's own style and the grip's `aria-valuenow`, one write per
 * move, no render of the panel underneath. The width is handed back once, on pointer up; Esc during the drag puts it
 * back; double-click is the computed default.
 */
export function DockWidthGrip({ dock, live, width, rowW, onCommit, onReset }: {
  dock: RefObject<HTMLElement | null>;
  live: MutableRefObject<number | null>;
  width: number;
  rowW: number;
  onCommit: (px: number) => void;
  onReset: () => void;
}) {
  const me = useRef<HTMLDivElement>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const paint = (px: number) => {
    if (dock.current) dock.current.style.width = `${px}px`;
    me.current?.setAttribute("aria-valuenow", String(px));
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* the window listeners still carry the drag */ }
    const x0 = e.clientX, w0 = width;
    const at = (x: number) => clampDockResize(w0 + x0 - x, rowW);
    el.setAttribute("data-dragging", "");
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
    const to = dockResizeKey(e.key, e.shiftKey, width, rowW);
    if (to == null) return;
    e.preventDefault();
    onCommit(to);
  };
  return (
    <div ref={me} role="separator" aria-orientation="vertical" aria-label="Resize the card panel"
      aria-valuenow={width} aria-valuemin={DOCK_MIN} aria-valuemax={dockResizeMax(rowW)} tabIndex={0}
      data-tip={tipAttr({ name: "Resize", text: "Drag to resize. Double-click for the usual width." })}
      className="agx-jdgrip" data-jira-dock-grip
      onPointerDown={down} onDoubleClick={onReset} onKeyDown={key} />
  );
}
