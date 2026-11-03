/*
 * The drag handle on the left edge of the side panel. The width is one value for
 * every panel (block, around the flow, conditions), kept as `--fe-side-w` on the
 * page and remembered per browser; no stored value leaves the CSS clamp in charge.
 */
import { useEffect } from "react";

const KEY = "agx:flow-side-w";
const MIN = 292;

const clampW = (w: number) => Math.round(Math.min(Math.max(w, MIN), Math.max(MIN, window.innerWidth * 0.7)));

export function SideGrip() {
  useEffect(() => {
    try { const w = Number(localStorage.getItem(KEY)); if (w > 0) document.documentElement.style.setProperty("--fe-side-w", `${clampW(w)}px`); } catch { /* no storage: the default width stays */ }
  }, []);
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const right = e.currentTarget.parentElement!.getBoundingClientRect().right;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let last = 0;
    const move = (m: PointerEvent) => { last = clampW(right - m.clientX); document.documentElement.style.setProperty("--fe-side-w", `${last}px`); };
    const up = () => {
      el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
      try { if (last) localStorage.setItem(KEY, String(last)); } catch { /* not remembered */ }
    };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
  };
  const reset = () => { document.documentElement.style.removeProperty("--fe-side-w"); try { localStorage.removeItem(KEY); } catch { /* nothing to forget */ } };
  return <div className="fe-grip" role="separator" aria-orientation="vertical" aria-label="Resize the panel (double-click for the usual width)" onPointerDown={down} onDoubleClick={reset} />;
}
