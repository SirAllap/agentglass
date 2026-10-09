/**
 * The words a plugin uses to draw an INSTRUMENT: a sheet of fixed width and
 * height holding a body, a tilted ring of stations, a clock round the ring and
 * the fading tail of whatever moves on it. A build farm's rate limiter or a
 * queue's consumers draw the same thing with the same words.
 *
 * It sits beside `board` (a machine of DOM parts) and not inside it: a board
 * is about what is next to what, a sheet is about where on a ring. The plugin
 * says WHAT is at which angle; the app does the projection, the depth, the
 * label columns, the paint and the motion. No colour, no pixel, no path, no
 * gradient, no filter, no URL: the promise pluginCanvas.ts makes, kept for the
 * same reason (the window holds the API token).
 *
 * Why a COST and not only a count of nodes: ten plugin nodes can draw four
 * hundred SVG elements (a ring of 120 ticks, a band of 60 segments, a hatch).
 * `sheetCost` prices every element a node makes, and the reducer refuses a
 * scene over `SHEET_LIMITS.svgNodes` with the number. The window's render test
 * counts the real elements against the same function, so the two cannot drift.
 *
 * Chosen ceilings, each one a thing this vocabulary does NOT do: a view under 15
 * degrees (the ellipse would be a line), more than two planes in a sheet, a
 * sector of a ring that crosses more than one turn, text outside the sheet's
 * box, and anything that takes the pointer except a `dock` and a `fold`'s bar.
 *
 * This file imports no value from pluginCanvas.ts (the reducer imports this
 * one); the node type is a type-only import.
 */
import type { CanvasNode } from "./pluginCanvas.ts";
import {
  CANVAS_LIMITS, SHEET_LIMITS, action, activity, below, bool, idRef, num, oneOf, shortStr, toneCheck, unitStr, type Check,
} from "./canvasChecks.ts";

export const SHEET_TYPES = ["sheet", "fold", "dock", "orb", "plane", "band", "hatch", "ticks", "reticle"] as const;
export type SheetType = (typeof SHEET_TYPES)[number];
export const SHEET_CONTAINERS = ["sheet", "fold", "dock", "plane"] as const;

export const SHEET_FITS = ["wide", "narrow"] as const;
export const TOKEN_SHAPES = ["ring", "dot", "diamond"] as const;
export const LEADERS = ["left", "right", "below", "none"] as const;
export const SHEET_W = { min: 320, max: 1200 } as const;
export const SHEET_H = { min: 200, max: 700 } as const;
export const FOLD_H = { min: 160, max: 760 } as const;
/** A moon is never drawn larger than this, in sheet units, whatever its size and depth. */
export const MOON_MAX_R = 24;
/** `tilt` is the angle the plane is SEEN FROM: 90 is straight above (a circle), 27 is a low view (an ellipse
 *  sin(27) = .454 as tall as it is wide). The ellipse is ry = rx * sin(tilt), so below 15 degrees it would be
 *  a line (at 15 and the smallest rx, 40, it is still 10 units tall) and the plane is refused, not drawn flat. */
export const TILT = { min: 15, max: 90 } as const;

const angle: Check = below(0, 360);
const ratio: Check = num(0.2, 1.6);
const unit01: Check = num(0, 1);

/** `key`: the legend, rebuilt entry by entry so nothing the plugin holds ends up in the scene. */
const key: Check = (v) => {
  if (!Array.isArray(v) || v.length > SHEET_LIMITS.keyEntries) return undefined;
  const out: { shape: string; label: string }[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return undefined;
    const r = e as Record<string, unknown>;
    const shape = oneOf(TOKEN_SHAPES)(r.shape);
    const label = shortStr(r.label);
    if (shape === undefined || label === undefined) return undefined;
    out.push({ shape: shape as string, label: label as string });
  }
  return out;
};

/** `numerals`: up to 4 marks of at most 3 characters, at an angle each. */
const numerals: Check = (v) => {
  if (!Array.isArray(v) || v.length > SHEET_LIMITS.numerals) return undefined;
  const out: { at: number; text: string }[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return undefined;
    const r = e as Record<string, unknown>;
    const at = angle(r.at);
    const text = shortStr(r.text);
    if (at === undefined || text === undefined || (text as string).length < 1 || (text as string).length > 3) return undefined;
    out.push({ at: at as number, text: text as string });
  }
  return out;
};

