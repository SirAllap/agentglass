import type { CanvasNode } from "../../../shared/pluginCanvas.ts";
import { MOON_MAX_R, type LEADERS } from "../../../shared/canvasSheet.ts";

/**
 * The arithmetic of a sheet (shared/canvasSheet.ts): where an angle on a tilted
 * ring lands, how big a moon is there, which marks of a clock have passed, and
 * where each label goes. Pure, so a test can call it: the project has no
 * renderer, and what a screen decides belongs here, not in the component.
 *
 * Angles are degrees, 0 = right, growing clockwise on the screen (y points
 * down). A plane is a circle seen from `tilt` degrees above it (90 = straight
 * down on it), so it is an ellipse of height rx * sin(tilt), then turned by `roll`. `near` is the
 * sine of the angle in the plane's own frame: +1 is the front of the ring (the
 * viewer's side), -1 the back.
 *
 * Nothing here takes a string from a scene into a path: every number was
 * validated by the reducer and is clamped again where it becomes geometry, and
 * every output is a number or a path built from numbers.
 */

const RAD = Math.PI / 180;
const fix = (n: number): string => (Math.round(n * 10) / 10).toString();

export interface Pt { x: number; y: number }
export interface PlaneGeom { cx: number; cy: number; rx: number; ry: number; roll: number; depth: number }

const clamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
const numOr = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** The plane a node describes, at `phase` of its tipping (0 = seen from above, a circle; 1 = as declared). */
export function planeGeom(n: CanvasNode, phase = 1): PlaneGeom {
  const rx = clamp(numOr(n.rx, 100), 1, 600);
  // `tilt` is the angle it is seen from: 90 is a circle, the declared value an ellipse; the opening tips from one to the other.
  const tilt = 90 + (clamp(numOr(n.tilt, 90), 15, 90) - 90) * clamp(phase, 0, 1);
  return {
    cx: numOr(n.cx, 0), cy: numOr(n.cy, 0), rx, ry: rx * Math.sin(tilt * RAD),
    roll: clamp(numOr(n.roll, 0), -45, 45) * clamp(phase, 0, 1) * RAD, depth: clamp(numOr(n.depth, 0), 0, 1),
  };
}

/** The point at `ratio` of the plane's radius and angle `at`. `near` is -1 at the back of the ring, +1 at the front. */
export function onPlane(p: PlaneGeom, ratio: number, at: number): Pt & { near: number } {
  const a = at * RAD;
  const dx = ratio * p.rx * Math.cos(a), dy = ratio * p.ry * Math.sin(a);
  const c = Math.cos(p.roll), s = Math.sin(p.roll);
  return { x: p.cx + dx * c - dy * s, y: p.cy + dx * s + dy * c, near: Math.sin(a) };
}

/** Size of a moon: the role's radius, grown near and shrunk far by depth, never past MOON_MAX_R. */
export const MOON_R = { sm: 7, md: 8.5, lg: 10.5 } as const;
export function moonRadius(size: unknown, near: number, depth: number): number {
  const base = size === "lg" ? MOON_R.lg : size === "md" ? MOON_R.md : MOON_R.sm;
  return Math.min(MOON_MAX_R, base * (1 + 0.35 * depth * near));
}

const STEP = 5;
/** A coarse outline of a plane (24 points), for the room beside it. */
export function arcPointsBox(p: PlaneGeom, ratio = 1): Pt[] {
  return Array.from({ length: 24 }, (_, i) => onPlane(p, ratio, i * 15));
}
/** Points along ratio `ratio` from angle a to b (a < b), at most STEP degrees apart. */
export function arcPoints(p: PlaneGeom, ratio: number, a: number, b: number): (Pt & { near: number })[] {
  const n = Math.max(1, Math.ceil((b - a) / STEP));
  const out: (Pt & { near: number })[] = [];
  for (let i = 0; i <= n; i++) out.push(onPlane(p, ratio, a + ((b - a) * i) / n));
  return out;
}
const poly = (pts: readonly Pt[], move = true): string => pts.map((q, i) => `${i === 0 && move ? "M" : "L"}${fix(q.x)} ${fix(q.y)}`).join("");

/** An annulus sector as a closed path. */
export function sectorPath(p: PlaneGeom, r0: number, r1: number, from: number, to: number): string {
  return `${poly(arcPoints(p, r1, from, to))}${poly([...arcPoints(p, r0, from, to)].reverse(), false)}Z`;
}

