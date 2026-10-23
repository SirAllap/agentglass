import { useLayoutEffect, type RefObject } from "react";
import { GAP, placeFlow } from "../lib/settingsFlow.ts";

/** The column each card was given the first time it was placed (settingsFlow.ts: balanced, then stable). */
const COL = new WeakMap<Element, number>();
/** Cards fill in for a moment after mount (lists load); until then the choice is redone, after it a card keeps its column. */
const SETTLE_MS = 800;

/**
 * Lays the page's direct children out with `placeFlow`: one grid row per pixel
 * of height, each child pinned to its own column. Re-run when a child resizes
 * or the list of children changes. `data-stable` is what turns the grid on in
 * index.css, so before the first measurement the old column flow still draws.
 */
export function useStableFlow(ref: RefObject<HTMLElement | null>, deps: readonly unknown[]): void {
  useLayoutEffect(() => {
    const col = ref.current;
    if (!col) return;
    let settled = false;
    const timer = setTimeout(() => { settled = true; place(); }, SETTLE_MS);
    const place = () => {
      const kids = [...col.children] as HTMLElement[];
      const cols = Number(getComputedStyle(col).getPropertyValue("--agx-cols")) || 1;
      const items = kids.map((el) => {
        const cs = getComputedStyle(el);
        const h = el.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0) + GAP;
        return { h, col: COL.get(el), wide: !el.classList.contains("agx-scard") || el.classList.contains("agx-scard-wide") };
      });
      placeFlow(items, cols).forEach((s, i) => {
        const el = kids[i]!;
        if (settled && typeof s.col === "number") COL.set(el, s.col);
        el.style.gridColumn = s.col === "all" ? "1 / -1" : String(s.col);
        el.style.gridRow = `${s.row} / span ${s.span}`;
      });
    };
    col.setAttribute("data-stable", "");
    place();
    const ro = new ResizeObserver(place);
    const watch = () => { ro.disconnect(); ro.observe(col); for (const el of col.children) ro.observe(el); };
    watch();
    const mo = new MutationObserver(() => { watch(); place(); });
    mo.observe(col, { childList: true });
    return () => { clearTimeout(timer); ro.disconnect(); mo.disconnect(); col.removeAttribute("data-stable"); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