/** `values`: 1..3 concentric arcs, each 0..1. */
const arcValues: Check = (v) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > 3) return undefined;
  const out: number[] = [];
  for (const n of v) { const x = unit01(n); if (x === undefined) return undefined; out.push(x as number); }
  return out;
};

export const SHEET_SPEC: Record<SheetType, Record<string, Check>> = {
  sheet: { w: num(SHEET_W.min, SHEET_W.max, true), h: num(SHEET_H.min, SHEET_H.max, true), material: oneOf(["plain", "inset"] as const), fit: oneOf(SHEET_FITS), label: shortStr, key },
  fold: { h: num(FOLD_H.min, FOLD_H.max, true), hNarrow: num(FOLD_H.min, FOLD_H.max, true), open: bool, label: shortStr, action },
  dock: { title: shortStr, value: shortStr, unit: unitStr, hint: shortStr, hint2: shortStr, tone: toneCheck, selected: bool, here: bool, leg: activity, action },
  orb: { cx: num(0, SHEET_W.max, true), cy: num(0, SHEET_H.max, true), r: num(8, 300, true), light: angle, bands: num(0, 8, true), terminator: bool, tone: toneCheck, halo: bool },
  plane: { cx: num(0, SHEET_W.max, true), cy: num(0, SHEET_H.max, true), rx: num(40, 600, true), tilt: num(TILT.min, TILT.max), roll: num(-45, 45), depth: unit01, label: shortStr },
  band: { r0: ratio, r1: ratio, from: angle, to: num(0, 720), layer: oneOf(["back", "front", "all"] as const), segments: num(1, SHEET_LIMITS.segments, true), lit: num(0, SHEET_LIMITS.segments, true), tone: toneCheck, halo: bool },
  hatch: { of: idRef, from: angle, to: num(0, 720), gap: num(6, 24, true), angle: below(0, 180) },
  ticks: { count: num(8, SHEET_LIMITS.ticks, true), mark: num(1, SHEET_LIMITS.ticks, true), lit: num(0, 16, true), passed: num(0, SHEET_LIMITS.ticks, true), until: num(0, 8.64e15), period: num(1, 86_400, true), side: oneOf(["out", "in"] as const), numerals, tone: toneCheck },
  reticle: { of: idRef, chip: shortStr },
};

export const SHEET_REQUIRED: Partial<Record<SheetType, string[]>> = {
  sheet: ["w", "h", "fit"], fold: ["h"], dock: ["title"], orb: ["cx", "cy", "r"], plane: ["cx", "cy", "rx", "tilt"],
  band: ["r0", "r1", "from", "to"], hatch: ["of", "from", "to", "gap"], ticks: ["count"], reticle: ["of"],
};

/** Props an existing type gains. Where each may live is `contextError`'s business. */
export const TOKEN_EXTRA: Record<string, Check> = {
  at: angle, shape: oneOf(TOKEN_SHAPES), halo: bool, trail: num(0, SHEET_LIMITS.trail, true), trailSpan: num(5, 120),
  leader: oneOf(LEADERS), value: shortStr, unit: unitStr,
};
export const EDGE_EXTRA: Record<string, Check> = { breakAt: unit01, breakGap: num(0.02, 0.5) };
export const GAUGE_EXTRA: Record<string, Check> = { mark: unit01, values: arcValues };
export const GAUGE_SHAPES = ["ticks", "segments"] as const;

/** Props only a `fold` has and that a `set` may never change: the window owns
 *  `open` after the first draw, and a height that moves is a control that
 *  moves. `hNarrow` is the height when the panel is narrow (the sheet and its
 *  facts stack), chosen once like `h`. */
export const ADD_ONLY: Partial<Record<string, readonly string[]>> = { fold: ["h", "hNarrow", "open"] };

/** What a token may carry only inside a plane (and what it must carry there). */
export const IN_PLANE_ONLY = ["at", "shape", "halo", "trail", "trailSpan", "leader", "value", "unit"] as const;

type Node = Pick<CanvasNode, "id" | "type"> & Record<string, unknown>;
type Parent = Pick<CanvasNode, "id" | "type"> | undefined;

