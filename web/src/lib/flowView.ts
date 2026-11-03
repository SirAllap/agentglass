/*
 * Where things go on the Flow canvas, as numbers: block places, arrow routes,
 * the fitted view, the minimap and which screen state a load is in. Pure, so
 * the geometry is asserted without a renderer; the canvas only paints it.
 *
 * Measured on the approved mockup: a block is 228 x 168, the gap between two is
 * 40, rows are 74 apart (56 on a short window). A failing arrow leaves the gap
 * left of its own block, runs along a lane under every row and comes up the gap
 * left of its target, because that gap is the one column empty in every row;
 * the centre line of the target drew through the cards of the rows between.
 *
 * Its ceiling, stated: a place a person dragged a block to is kept, but the
 * routes of the arrows assume rows of blocks, so a block dragged far off the
 * rows can be crossed by a line. Free routing is the next thing after this.
 */
import type { Flow, FlowBlock } from "../../../shared/flow.ts";

export const BLOCK_W = 296;
export const BLOCK_H = 316;
export const BLOCK_GAP = 40;
export const CANVAS_PAD = 40;
export const ORCH_W = 560;
export const ORCH_H = 236;
/** How far under the pass arrow's line a loop's wire enters and leaves a block. */
const FAIL_DY = 16;

/** Where the first row starts: under the orchestrator's card. */
export const ROWS_TOP = 276;
export const LANE_STEP = 28;
export const ZOOM_MIN = 0.35;
export const ZOOM_MAX = 1.8;
/** The lowest zoom an automatic fit may pick: below it a card stops reading at
 *  the mockup's size, so a wider drawing scrolls instead. The "Fit" button
 *  still goes down to the whole drawing. */
export const FIT_FLOOR = 0.82;

export const rowGap = (windowHeight: number): number => (windowHeight <= 760 ? 56 : 74);

export interface Place { x: number; y: number }
export interface Layout {
  places: Map<string, Place>;
  /** Width of the widest row, at least the orchestrator's. */
  contentW: number;
  perRow: number;
  rowGap: number;
}

/**
 * The places of the path's blocks for a canvas `width` wide. A block the flow
 * already has a place for keeps it; the others are laid out in rows that are
 * balanced (6 becomes 3 + 3, 5 becomes 3 + 2) instead of leaving one block
 * alone under a full row.
 */
export function layoutBlocks(flow: Flow, width: number, windowHeight: number): Layout {
  const path = flow.path;
  const gap = rowGap(windowHeight);
  const usable = width - CANVAS_PAD * 2;
  const raw = Math.max(2, Math.min(Math.max(path.length, 1), Math.floor((usable + BLOCK_GAP) / (BLOCK_W + BLOCK_GAP))));
  const rowCount = Math.ceil(path.length / raw) || 1;
  const perRow = rowCount > 1 ? Math.ceil(path.length / rowCount) : raw;
  const rowW = (n: number) => n * BLOCK_W + (n - 1) * BLOCK_GAP;
  const contentW = Math.max(rowW(Math.min(perRow, Math.max(path.length, 1))), ORCH_W);
  const kept = new Map<string, FlowBlock>(flow.blocks.map((b) => [b.id, b]));
  const places = new Map<string, Place>();
  path.forEach((id, i) => {
    const saved = kept.get(id);
    if (saved) { places.set(id, { x: saved.x, y: saved.y }); return; }
    const r = Math.floor(i / perRow), c = i % perRow;
    const inRow = Math.min(perRow, path.length - r * perRow);
    places.set(id, { x: CANVAS_PAD + (contentW - rowW(inRow)) / 2 + c * (BLOCK_W + BLOCK_GAP), y: ROWS_TOP + r * (BLOCK_H + gap) });
  });
  return { places, contentW, perRow, rowGap: gap };
}

export interface Pt { x: number; y: number }

/** Where the orchestrator's box starts: at the left of the drawing, over the first block, as the mockup draws it. */
export const orchX = (_lay: Layout): number => CANVAS_PAD;

export interface Wires {
  /** One polyline per neighbouring pair, in path order. */
  passes: { from: string; to: string; points: Pt[] }[];
  /** One per failing arrow that goes back along the path. */
  fails: { from: string; to: string; points: Pt[]; rounds: number; label: Pt }[];
  /** The orchestrator's dashed line to the blocks that must run: a spine under
   *  the card and one drop per block, ending in a dot on its top edge. */
  trunk: { spine: Pt[]; drops: { x: number; from: number; to: number }[] };
  laneTop: number;
  width: number;
  height: number;
}

const bottomOf = (places: Map<string, Place>): number => {
  let m = ROWS_TOP;
  for (const p of places.values()) m = Math.max(m, p.y + BLOCK_H);
  return m;
};

