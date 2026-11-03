import { useEffect, useRef, useState, type RefObject } from "react";
import { furnitureClearance } from "./diffReview.ts";

/**
 * How far in from the right a bottom bar keeps its content so the floating
 * bench button does not sit on its buttons. The bar's own size changes with the
 * window and the panes around it; the button moves only by a drag, which ends
 * in a pointerup. `deps` re-measures when what the bar holds changes.
 */
export function useFurnitureClear<T extends HTMLElement>(deps: readonly unknown[]): [RefObject<T>, number] {
  const bar = useRef<T>(null);
  const [clear, setClear] = useState(0);
  useEffect(() => {
    const measure = () => {
      const el = bar.current;
      if (!el) return;
      setClear(furnitureClearance(el.getBoundingClientRect(), [...document.querySelectorAll("[data-floating-furniture]")].map((e) => e.getBoundingClientRect())));
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (bar.current) ro?.observe(bar.current);
    window.addEventListener("resize", measure);
    window.addEventListener("pointerup", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("pointerup", measure); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [bar, clear];
}