/** Where a sheet type may be written, for add and move alike. */
export function sheetPlaceError(n: Node, parent: Parent): string | undefined {
  const pt = parent?.type;
  switch (n.type) {
    case "sheet": if (pt !== undefined && pt !== "stack" && pt !== "row" && pt !== "fold") return "a sheet lives at the root or in a stack, row or fold"; break;
    case "fold": if (pt !== undefined && pt !== "stack" && pt !== "row") return "a fold lives at the root or in a stack or row"; break;
    case "dock": if (pt !== undefined && pt !== "stack" && pt !== "row") return "a dock lives at the root or in a stack or row"; break;
    case "orb": case "plane": case "hatch": if (pt !== "sheet") return `${n.type === "orb" ? "an orb" : "a " + n.type} lives directly in a sheet`; break;
    case "band": case "ticks": case "reticle": if (pt !== "plane") return `a ${n.type} lives directly in a plane`; break;
  }
  if (pt === "sheet" && n.type !== "orb" && n.type !== "plane" && n.type !== "hatch") return "a sheet holds only orbs, planes and hatches";
  if (pt === "plane" && n.type !== "token" && n.type !== "edge" && n.type !== "band" && n.type !== "ticks" && n.type !== "reticle") return "a plane holds only tokens, edges, bands, ticks and a reticle";
  if (pt === "dock" && n.type !== "gauge") return "a dock holds only a gauge";
  if (pt === "fold" && (n.type === "fold" || n.type === "board" || n.type === "part")) return `a fold cannot hold a ${n.type}`;
  return undefined;
}

/** What a node may say given where it sits: checked on the MERGED node in add,
 *  set and move, so a token cannot leave a plane with an angle it no longer has
 *  a ring for, nor enter one without. */
export function contextError(n: Node, parent: Parent): string | undefined {
  const inPlane = parent?.type === "plane";
  if (n.type === "token") {
    if (inPlane) { if (n.at === undefined) return `token ${n.id} in a plane needs at`; return undefined; }
    for (const k of IN_PLANE_ONLY) if (n[k] !== undefined) return `${k} is a property of a token in a plane`;
    if (n.size === "lg") return "size lg is for a token in a plane";
  }
  if (n.type === "edge") {
    if (inPlane) {
      if (n.points !== undefined) return "an edge in a plane follows the plane; it has no points";
      if (n.label !== undefined) return "an edge in a plane is not labelled";
    } else {
      for (const k of ["breakAt", "breakGap"]) if (n[k] !== undefined) return `${k} is a property of an edge in a plane`;
    }
  }
  return undefined;
}