/** A band's marks: its outline, and its sectors as one path when lit and one when not. */
export function bandPaths(p: PlaneGeom, n: CanvasNode): { outline: string; lit: string; unlit: string } {
  const r0 = clamp(numOr(n.r0, 0.3), 0.05, 2), r1 = clamp(numOr(n.r1, 0.4), 0.05, 2);
  const from = numOr(n.from, 0), to = Math.min(numOr(n.to, 360), from + 360);
  const seg = Math.round(clamp(numOr(n.segments, 1), 1, 60)), lit = Math.round(clamp(numOr(n.lit, 0), 0, seg));
  const outline = sectorPath(p, r0, r1, from, to);
  if (seg === 1) return { outline, lit: lit > 0 ? outline : "", unlit: lit > 0 ? "" : outline };
  // A sixth of a segment of gap between neighbours, so 30 sectors read as 30.
  const w = (to - from) / seg, pad = Math.min(0.9, w / 6);
  let litD = "", unlitD = "";
  for (let i = 0; i < seg; i++) {
    const d = sectorPath(p, r0, r1, from + i * w + pad / 2, from + (i + 1) * w - pad / 2);
    if (i < lit) litD += d; else unlitD += d;
  }
  return { outline, lit: litD, unlit: unlitD };
}

/** What the clock has done at `now`: how many of `count` marks have passed, and the angle of the hand. */
export function tickState(until: number | undefined, now: number, period: number, count: number, passedStatic: number | undefined): { passed: number; hand: number } {
  let passed: number;
  if (until !== undefined) {
    const left = Math.max(0, until - now) / 1000;
    passed = Math.floor(clamp(1 - left / Math.max(1, period), 0, 1) * count);
  } else passed = Math.round(clamp(passedStatic ?? 0, 0, count));
  // The first mark is at the top of the ring, and the hand sits at the last passed mark.
  return { passed, hand: 270 + (passed / count) * 360 };
}

/** Whether the window's 1 Hz clock has anything to draw for this node: a countdown, or anything that carries `until` (the spec lets only ticks, a ticks gauge and a dock), so a new `until` consumer needs no entry here. */
export const needsClock = (n: CanvasNode): boolean => n.type === "countdown" || until(n) !== undefined;

/** How many of a ticks gauge's `total` marks are lit at `now`: the plugin's own `value`, or, with `until`, the share of `period` that has run (a mark per step, 0 when it starts, all of them once spent). */
export function gaugeLit(n: CanvasNode, now: number, total: number): number {
  const end = until(n);
  if (end !== undefined) return tickState(end, now, numOr(n.period, 60), total, undefined).passed;
  return Math.round(clamp(numOr(n.value, 0), 0, total));
}

export interface TickPaths { unlit: string; passed: string; lit: string; mark: string; hand: string; handDot: Pt }
const TICK_LEN = 6;
export function tickPaths(p: PlaneGeom, n: CanvasNode, now: number): TickPaths {
  const count = Math.round(clamp(numOr(n.count, 60), 8, 120));
  const out = n.side === "in" ? -1 : 1;
  const mark = Math.round(clamp(numOr(n.mark, 0), 0, count));
  const litN = Math.round(clamp(numOr(n.lit, until(n) !== undefined ? 8 : 0), 0, count));
  const { passed, hand } = tickState(until(n), now, numOr(n.period, 60), count, typeof n.passed === "number" ? n.passed : undefined);
  let unlit = "", pass = "", lit = "", marked = "";
  for (let i = 0; i < count; i++) {
    const at = 270 + (i / count) * 360;
    const a = onPlane(p, 1, at), b = onPlane(p, 1 + (out * TICK_LEN) / p.rx, at);
    const longer = mark > 0 && i % mark === 0;
    const seg = `M${fix(a.x)} ${fix(a.y)}L${fix(b.x)} ${fix(b.y)}`;
    if (longer) marked += seg;
    else if (i >= passed - litN && i < passed) lit += seg;
    else if (i < passed) pass += seg;
    else unlit += seg;
  }
  const h0 = onPlane(p, 1, hand), h1 = onPlane(p, 1 + (out * (TICK_LEN + 6)) / p.rx, hand);
  return { unlit, passed: pass, lit, mark: marked, hand: `M${fix(h0.x)} ${fix(h0.y)}L${fix(h1.x)} ${fix(h1.y)}`, handDot: { x: h1.x, y: h1.y } };
}
const until = (n: CanvasNode): number | undefined => (typeof n.until === "number" ? n.until : undefined);

