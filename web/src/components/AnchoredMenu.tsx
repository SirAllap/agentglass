/*
 * The list a dropdown opens, drawn on the body and not inside its trigger.
 *
 * `Menu` (PrPanel) used to render this list as an absolutely positioned child
 * of the trigger's wrapper. That worked until the trigger sat inside something
 * that clips: a comment card is `overflow: hidden`, and the last row of the
 * "More actions" menu ("Hide") was cut off at the card's edge. Every menu of
 * that kind had the same fault, so the fix is in the one place they share.
 *
 * What it does, all of it from ContextMenu and Select rather than new:
 *   - a Portal at LAYER.menu, so no ancestor can clip or bury it;
 *   - placeMenu() for flip and shift, measured after the first layout;
 *   - a full-viewport catcher that closes on click, so the click that
 *     dismisses it does not land on the comment behind;
 *   - menuEventGuards(), so a click or Enter on a row does not bubble through
 *     the React tree to the card that opened it;
 *   - arrows, Home, End, Escape, and focus handed back to the trigger.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Portal } from "./Portal.tsx";
import { useCloseWithOwner } from "../lib/layerOwner.ts";
import { LAYER } from "../lib/layers.ts";
import { menuEventGuards } from "../lib/menuEvents.ts";
import { placeMenu, type Placement } from "../lib/menuPlacement.ts";
import { EDGE } from "./workspace/Chrome.tsx";

const ITEMS = '[role="menuitem"]:not(:disabled)';

export function AnchoredMenu({ anchor, align = "right", minWidth = 216, placeKey, focus, onClose, children }: {
  anchor: RefObject<HTMLElement | null>;
  align?: "left" | "right";
  minWidth?: number;
  /** Changes when the list's content (and so its height) does, so it is placed again against its trigger. */
  placeKey?: string | number;
  /** What takes focus when it opens, when that is not the first item (a search box over the list). */
  focus?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placement | null>(null);
  useCloseWithOwner(onClose, { from: anchor });

  // After the portal is attached, and not in a layout effect: Portal appends its
  // container to the body in an effect, so in a layout effect the list is still
  // detached and measures 0 by 0 — which "fits" everywhere and never flips.
  // (Measured: the menu opened at the trigger's right edge instead of ending
  // there.) A child's effect runs before its parent's, so by the time this one
  // runs the container is in the document. Hidden until then, so the first paint
  // is never a guess.
  useEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const el = ref.current;
    if (!a || !el) return;
    // Natural size: nothing caps the list until this has answered.
    setPos(placeMenu(a, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, align));
  }, [anchor, align, placeKey]);

  // Visible now, so it can take focus; a hidden element cannot.
  useEffect(() => {
    if (!pos) return;
    const first = (focus ? ref.current?.querySelector<HTMLElement>(focus) : null) ?? ref.current?.querySelector<HTMLElement>(ITEMS);
    first?.focus({ preventScroll: true });
  }, [pos === null]);

  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); anchor.current?.querySelector<HTMLElement>("button")?.focus(); return; }
      if (e.key === "Tab") { onClose(); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
      if (!items.length) return;
      e.preventDefault();
      e.stopPropagation();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
        : e.key === "ArrowDown" ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
      items[next]!.focus();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose, anchor]);

  return (
    <Portal z={LAYER.menu}>
      {/* `display: contents`: holds the guards and lays out as nothing. */}
      <div style={{ display: "contents" }} {...menuEventGuards()}>
        {/* Marked, so a surface that dismisses on an outside press (a picker,
            a modal) does not read a press in here as outside it. */}
        <div data-menu-layer className="fixed inset-0" style={{ zIndex: 9998 }}
          onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
        <div ref={ref} role="menu" data-menu-layer data-side={pos?.side}
          className="fixed p-1 rounded-xl flex flex-col gap-px overflow-y-auto agw-noscrollbar"
          style={{
            top: pos?.top ?? 0, left: pos?.left ?? 0, minWidth,
            maxHeight: pos?.maxHeight, zIndex: 9999,
            visibility: pos ? "visible" : "hidden",
            background: "var(--surface-card)",
            border: EDGE,
            boxShadow: "var(--surface-lift), 0 18px 44px -14px var(--shadow)",
          }}>
          {children}
        </div>
      </div>
    </Portal>
  );
}