/** Arrow routes for the places the layout gave. */
export function routeWires(flow: Flow, lay: Layout): Wires {
  const { places } = lay;
  const laneTop = bottomOf(places) + 30;
  const passes: Wires["passes"] = [];
  for (let i = 0; i < flow.path.length - 1; i++) {
    const fromId = flow.path[i]!, toId = flow.path[i + 1]!;
    const a = places.get(fromId), z = places.get(toId);
    if (!a || !z) continue;
    if (Math.abs(a.y - z.y) < 8) {
      const y = a.y + BLOCK_H / 2;
      passes.push({ from: fromId, to: toId, points: [{ x: a.x + BLOCK_W + 2, y }, { x: z.x - 8, y }] });
    } else {
      const midY = a.y + BLOCK_H + lay.rowGap / 2 - 4;
      passes.push({
        from: fromId, to: toId,
        points: [{ x: a.x + BLOCK_W / 2, y: a.y + BLOCK_H + 2 }, { x: a.x + BLOCK_W / 2, y: midY }, { x: z.x + BLOCK_W / 2, y: midY }, { x: z.x + BLOCK_W / 2, y: z.y - 5 }],
      });
    }
  }
  const fails: Wires["fails"] = [];
  const goingBack = flow.edges.filter((e) => e.on === "fail" && flow.path.indexOf(e.to) >= 0 && flow.path.indexOf(e.to) < flow.path.indexOf(e.from));
  goingBack.forEach((e, i) => {
    const a = places.get(e.from), t = places.get(e.to);
    if (!a || !t) return;
    const laneY = laneTop + i * LANE_STEP;
    const gxA = Math.max(a.x - 18, 6), gxT = Math.max(t.x - 18, 6);
    // 16px under the pass arrow's line, so the loop's arrow and its exit run parallel to it instead of on top of it.
    const ay = a.y + BLOCK_H / 2 + FAIL_DY, ty = t.y + BLOCK_H / 2 + FAIL_DY;
    fails.push({
      from: e.from, to: e.to, rounds: e.maxRounds ?? 1,
      points: [{ x: a.x - 2, y: ay }, { x: gxA, y: ay }, { x: gxA, y: laneY }, { x: gxT, y: laneY }, { x: gxT, y: ty }, { x: t.x - 7, y: ty }],
      label: { x: (gxA + gxT) / 2, y: laneY },
    });
  });
  // The connector leaves the card under its hub, so it starts where the orchestrator is drawn, not at the drawing's middle.
  const hubX = orchX(lay) + 70;
  const by = ORCH_H + 18;
  const xs = [...new Set(flow.path.flatMap((id) => {
    const p = places.get(id);
    return p && flow.roster.find((r) => r.id === id)?.required ? [p.x + BLOCK_W / 2] : [];
  }))].sort((a, b) => a - b);
  const trunk = xs.length
    ? { spine: [{ x: hubX, y: ORCH_H }, { x: hubX, y: by }, { x: xs[xs.length - 1]!, y: by }], drops: xs.map((x) => ({ x, from: by, to: ROWS_TOP - 3 })) }
    : { spine: [], drops: [] };
  let right = lay.contentW + CANVAS_PAD * 2;
  for (const p of places.values()) right = Math.max(right, p.x + BLOCK_W + 60);
  return {
    passes, fails, laneTop, trunk,
    width: Math.max(right, 900),
    height: laneTop + Math.max(fails.length, 1) * LANE_STEP + 40,
  };
}

export interface Bounds { x0: number; x1: number; y0: number; y1: number }

/** The box the whole drawing takes: orchestrator, blocks and the lanes under them. */
export function drawingBounds(flow: Flow, lay: Layout): Bounds {
  const ox = orchX(lay);
  const xs: number[] = [ox, ox + ORCH_W];
  let y1 = ORCH_H;
  for (const p of lay.places.values()) { xs.push(p.x, p.x + BLOCK_W); y1 = Math.max(y1, p.y + BLOCK_H); }
  if (flow.path.length) {
    const fails = flow.edges.filter((e) => e.on === "fail").length;
    y1 = Math.max(y1, bottomOf(lay.places) + 30 + Math.max(1, fails) * LANE_STEP);
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: 0, y1 };
}

export interface View { zoom: number; pan: Pt }

const clampZoom = (z: number): number => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** Fit the drawing in a stage: never larger than 100 %, never smaller than `floor`
 *  (the manual zoom-out floor by default), centred. */
export function fitView(b: Bounds, stage: { w: number; h: number }, floor: number = ZOOM_MIN): View {
  const z = Math.max(floor, clampZoom(Math.min(1, (stage.w - 70) / Math.max(1, b.x1 - b.x0), (stage.h - 70) / Math.max(1, b.y1 - b.y0))));
  // At the floor a wide drawing is wider than the stage: it starts at its own left edge instead of being cut on both sides.
  const w = (b.x1 - b.x0) * z, h = (b.y1 - b.y0) * z;
  const x = w <= stage.w ? (stage.w - w) / 2 : 0;
  const y = h <= stage.h ? (stage.h - h) / 2 : 0;
  return { zoom: z, pan: { x: x - b.x0 * z, y: y - b.y0 * z } };
}

