import { useEffect, useRef, useState, type RefObject } from "react";

type Box = { top: number; bottom: number; left: number; right: number };

/**
 * How much of a panel's bottom to leave empty so floating furniture (the bench
 * button, `data-floating-furniture`) never sits on its content. Only furniture
 * inside the panel's lower half counts: one parked at the top is the header's
 * business, and reserving for it would empty the whole panel.
 */
export function furnitureFloor(panel: Box, furniture: readonly Box[], gap = 8): number {
  let floor = 0;
  for (const f of furniture) {
    const across = f.right > panel.left && f.left < panel.right;
    const low = f.bottom > (panel.top + panel.bottom) / 2 && f.top < panel.bottom;
    if (across && low) floor = Math.max(floor, panel.bottom - f.top + gap);
  }
  return Math.max(0, Math.round(floor));
}

/** The floor for the element's parent (the panel), re-measured when it or the window resizes, or the button is dragged. */
export function useFurnitureFloor<T extends HTMLElement>(deps: readonly unknown[]): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [floor, setFloor] = useState(0);
  useEffect(() => {
    const panel = () => ref.current?.parentElement ?? null;
    const measure = () => {
      const p = panel();
      if (!p) return;
      setFloor(furnitureFloor(p.getBoundingClientRect(), [...document.querySelectorAll("[data-floating-furniture]")].map((e) => e.getBoundingClientRect())));
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const p = panel();
    if (p) ro?.observe(p);
    window.addEventListener("resize", measure);
    window.addEventListener("pointerup", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("pointerup", measure); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [ref, floor];
}
