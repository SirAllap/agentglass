import type { CanvasNode, CanvasScene } from "../../../shared/pluginCanvas.ts";

/**
 * A plugin can change a prop sixty times a second (the bucket is 60 ops/s), and
 * some props are large: an orb 600 units across, a lit band, a halo, a whole
 * sheet's material. Each is a STATE, not an animation, so `prefers-reduced-
 * motion` never touched them, and a plugin could flash a big area at 10 Hz
 * (WCAG 2.3.1 allows 3 a second).
 *
 * The window therefore draws a node's luminance-bearing props at most once per
 * `minMs`, newest wins. The scene itself stays exact: this is a render
 * throttle on a copy, and structure (a node added, moved, removed) is never
 * held back. Pure on purpose: a test drives it with a fake clock.
 */

export const LUMA_PROPS = ["tone", "state", "lit", "halo", "light", "terminator", "material", "shape", "activity", "leg", "on", "selected", "here", "badgeTone", "sealed"] as const;
/** Between two changes of the same node's luminance props: 400 ms (2.5 a second), 1 s under reduced motion. */
export const LUMA_MS = 400;
export const LUMA_MS_REDUCED = 1000;

export interface GateState {
  /** What is drawn now. */
  shown: CanvasScene;
  /** When each node's luminance props last took a new value. */
  at: ReadonlyMap<string, number>;
}

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export function gateScene(prev: GateState | undefined, scene: CanvasScene, now: number, minMs: number): { state: GateState; nextAt: number | undefined } {
  const was = new Map<string, CanvasNode>((prev?.shown ?? []).map((n) => [n.id, n] as const));
  const at = new Map<string, number>();
  let nextAt: number | undefined;
  const shown = scene.map((n) => {
    const old = was.get(n.id);
    const last = prev?.at.get(n.id);
    if (!old || last === undefined) { at.set(n.id, now); return n; }
    const differs = LUMA_PROPS.filter((k) => !same(old[k], n[k]));
    if (differs.length === 0) { at.set(n.id, last); return n; }
    if (now - last >= minMs) { at.set(n.id, now); return n; }
    // Held: everything the plugin changed except the luminance props that already changed a moment ago.
    at.set(n.id, last);
    const due = last + minMs;
    nextAt = nextAt === undefined ? due : Math.min(nextAt, due);
    return mergeKeep(n, old);
  });
  return { state: { shown, at }, nextAt };
}

/** `n` with the luminance props `old` had. The same object when they are all equal. */
function mergeKeep(n: CanvasNode, old: CanvasNode): CanvasNode {
  let out: CanvasNode | undefined;
  for (const k of LUMA_PROPS) {
    if (same(old[k], n[k])) continue;
    out ??= { ...n };
    if (k in old) out[k] = old[k]; else delete out[k];
  }
  return out ?? n;
}