/** An edge along the plane from angle a to b clockwise, split into the far run and the near run, with a gap cut out of it. */
export interface EdgePaths { far: string; near: string; marks: string }
export function edgePaths(p: PlaneGeom, a: number, b: number, breakAt?: number, breakGap = 0.1): EdgePaths {
  const to = b > a ? b : b + 360;
  const pts = arcPoints(p, 1, a, to);
  const span = to - a;
  const gapFrom = breakAt === undefined ? Infinity : a + span * (breakAt - breakGap / 2);
  const gapTo = breakAt === undefined ? -Infinity : a + span * (breakAt + breakGap / 2);
  let far = "", near = "", marks = "";
  const step = span / (pts.length - 1);
  let prev: (Pt & { near: number }) | undefined, prevAt = a;
  pts.forEach((q, i) => {
    const at = a + i * step;
    const inGap = at > gapFrom && at < gapTo;
    if (prev && !inGap && !(prevAt > gapFrom && prevAt < gapTo)) {
      const seg = `M${fix(prev.x)} ${fix(prev.y)}L${fix(q.x)} ${fix(q.y)}`;
      if ((prev.near + q.near) / 2 >= 0) near += seg; else far += seg;
    }
    prev = q; prevAt = at;
  });
  if (breakAt !== undefined) {
    for (const t of [gapFrom, gapTo]) {
      const o = onPlane(p, 1.03, t), i = onPlane(p, 0.97, t);
      marks += `M${fix(i.x)} ${fix(i.y)}L${fix(o.x)} ${fix(o.y)}`;
    }
  }
  return { far, near, marks };
}

/** One slice of a trail: from angle a to b, behind the moon. */
export function trailSlices(p: PlaneGeom, at: number, span: number, n: number): { d: string; opacity: number }[] {
  const out: { d: string; opacity: number }[] = [];
  for (let i = 0; i < n; i++) {
    const hi = at - (span * i) / n, lo = at - (span * (i + 1)) / n;
    out.push({ d: poly(arcPoints(p, 1, lo, hi)), opacity: Math.round(70 * (1 - i / n)) / 100 });
  }
  return out;
}

/** Corner brackets around a point, one path. */
export function bracketPath(c: Pt, r: number): string {
  const h = r + 10, k = 6;
  const corner = (sx: number, sy: number) => `M${fix(c.x + sx * h)} ${fix(c.y + sy * (h - k))}L${fix(c.x + sx * h)} ${fix(c.y + sy * h)}L${fix(c.x + sx * (h - k))} ${fix(c.y + sy * h)}`;
  return corner(-1, -1) + corner(1, -1) + corner(1, 1) + corner(-1, 1);
}

/** Parallel lines at `angle` degrees, `gap` apart, across a shape of radius r about c: the lines, as one path, to be clipped. */
export function hatchPath(c: Pt, r: number, gap: number, angle: number): string {
  const a = angle * RAD, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
  const n = Math.min(80, Math.ceil((2 * r) / gap));
  let d = "";
  for (let i = 0; i <= n; i++) {
    const o = -r + (i * 2 * r) / Math.max(1, n);
    const x = c.x + nx * o, y = c.y + ny * o;
    d += `M${fix(x - dx * r * 1.5)} ${fix(y - dy * r * 1.5)}L${fix(x + dx * r * 1.5)} ${fix(y + dy * r * 1.5)}`;
  }
  return d;
}

/** A pie slice of a circle, for clipping a hatch to the night side. */
export function pieSlice(c: Pt, r: number, from: number, to: number): string {
  const a = onCircle(c, r * 1.02, from), b = onCircle(c, r * 1.02, to);
  const large = to - from > 180 ? 1 : 0;
  return `M${fix(c.x)} ${fix(c.y)}L${fix(a.x)} ${fix(a.y)}A${fix(r * 1.02)} ${fix(r * 1.02)} 0 ${large} 1 ${fix(b.x)} ${fix(b.y)}Z`;
}
export const onCircle = (c: Pt, r: number, deg: number): Pt => ({ x: c.x + r * Math.cos(deg * RAD), y: c.y + r * Math.sin(deg * RAD) });

