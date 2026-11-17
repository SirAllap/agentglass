/*
 * The panel's own buttons, drawn in the card header's top-right as ONE group of equal bordered squares, the way the mockup has
 * them: a grip (drag the window; from the dock, a pull far enough lifts it out into a floating window), the side panel, pop out
 * and maximize. Float and a strip under the board have no square of their own: they are rows of the header's "..." menu (and
 * Ctrl+Shift+D cycles all four). The dock gives the props through DockChromeCtx; a card opened outside the dock gets no group.
 */
import { createContext, useContext, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { DockIcon } from "../DockParts.tsx";
import { ExpandIcon, GripIcon } from "../../../lib/glyphIcons.tsx";
import { tipAttr } from "../../../lib/tip.ts";
import { ICON } from "../../../lib/iconSize.ts";
import type { DockMode } from "../../../lib/jiraDockMode.ts";

export interface DockChromeProps {
  mode: DockMode;
  maximized: boolean;
  onMode: (m: DockMode) => void;
  onMax: () => void;
  /** The grip moved the window: the pointer's offset from where the drag began, and whether it is the first move. */
  onDrag: (dx: number, dy: number, first: boolean) => void;
  onDragEnd: () => void;
  /** Arrow keys on the grip: move a floating window by this much. */
  onNudge: (dx: number, dy: number) => void;
}

export const DockChromeCtx = createContext<DockChromeProps | null>(null);
export const useDockChrome = () => useContext(DockChromeCtx);

const Box = ({ side }: { side: "right" | "free" | "over" | "bottom" }) => (
  <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {side === "right" && <><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" /><path d="M8.5 2.5v9" /></>}
    {side === "free" && <><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" strokeDasharray="2 2" /><rect x="5" y="5" width="6" height="5" rx="1" /></>}
    {side === "over" && <><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" /><rect x="3.5" y="4.5" width="7" height="5" rx="1" /></>}
    {side === "bottom" && <><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" /><path d="M1.5 7.5h11" /></>}
  </svg>
);

const DRAG_FROM = 6;

export function DockChrome({ mode, maximized, onMode, onMax, onDrag, onDragEnd, onNudge, children }: DockChromeProps & { children?: ReactNode }) {
  const from = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const down = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    from.current = { x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const f = from.current;
    if (!f) return;
    const dx = e.clientX - f.x, dy = e.clientY - f.y;
    if (!f.moved && Math.hypot(dx, dy) < DRAG_FROM) return;
    const first = !f.moved;
    f.moved = true;
    onDrag(dx, dy, first);
  };
  const up = () => { if (from.current?.moved) onDragEnd(); from.current = null; };
  const key = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 40 : 10;
    const d = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
    if (!d) return;
    e.preventDefault();
    onNudge(d[0]!, d[1]!);
  };
  const place = (m: DockMode, name: string, text: string, side: "right" | "free" | "over" | "bottom") => (
    <DockIcon key={m} tip={{ name, text }} on={mode === m} onClick={() => onMode(m)}><Box side={side} /></DockIcon>
  );
  return (
    <span className="agx-jdk-btns" data-slot="dock-chrome" role="group" aria-label="Panel">
      <button type="button" className="agx-jdk-grip" data-tip={tipAttr("Drag to move the panel (arrow keys too)")} aria-label="Move panel" data-mode={mode}
        disabled={mode === "pop" || mode === "bottom" || maximized}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}>
        <GripIcon size={ICON.sm} />
      </button>
      {place("dock", "Dock right", "Beside the board", "right")}
      {place("pop", "Pop out", "Over the board. Esc returns it.", "over")}
      <DockIcon tip={{ name: maximized ? "Restore size" : "Maximize", text: "Press f inside the panel" }} on={maximized} onClick={onMax}>
        <ExpandIcon size={ICON.sm} shrink={maximized} />
      </DockIcon>
      {children}
    </span>
  );
}