/** Zoom about a point of the stage so the thing under the pointer stays under it. */
export function zoomAbout(v: View, at: Pt, factor: number): View {
  const z = clampZoom(v.zoom * factor);
  return { zoom: z, pan: { x: at.x - (at.x - v.pan.x) * (z / v.zoom), y: at.y - (at.y - v.pan.y) * (z / v.zoom) } };
}

/** A pointer on the stage, in the drawing's own coordinates. */
export const toWorld = (v: View, p: Pt): Pt => ({ x: (p.x - v.pan.x) / v.zoom, y: (p.y - v.pan.y) / v.zoom });

export interface MiniRect { x: number; y: number; w: number; h: number; id?: string }

/** The minimap's rectangles for a box `w` x `h`, and the frame of what the stage shows now, kept inside the box. */
export function miniMap(flow: Flow, lay: Layout, view: View, stage: { w: number; h: number }, box: { w: number; h: number }): { orch: MiniRect; blocks: MiniRect[]; frame: MiniRect | null } {
  const b = drawingBounds(flow, lay);
  const pad = 8, top = 14;
  const W = Math.max(120, box.w), H = Math.max(80, box.h);
  const s = Math.min((W - pad * 2) / Math.max(1, b.x1 - b.x0), (H - pad * 2 - 10) / Math.max(1, b.y1 - b.y0));
  const ox = (W - (b.x1 - b.x0) * s) / 2 - b.x0 * s;
  const oy = top + (H - top - (b.y1 - b.y0) * s) / 2 - b.y0 * s;
  const blocks = flow.path.flatMap((id) => {
    const p = lay.places.get(id);
    return p ? [{ id, x: ox + p.x * s, y: oy + p.y * s, w: BLOCK_W * s, h: BLOCK_H * s }] : [];
  });
  const vx = -view.pan.x / view.zoom, vy = -view.pan.y / view.zoom;
  const rx = Math.max(pad, ox + vx * s), ry = Math.max(top, oy + vy * s);
  const rw = Math.min(W - pad, ox + (vx + stage.w / view.zoom) * s) - rx;
  const rh = Math.min(H - pad, oy + (vy + stage.h / view.zoom) * s) - ry;
  return {
    orch: { x: ox + orchX(lay) * s, y: oy, w: ORCH_W * s, h: ORCH_H * s },
    blocks,
    frame: rw > 6 && rh > 6 ? { x: rx, y: ry, w: rw, h: rh } : null,
  };
}

/**
 * Where a dragged block lands in the path: the index it would take among the
 * other blocks, by the point (in drawing coordinates) it is dropped at. Rows
 * first (the row whose band the point is in), then left to right inside it.
 */
export function dropIndex(flow: Flow, lay: Layout, draggedId: string, at: Pt): number {
  const others = flow.path.filter((id) => id !== draggedId && lay.places.has(id));
  let index = 0;
  for (const id of others) {
    const p = lay.places.get(id)!;
    const sameRow = at.y >= p.y - lay.rowGap / 2 && at.y <= p.y + BLOCK_H + lay.rowGap / 2;
    const before = at.y < p.y - lay.rowGap / 2 || (sameRow && at.x < p.x + BLOCK_W / 2);
    if (before) break;
    index++;
  }
  return index;
}

export type FlowLoad =
  | { state: "loading" }
  | { state: "failed"; error: string }
  | { state: "loaded"; flow: Flow | null };

/** Which of the four screens a load is: the error and the empty one are states of their own, not a blank. */
export function flowViewState(load: FlowLoad | null | undefined): "loading" | "error" | "empty" | "ready" {
  if (!load || load.state === "loading") return "loading";
  if (load.state === "failed") return "error";
  return load.flow && load.flow.path.length > 0 ? "ready" : "empty";
}

/**
 * A natural arrangement: the path as one river that rises and dips, every block after the one it
 * follows. The wave is 70 high and the step is a full block plus a gap, so two blocks never touch.
 * It is a choice of places, saved like a hand-placed flow; "Tidy up" goes back to the grid.
 */
export function organicBlocks(flow: Flow): FlowBlock[] {
  return flow.path.map((id, i) => ({ id, x: Math.round(CANVAS_PAD + i * (BLOCK_W + BLOCK_GAP * 1.3)), y: Math.round(ROWS_TOP + 110 + 70 * Math.sin(i * 1.05) + (i % 2 ? 12 : -12)) }));
}