// ---------------------------------------------------------------- labels

/** Where a label goes: every leader but `none`, which has no label. */
export type LabelSide = Exclude<(typeof LEADERS)[number], "none">;
export interface LabelIn { id: string; x: number; y: number; r: number; side: LabelSide; /** Text lines the label has (name, and a value under it); 1 when absent. Only an `above` label needs it: it is the last line that sits next to the moon. */ lines?: 1 | 2 }
export interface LabelOut { id: string; side: LabelSide; anchor: "start" | "middle" | "end"; x: number; y: number; line: string }
/** Height of a label (name and value lines) and the least gap between two in a column. */
export const LABEL_H = 30;
const RELAX_PASSES = 40;
/** How far under a label's name its value line is drawn. */
export const VALUE_DROP = 13;

/**
 * Where each label goes. Left and right labels stack in a column beside the
 * ring, in the order of their moons, spread out until no two are closer than
 * LABEL_H and none leaves the sheet; a label that cannot fit is not drawn and
 * its column says how many it dropped. A `below` label hangs under its moon, an `above` one stands over it.
 * The relaxation is capped, so it is bounded work whatever a plugin sends.
 */
export function labelLayout(items: readonly LabelIn[], bounds: { w: number; h: number; left: number; right: number }): { labels: LabelOut[]; dropped: { left: number; right: number } } {
  const labels: LabelOut[] = [];
  const dropped = { left: 0, right: 0 };
  const top = 34, bottom = bounds.h - 14;
  const room = Math.max(1, Math.floor((bottom - top) / LABEL_H) + 1);
  for (const side of ["left", "right"] as const) {
    const col = items.filter((i) => i.side === side).sort((a, b) => a.y - b.y || (a.id < b.id ? -1 : 1));
    const kept = col.slice(0, room);
    dropped[side] = col.length - kept.length;
    const ys = kept.map((i) => clamp(i.y, top, bottom));
    for (let pass = 0; pass < RELAX_PASSES; pass++) {
      let moved = false;
      for (let i = 1; i < ys.length; i++) {
        const gap = ys[i]! - ys[i - 1]!;
        if (gap < LABEL_H) { const push = (LABEL_H - gap) / 2; ys[i - 1] = ys[i - 1]! - push; ys[i] = ys[i]! + push; moved = true; }
      }
      for (let i = 0; i < ys.length; i++) ys[i] = clamp(ys[i]!, top, bottom);
      if (!moved) break;
    }
    // A final sweep from the top so the cap on passes never leaves two on top of each other.
    for (let i = 0; i < ys.length; i++) ys[i] = Math.max(ys[i]!, i === 0 ? top : ys[i - 1]! + LABEL_H);
    const over = ys.length > 0 ? ys[ys.length - 1]! - bottom : 0;
    if (over > 0) for (let i = 0; i < ys.length; i++) ys[i] = ys[i]! - over;
    kept.forEach((it, i) => {
      const x = side === "left" ? bounds.left : bounds.right;
      const sx = side === "left" ? it.x - it.r - 2 : it.x + it.r + 2;
      labels.push({ id: it.id, side, anchor: side === "left" ? "end" : "start", x, y: ys[i]!, line: `M${fix(sx)} ${fix(it.y)}L${fix(side === "left" ? x + 4 : x - 4)} ${fix(ys[i]! + 4)}` });
    });
  }
  // `below` and `above` mirror each other: the same 10 unit leader off the moon's edge. Under it the name sits 21 down; over it the label's last line stands on the leader (baseline 14 up), so a value pushes the name up one line.
  for (const it of items.filter((i) => i.side === "below" || i.side === "above")) {
    const s = it.side === "above" ? -1 : 1;
    const name = s === 1 ? it.y + it.r + 21 : it.y - it.r - 14 - (it.lines === 2 ? VALUE_DROP : 0);
    labels.push({ id: it.id, side: it.side, anchor: "middle", x: it.x, y: name, line: `M${fix(it.x)} ${fix(it.y + s * (it.r + 1))}L${fix(it.x)} ${fix(it.y + s * (it.r + 11))}` });
  }
  return { labels, dropped };
}
