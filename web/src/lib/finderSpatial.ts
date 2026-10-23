// Arrow keys between the controls of a dialog, by where they are on screen (Strata's modal layer moves focus spatially).
export interface Box { x: number; y: number; w: number; h: number }
export type Way = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

/**
 * The control to focus when `way` is pressed on `from`: among those whose centre lies strictly that way, the nearest, where a miss across the axis costs double so a neighbour in the same row beats a farther one in the next.
 * Ceiling: no wrap, and nothing when there is no control that way (the key then does nothing).
 */
export function spatialNext(boxes: readonly Box[], from: number, way: Way): number | null {
  const f = boxes[from]; if (!f) return null;
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  let best: number | null = null, bestCost = Infinity;
  boxes.forEach((b, i) => {
    if (i === from) return;
    const dx = b.x + b.w / 2 - cx, dy = b.y + b.h / 2 - cy;
    const [along, across] = way === "ArrowLeft" ? [-dx, dy] : way === "ArrowRight" ? [dx, dy] : way === "ArrowUp" ? [-dy, dx] : [dy, dx];
    if (along <= 0.5) return;
    const cost = along + 2 * Math.abs(across);
    if (cost < bestCost) { best = i; bestCost = cost; }
  });
  return best;
}
