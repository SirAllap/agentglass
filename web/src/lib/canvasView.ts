import { useEffect, useRef, useState, type RefObject } from "react";
import type { CanvasScene } from "../../../shared/pluginCanvas.ts";
import { CANVAS_LIMITS } from "../../../shared/pluginCanvas.ts";

/**
 * What the window decides about a sheet and a fold that no plugin can: how
 * wide the panel is, how far an opening has got, and how a moon travels from
 * one angle to the next. The numbers are pure functions (tested); the hooks
 * only schedule them.
 */

/** Below this panel width the sheet is the narrow one and the facts stack under it. The PANEL's width, not the viewport's. */
export const NARROW_PX = 900;
export const OPEN_MS = 180;
export const CLOSE_MS = 120;
/** A moon takes this long to travel to a new angle. */
export const TRAVEL_MS = 420;

export const easeOut = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

export const fitOf = (panelWidth: number): "wide" | "narrow" => (panelWidth < NARROW_PX ? "narrow" : "wide");

/** The way round a moon takes from angle `a` to `b`: forward (clockwise) when that is the shorter, otherwise back. */
export function angleBetween(a: number, b: number, t: number): number {
  let d = (((b - a) % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return ((a + d * Math.min(1, Math.max(0, t))) % 360 + 360) % 360;
}

/** The panel's width, watched: the sheet shown is the one whose `fit` matches. */
export function usePanelFit(ref: RefObject<HTMLElement>): "wide" | "narrow" {
  const [fit, setFit] = useState<"wide" | "narrow">("wide");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setFit(fitOf(el.getBoundingClientRect().width));
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver((entries) => { for (const e of entries) setFit(fitOf(e.contentRect.width)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return fit;
}

/**
 * How far a fold has opened, 0..1, eased. One requestAnimationFrame loop for
 * at most OPEN_MS; a hidden window or reduced motion jumps to the end in the
 * same frame. The raw progress moves linearly and the eased phase is
 * `easeOut(progress)`, so closing is the opening played backwards.
 */
export function useFoldPhase(open: boolean, reduced: boolean): number {
  const target = open ? 1 : 0;
  const [u, setU] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    if (cur.current === target) return;
    if (reduced || (typeof document !== "undefined" && document.hidden) || typeof requestAnimationFrame !== "function") { cur.current = target; setU(target); return; }
    const from = cur.current, ms = (target > from ? OPEN_MS : CLOSE_MS) * Math.abs(target - from);
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = ms <= 0 ? 1 : Math.min(1, (now - start) / ms);
      cur.current = from + (target - from) * t;
      setU(cur.current);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced]);
  return easeOut(u);
}

/**
 * The angle each moon is drawn at while it travels to the one the scene says.
 * At most CANVAS_LIMITS.tweens moons travel at once; the rest jump. Under
 * reduced motion, or while nobody looks, every moon jumps.
 */
export function useAtTween(scene: CanvasScene, reduced: boolean, paused: boolean): ReadonlyMap<string, number> {
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(new Map());
  const live = useRef(new Map<string, { from: number; to: number; start: number }>());
  const now = useRef(new Map<string, number>());
  useEffect(() => {
    const targets = new Map<string, number>();
    for (const n of scene) if (n.type === "token" && typeof n.at === "number") targets.set(n.id, n.at);
    for (const id of [...now.current.keys()]) if (!targets.has(id)) { now.current.delete(id); live.current.delete(id); }
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    for (const [id, to] of targets) {
      const was = now.current.get(id);
      if (was === undefined || reduced || paused) { now.current.set(id, to); live.current.delete(id); continue; }
      const going = live.current.get(id);
      if (going && going.to === to) continue;
      if (was === to) { live.current.delete(id); continue; }
      if (live.current.size >= CANVAS_LIMITS.tweens && !going) { now.current.set(id, to); continue; }
      live.current.set(id, { from: was, to, start: t0 });
    }
    if (live.current.size === 0) { setShown(new Map(now.current)); return; }
    let raf = 0;
    const step = (t: number) => {
      for (const [id, a] of live.current) {
        const k = (t - a.start) / TRAVEL_MS;
        now.current.set(id, k >= 1 ? a.to : angleBetween(a.from, a.to, easeOut(k)));
        if (k >= 1) live.current.delete(id);
      }
      setShown(new Map(now.current));
      if (live.current.size > 0) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [scene, reduced, paused]);
  return shown;
}