/** Per-type rules that span props, on the merged node. */
export function invariantError(n: Node): string | undefined {
  const num_ = (k: string): number | undefined => (typeof n[k] === "number" ? (n[k] as number) : undefined);
  switch (n.type) {
    case "band": {
      const r0 = num_("r0"), r1 = num_("r1"), from = num_("from"), to = num_("to"), seg = num_("segments") ?? 1, lit = num_("lit") ?? 0;
      if (r0 !== undefined && r1 !== undefined && !(r1 > r0)) return "band r1 must be larger than r0";
      if (from !== undefined && to !== undefined) {
        if (!(to > from)) return "band to must be larger than from";
        if (to - from > 360) return "a band covers at most one turn (to - from <= 360)";
        if ((to - from) / seg < 1) return "a band segment is at least 1 degree wide";
      }
      if (lit > seg) return "band lit cannot be more than its segments";
      return undefined;
    }
    case "hatch": {
      const from = num_("from"), to = num_("to");
      if (from !== undefined && to !== undefined && (!(to > from) || to - from > 360)) return "hatch to must be above from, within one turn";
      return undefined;
    }
    case "ticks": {
      const count = num_("count");
      if (count !== undefined) {
        if ((num_("mark") ?? 0) > count) return "ticks mark cannot be more than count";
        if ((num_("passed") ?? 0) > count) return "ticks passed cannot be more than count";
        if ((num_("lit") ?? 0) > count) return "ticks lit cannot be more than count";
      }
      return undefined;
    }
    case "edge": {
      const at = num_("breakAt"), gap = num_("breakGap");
      if (gap !== undefined && at === undefined) return "breakGap needs breakAt";
      if (at !== undefined) {
        const half = (gap ?? 0.1) / 2;
        if (at - half < 0 || at + half > 1) return "an edge break must lie inside the edge (breakAt +/- breakGap/2 within 0..1)";
      }
      return undefined;
    }
    case "gauge": {
      const shape = n.shape, max = num_("max"), value = num_("value");
      if (shape === "ticks" && !(max !== undefined && Number.isInteger(max) && max >= 8 && max <= SHEET_LIMITS.ticks)) return `a ticks gauge needs a whole max from 8 to ${SHEET_LIMITS.ticks}`;
      if (shape === "segments" && !(max !== undefined && Number.isInteger(max) && max <= 12)) return "a segments gauge needs a whole max up to 12";
      if (n.values !== undefined && shape !== "arc") return "values belong to an arc gauge";
      if (n.mark !== undefined && shape !== "arc" && shape !== "ring" && shape !== "bar") return "mark belongs to an arc, ring or bar gauge";
      if (value !== undefined && max !== undefined && value > max) return "gauge value is over its max";
      return undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- the cost

/** SVG elements each thing draws, at most. The renderer is built to these (no
 *  wrapper group, many marks of one look merged into one path) and the render
 *  test counts. The caps on ticks, segments and hatch lines stay: a path with
 *  120 subpaths is one element and still work for the window. */
export const SHEET_COST = {
  /** ground, two star paths, three gradients of three elements, one clip. */
  base: 13,
  perKeyEntry: 2,
  orb: 5,
  plane: 1,
  /** A band: its outline, and its sectors as one path (two when segments are lit and unlit). */
  band: 3,
  /** Ticks: unlit, passed, lit and marked paths, the hand and its dot. */
  ticks: 6,
  reticle: 5,
  edge: 2,
  edgeBreak: 2,
  /** A hatch: its lines as one path, the clip and the clip's shape. */
  hatch: 3,
} as const;

/** Lines a hatch draws over a shape whose radius is `r`. */
export const hatchLines = (r: number, gap: number): number => Math.ceil((2 * r) / gap);

const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** The cost of one node, not counting its children. */
function nodeCost(n: CanvasNode): number {
  switch (n.type) {
    case "sheet": return SHEET_COST.base + SHEET_COST.perKeyEntry * len(n.key);
    case "orb": return SHEET_COST.orb + (typeof n.bands === "number" ? n.bands : 0);
    case "plane": return SHEET_COST.plane;
    case "band": return SHEET_COST.band + (n.halo === true ? 1 : 0);
    case "ticks": return SHEET_COST.ticks + len(n.numerals);
    case "reticle": return SHEET_COST.reticle;
    case "edge": return SHEET_COST.edge + (n.breakAt !== undefined ? SHEET_COST.edgeBreak : 0);
    case "hatch": return SHEET_COST.hatch;
    case "token": {
      const labelled = typeof n.label === "string" && n.leader !== undefined && n.leader !== "none";
      return 1 + (n.halo === true ? 1 : 0) + (n.count !== undefined ? 1 : 0) + (labelled ? 2 : 0) + (n.value !== undefined ? 1 : 0) + (typeof n.trail === "number" ? n.trail : 0);
    }
    default: return 0;
  }
}

/** The index a whole-scene check and the cost both need. */
function indexOf(order: readonly CanvasNode[]) {
  const byId = new Map<string, CanvasNode>();
  const kids = new Map<string, CanvasNode[]>();
  for (const n of order) byId.set(n.id, n);
  for (const n of order) if (n.parent !== undefined) { const l = kids.get(n.parent); if (l) l.push(n); else kids.set(n.parent, [n]); }
  return { byId, kids };
}

/** The radius of the shape a hatch covers: an orb's r, or a band's outer radius on its plane's rx. 0 when it is not drawable. */
function shapeRadius(byId: Map<string, CanvasNode>, id: unknown): number {
  const t = typeof id === "string" ? byId.get(id) : undefined;
  if (!t) return 0;
  if (t.type === "orb") return typeof t.r === "number" ? t.r : 0;
  if (t.type === "band") {
    const plane = t.parent !== undefined ? byId.get(t.parent) : undefined;
    return typeof t.r1 === "number" && typeof plane?.rx === "number" ? t.r1 * plane.rx : 0;
  }
  return 0;
}

/** SVG elements the sheet `id` draws, itself and everything under it. */
export function sheetCost(order: readonly CanvasNode[], id: string): number {
  const { byId, kids } = indexOf(order);
  return costOf(byId, kids, id);
}

function costOf(byId: Map<string, CanvasNode>, kids: Map<string, CanvasNode[]>, id: string): number {
  const root = byId.get(id);
  if (!root) return 0;
  let total = 0;
  const walk = (n: CanvasNode, d: number): void => {
    if (d > CANVAS_LIMITS.depth + 2) return;
    total += nodeCost(n);
    for (const k of kids.get(n.id) ?? []) walk(k, d + 1);
  };
  walk(root, 0);
  return total;
}

// ---------------------------------------------------------------- the whole scene

/**
 * Rules that span nodes, run on the scene a batch leaves behind: counts, the
 * references between nodes, and the cost. The refusal names the node and the
 * number. Run after every batch, so a `set` on a plane that makes a hatch
 * too long, or a `move` that takes a token a reticle points at out of its
 * plane, is refused where it happens and not discovered at draw time.
 */
export function sceneError(order: readonly CanvasNode[]): string | undefined {
  let sheets = 0, folds = 0, docks = 0;
  const fits = new Set<string>();
  const { byId, kids } = indexOf(order);
  const count = (id: string, type: string) => (kids.get(id) ?? []).filter((k) => k.type === type).length;
  for (const n of order) {
    switch (n.type) {
      case "sheet": {
        if (++sheets > SHEET_LIMITS.sheets) return `at most ${SHEET_LIMITS.sheets} sheets in a scene`;
        if (fits.has(n.fit as string)) return `sheet "${n.id}": there is already a ${n.fit} sheet`;
        fits.add(n.fit as string);
        if (count(n.id, "plane") > SHEET_LIMITS.planesPerSheet) return `sheet "${n.id}": at most ${SHEET_LIMITS.planesPerSheet} planes`;
        if (count(n.id, "orb") > 1) return `sheet "${n.id}": at most one orb`;
        if (count(n.id, "hatch") > SHEET_LIMITS.hatchPerSheet) return `sheet "${n.id}": at most ${SHEET_LIMITS.hatchPerSheet} hatches`;
        const cost = costOf(byId, kids, n.id);
        if (cost > SHEET_LIMITS.svgNodes) return `sheet "${n.id}" would draw ${cost} SVG elements (at most ${SHEET_LIMITS.svgNodes})`;
        break;
      }
      case "fold": if (++folds > SHEET_LIMITS.folds) return `at most ${SHEET_LIMITS.folds} folds in a scene`; break;
      case "dock":
        if (++docks > SHEET_LIMITS.docks) return `at most ${SHEET_LIMITS.docks} docks in a scene`;
        if ((kids.get(n.id) ?? []).length > 1) return `dock "${n.id}" holds one gauge`;
        break;
      case "plane":
        if (count(n.id, "token") > SHEET_LIMITS.tokensPerPlane) return `plane "${n.id}": at most ${SHEET_LIMITS.tokensPerPlane} tokens`;
        if (count(n.id, "edge") > SHEET_LIMITS.edgesPerPlane) return `plane "${n.id}": at most ${SHEET_LIMITS.edgesPerPlane} edges`;
        if (count(n.id, "band") > SHEET_LIMITS.bandsPerPlane) return `plane "${n.id}": at most ${SHEET_LIMITS.bandsPerPlane} bands`;
        if (count(n.id, "reticle") > 1) return `plane "${n.id}": at most one reticle`;
        if (count(n.id, "ticks") > 1) return `plane "${n.id}": at most one ticks`;
        break;
      case "reticle": {
        const t = byId.get(n.of as string);
        if (!t || t.type !== "token" || t.parent !== n.parent) return `reticle "${n.id}" must point at a token of its own plane`;
        break;
      }
      case "hatch": {
        const t = byId.get(n.of as string);
        const sheetOf = (x: CanvasNode | undefined): string | undefined => (x?.type === "band" ? byId.get(x.parent as string)?.parent : x?.parent);
        if (!t || (t.type !== "orb" && t.type !== "band") || sheetOf(t) !== n.parent) return `hatch "${n.id}" must cover an orb or a band of its own sheet`;
        const lines = hatchLines(shapeRadius(byId, n.of), n.gap as number);
        if (lines > SHEET_LIMITS.hatchLines) return `hatch "${n.id}" would draw ${lines} lines (at most ${SHEET_LIMITS.hatchLines})`;
        break;
      }
      case "edge": {
        const p = n.parent !== undefined ? byId.get(n.parent) : undefined;
        if (p?.type !== "plane") break;
        const a = byId.get(n.from as string), b = byId.get(n.to as string);
        if (a?.type !== "token" || b?.type !== "token" || a.parent !== n.parent || b.parent !== n.parent || a === b) return `edge "${n.id}" in a plane must join two different tokens of that plane`;
        break;
      }
    }
  }
  return undefined;
}

/** What a removal takes with it, beyond the subtree: what pointed at it. */
export function dependants(order: readonly CanvasNode[], gone: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const n of order) {
    if (n.type === "edge" && (gone.has(n.from as string) || gone.has(n.to as string))) out.push(n.id);
    else if ((n.type === "hatch" || n.type === "reticle") && gone.has(n.of as string)) out.push(n.id);
  }
  return out;
}
