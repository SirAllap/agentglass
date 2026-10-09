import { CANVAS_LIMITS, effectiveMs, type CanvasAction, type CanvasEasing, type CanvasNode, type CanvasScene } from "../../../shared/pluginCanvas.ts";

/**
 * The arithmetic of a live canvas, kept apart from the view so it can be
 * called with numbers: where a wire runs, how a node travels along it, what
 * shifts when a scene reorders, how many motions may run at once.
 *
 * Every function here is pure and deterministic. Nothing reads the DOM, and
 * nothing takes a string from a scene and puts it into a style: what the view
 * gets from this file is numbers it has clamped and words that came out of a
 * table.
 */

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

// ---------------------------------------------------------------- routing

const dedupe = (pts: Point[]): Point[] => pts.filter((p, i) => i === 0 || p.x !== pts[i - 1]!.x || p.y !== pts[i - 1]!.y);

/**
 * An orthogonal route from one rectangle to another: horizontal and vertical
 * segments only, leaving one edge of `from` and arriving at one edge of `to`.
 *
 *  - Side by side with rows in common: one straight line through the middle of
 *    what they share (and the same for stacked, with columns in common).
 *  - Diagonal to each other: an elbow pair, leaving on the axis with the
 *    larger gap and bending half way across it.
 *  - Touching or overlapping, where there is no gap to run in: a single bend
 *    between the two centres. It is not pretty and it is deterministic, which
 *    is what a layout that moves under the wire needs.
 *
 * The target being left of, or above, the source is the same rule mirrored.
 */
export function routeEdge(from: Rect, to: Rect): Point[] {
  const aR = from.x + from.w, aB = from.y + from.h, bR = to.x + to.w, bB = to.y + to.h;
  const gapX = to.x > aR ? to.x - aR : from.x > bR ? from.x - bR : 0;
  const gapY = to.y > aB ? to.y - aB : from.y > bB ? from.y - bB : 0;
  const right = to.x > aR; // the target is to the right (when gapX > 0)
  const below = to.y > aB;
  const cx = (r: Rect) => r.x + r.w / 2;
  const cy = (r: Rect) => r.y + r.h / 2;
  const xShared = Math.min(aR, bR) - Math.max(from.x, to.x);
  const yShared = Math.min(aB, bB) - Math.max(from.y, to.y);
  const midX = (Math.min(aR, bR) + Math.max(from.x, to.x)) / 2;
  const midY = (Math.min(aB, bB) + Math.max(from.y, to.y)) / 2;

  if (gapX > 0 && gapY > 0) {
    if (gapX >= gapY) {
      const sx = right ? aR : from.x, ex = right ? to.x : bR;
      const mx = (sx + ex) / 2;
      return dedupe([{ x: sx, y: cy(from) }, { x: mx, y: cy(from) }, { x: mx, y: cy(to) }, { x: ex, y: cy(to) }]);
    }
    const sy = below ? aB : from.y, ey = below ? to.y : bB;
    const my = (sy + ey) / 2;
    return dedupe([{ x: cx(from), y: sy }, { x: cx(from), y: my }, { x: cx(to), y: my }, { x: cx(to), y: ey }]);
  }
  if (gapX > 0 && yShared > 0) {
    return [{ x: right ? aR : from.x, y: midY }, { x: right ? to.x : bR, y: midY }];
  }
  if (gapY > 0 && xShared > 0) {
    return [{ x: midX, y: below ? aB : from.y }, { x: midX, y: below ? to.y : bB }];
  }
  return dedupe([{ x: cx(from), y: cy(from) }, { x: cx(to), y: cy(from) }, { x: cx(to), y: cy(to) }]);
}

/** `M x y L x y …`, from numbers only, so the wire is never text from a scene. */
export function pathData(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
}

export function pathLength(points: readonly Point[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return n;
}

export interface Frame { offset: number; dx: number; dy: number }

/**
 * The keyframes of something riding `route` and coming to rest at `landing`:
 * one per waypoint, spaced by distance so the speed is even, each as the
 * translation that puts the element on that waypoint when it already sits at
 * `landing`. The last frame is the identity, so the animation ends exactly
 * where the layout put the element.
 */
export function travelFrames(route: readonly Point[], landing: Point): Frame[] {
  const pts = [...route, landing];
  const total = pathLength(pts);
  const out: Frame[] = [];
  let run = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) run += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    out.push({ offset: total === 0 ? (i === pts.length - 1 ? 1 : 0) : run / total, dx: pts[i]!.x - landing.x, dy: pts[i]!.y - landing.y });
  }
  return out;
}

// ---------------------------------------------------------------- the scene as a tree

/** Children by parent id, in scene order. The root's are under `undefined`.
 *  Edges are left out: they are drawn between nodes, not inside one. */
export function childrenIndex(scene: CanvasScene): Map<string | undefined, CanvasNode[]> {
  const out = new Map<string | undefined, CanvasNode[]>();
  for (const n of scene) {
    if (n.type === "edge") continue;
    const list = out.get(n.parent);
    if (list) list.push(n); else out.set(n.parent, [n]);
  }
  return out;
}

/** Every non-edge node, each after its parent: the order a shift must be
 *  worked out in, whatever order the flat scene happens to list them. */
export function parentsFirst(scene: CanvasScene): string[] {
  const kids = childrenIndex(scene);
  const out: string[] = [];
  const walk = (parent: string | undefined) => {
    for (const n of kids.get(parent) ?? []) { out.push(n.id); walk(n.id); }
  };
  walk(undefined);
  return out;
}

/** Where a wire may end for `id`: its own box, or, when it is not drawn (a
 *  pile shows only a few of its members), the nearest box around it that is. */
export function rectOrAncestor(id: string, rects: ReadonlyMap<string, Rect>, parentOf: (id: string) => string | undefined): Rect | undefined {
  for (let cur: string | undefined = id, hops = 0; cur !== undefined && hops <= CANVAS_LIMITS.depth + 1; cur = parentOf(cur), hops++) {
    const r = rects.get(cur);
    if (r) return r;
  }
  return undefined;
}

/** What a compact stack shows before it says "+N". */
export const PILE_MAX = 4;

export function pileSplit<T>(items: readonly T[], max = PILE_MAX): { shown: T[]; hidden: number } {
  return { shown: items.slice(0, max), hidden: Math.max(0, items.length - max) };
}

/** `grow` as flex-grow: the scene says 1-4, the window does not take its word. */
export const clampGrow = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(4, Math.max(1, Math.trunc(v))) : undefined;

// ---------------------------------------------------------------- motion

const EASING_CSS: Record<CanvasEasing, string> = {
  linear: "linear",
  ease: "ease",
  "ease-in": "ease-in",
  "ease-out": "ease-out",
  "ease-in-out": "ease-in-out",
  spring: "cubic-bezier(.34,1.56,.64,1)",
};

/** A named curve as a timing function. Anything not in the table is `ease`. */
export const easingCss = (name: unknown): string =>
  typeof name === "string" && Object.hasOwn(EASING_CSS, name) ? EASING_CSS[name as CanvasEasing] : EASING_CSS.ease;

/** The one-shot motions running now, held under the contract's cap. Past it a
 *  motion is not queued: it is applied instantly, like every other change. */
export class TweenBudget {
  private n = 0;
  constructor(readonly cap: number = CANVAS_LIMITS.tweens) {}
  acquire(): boolean {
    if (this.n >= this.cap) return false;
    this.n++;
    return true;
  }
  release(): void { this.n = Math.max(0, this.n - 1); }
  get running(): number { return this.n; }
}

/**
 * How long a motion runs, or 0 for "do not animate, just apply it": reduced
 * motion, a canvas nobody can see, or no room left under the cap. A duration
 * that is granted holds a slot until `budget.release()`.
 */
export function planTween(budget: TweenBudget, ms: number | undefined, fallback: number, reduced: boolean, paused: boolean): number {
  const d = effectiveMs(ms, fallback, reduced);
  if (d <= 0 || paused) return 0;
  return budget.acquire() ? d : 0;
}

export interface Shift { id: string; dx: number; dy: number }

/**
 * What moved when a scene changed, as the offsets that put each node back
 * where it WAS so it can slide to where it is (FLIP: first, last, invert,
 * play). `order` lists parents before children.
 *
 * A node inside a node that also moved is already carried along by its
 * parent's transform, so its own offset is the difference: the parent's
 * offset is taken off the child's, or it would travel twice as far. A node
 * with no old position (just added) or in `skip` (it travels along a wire
 * instead) is not shifted. `grant` is asked once per node that would animate,
 * parents first; saying no leaves that node where it landed.
 */
export function planFlip(
  before: ReadonlyMap<string, Rect>,
  after: ReadonlyMap<string, Rect>,
  order: readonly string[],
  parentOf: (id: string) => string | undefined,
  skip: ReadonlySet<string>,
  grant: () => boolean,
): Shift[] {
  const carried = new Map<string, Point>();
  const out: Shift[] = [];
  for (const id of order) {
    const a = before.get(id), b = after.get(id);
    const parent = parentOf(id);
    const inherited = (parent !== undefined ? carried.get(parent) : undefined) ?? { x: 0, y: 0 };
    let own = { x: 0, y: 0 };
    if (a && b && !skip.has(id)) {
      const dx = a.x - b.x - inherited.x, dy = a.y - b.y - inherited.y;
      if ((Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) && grant()) {
        own = { x: dx, y: dy };
        out.push({ id, dx, dy });
      }
    }
    carried.set(id, { x: inherited.x + own.x, y: inherited.y + own.y });
  }
  return out;
}

// ---------------------------------------------------------------- small drawings

/** `mm:ss` left until `until` (ms since the epoch), never negative. Minutes
 *  go past 59 rather than wrapping: "75:00" is what an hour and a quarter is. */
export function formatCountdown(until: number, now: number): string {
  const s = Math.max(0, Math.ceil((until - now) / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

/** A line that is the time left when it has an `until`, and its own text when it has none. */
export const liveText = (until: unknown, text: string | undefined, now: number): string | undefined =>
  typeof until === "number" ? formatCountdown(until, now) : text;

/** The scale of a sparkline: its lowest and highest value, with a cap line counted in so the line is always inside the box. */
const sparkRange = (values: readonly number[], cap: number | undefined): { lo: number; span: number } => {
  const all = cap === undefined ? values : [...values, cap];
  const lo = Math.min(...all), hi = Math.max(...all);
  return { lo, span: hi - lo };
};

/** A sparkline's points in a `w` x `h` box, as `x,y x,y …`. A flat series
 *  draws through the middle rather than dividing by zero. A `cap` is part of
 *  the scale, so a series under its limit sits below the line and does not
 *  stretch to fill the box. */
export function sparkPoints(values: readonly number[], w: number, h: number, cap?: number): string {
  if (values.length === 0) return "";
  const { lo, span } = sparkRange(values, cap);
  return values.map((v, i) => {
    const x = values.length === 1 ? w / 2 : (i / (values.length - 1)) * w;
    const y = span === 0 ? h / 2 : h - ((v - lo) / span) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

/** The height of a sparkline's cap line in the same `h` box, on the same scale as `sparkPoints`. */
export function sparkCapY(values: readonly number[], h: number, cap: number): number {
  const { lo, span } = sparkRange(values, cap);
  return span === 0 ? h / 2 : h - ((cap - lo) / span) * h;
}

/** A point on a circle, angle in degrees from 12 o'clock, clockwise. */
export function polar(cx: number, cy: number, r: number, deg: number): Point {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/** An arc from `from` to `to` degrees (clockwise from 12 o'clock). */
export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const s = polar(cx, cy, r, from), e = polar(cx, cy, r, to);
  return `M${s.x.toFixed(1)} ${s.y.toFixed(1)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${e.x.toFixed(1)} ${e.y.toFixed(1)}`;
}

/** value/max as a fraction in [0, 1]; a bad pair is empty, not NaN. */
export const fraction = (value: unknown, max: unknown): number =>
  typeof value === "number" && typeof max === "number" && Number.isFinite(value) && Number.isFinite(max) && max > 0
    ? Math.min(1, Math.max(0, value / max))
    : 0;

/** A control's action with the chosen value merged into its payload. A payload
 *  that is not an object is replaced: the value is what the plugin asked for. */
export function actionWithValue(action: CanvasAction, value: string): CanvasAction {
  const base = action.payload && typeof action.payload === "object" && !Array.isArray(action.payload) ? (action.payload as Record<string, unknown>) : {};
  return { id: action.id, payload: { ...base, value } };
}

// ---------------------------------------------------------------- a board

/**
 * A board is a stage of fixed units scaled as a whole. The scale follows the
 * width it is given, inside a floor and a ceiling: under the floor the labels
 * of a 1180-unit machine drop below 7px and stop being read, so the stage
 * keeps the floor and its own wrapper scrolls; over the ceiling a small board
 * on a wide screen turns into a poster.
 */
export const BOARD_SCALE_MIN = 0.6;
export const BOARD_SCALE_MAX = 1.6;

export function boardScale(containerW: number, boardW: number): { scale: number; scrolls: boolean } {
  if (!(containerW > 0) || !(boardW > 0)) return { scale: 1, scrolls: false };
  const raw = containerW / boardW;
  const scale = Math.min(BOARD_SCALE_MAX, Math.max(BOARD_SCALE_MIN, raw));
  return { scale, scrolls: raw < BOARD_SCALE_MIN };
}

/** A bay slot's height in board units, and the gap between slots. The width
 *  is the bay's width shared by its columns. A sealed bay draws its frozen
 *  tokens smaller: nothing in it is read, only counted. */
export const SLOT_H = 22;
export const SLOT_GAP = 4;
export const SEALED_SLOT_H = 14;

/**
 * How a bay of `slots` cells shows `count` tokens: in scene order, one per
 * cell. When there are more tokens than cells the last cell stops holding a
 * token and says "+N" instead, so a burst never puts two tokens in one slot.
 */
export function baySplit(count: number, slots: number): { shown: number; more: number } {
  const n = Math.max(0, Math.trunc(count)), s = Math.max(0, Math.trunc(slots));
  if (n <= s) return { shown: n, more: 0 };
  if (s === 0) return { shown: 0, more: n };
  return { shown: s - 1, more: n - (s - 1) };
}

/** The cell a slot index sits in, row by row. */
export const slotCell = (i: number, cols: number): { col: number; row: number } => {
  const c = Math.max(1, Math.trunc(cols));
  return { col: i % c, row: Math.floor(i / c) };
};

/**
 * Rides along one trace never overlap: each starts at least `RIDE_GAP_MS`
 * after the previous one on the same trace started, so two tokens at the
 * same speed stay a token apart. A ride that would have to wait longer than
 * `RIDE_LATE_MS` is news nobody is still watching for: it lands in place
 * instead (null), and the queue does not grow without end during a burst.
 */
export const RIDE_GAP_MS = 220;
export const RIDE_LATE_MS = 1200;

export function rideDelay(prevStart: number | undefined, now: number, gap = RIDE_GAP_MS): number | null {
  if (prevStart === undefined) return 0;
  const delay = Math.max(0, prevStart + Math.max(RIDE_GAP_MS, gap) - now);
  return delay > RIDE_LATE_MS ? null : delay;
}

/** The named curves as cubic-bezier control points, the same curves EASING_CSS names. */
const EASING_POINTS: Record<CanvasEasing, readonly [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
  spring: [0.34, 1.56, 0.64, 1],
};

/** How far along (0-1, a spring may pass 1) a curve is at time fraction `t`. */
export function easeAt(name: unknown, t: number): number {
  const [x1, y1, x2, y2] = typeof name === "string" && Object.hasOwn(EASING_POINTS, name) ? EASING_POINTS[name as CanvasEasing] : EASING_POINTS.ease;
  const bez = (a: number, b: number, u: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  // x is monotonic in u: bisect for the u whose x is t.
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (bez(x1, x2, mid) < t) lo = mid; else hi = mid; }
  return bez(y1, y2, (lo + hi) / 2);
}

/** Each named curve sampled once, so a ride's spacing is table lookups. */
const EASE_SAMPLES = 200;
const easeTables = new Map<string, Float64Array>();
function easeTable(name: unknown): Float64Array {
  const key = typeof name === "string" && Object.hasOwn(EASING_POINTS, name) ? name : "ease";
  let t = easeTables.get(key);
  if (!t) {
    t = new Float64Array(EASE_SAMPLES + 1);
    for (let i = 0; i <= EASE_SAMPLES; i++) t[i] = easeAt(key, i / EASE_SAMPLES);
    easeTables.set(key, t);
  }
  return t;
}
const easeFast = (table: Float64Array, t: number): number => {
  const x = Math.min(1, Math.max(0, t)) * EASE_SAMPLES, i = Math.floor(x);
  return i >= EASE_SAMPLES ? table[EASE_SAMPLES]! : table[i]! + (table[i + 1]! - table[i]!) * (x - i);
};

/** Answers already worked out, by rounded inputs: a burst on one trace asks the same question every time. */
const clearCache = new Map<string, number>();
const CLEAR_CACHE_MAX = 256;

/**
 * The shortest spacing, in ms, that keeps two rides of the same length, time
 * and curve a token apart for the whole of the shared route: the follower
 * starts where the leader started, so what matters is how far ahead the
 * leader is at every moment both are moving. 220 ms is enough on a long
 * trace at an even speed, and it is not on a short one with a curve that
 * starts slowly: there the gap has to be measured, which is this. It runs on
 * the window's main thread for every ride, so the curve is a sampled table
 * and the answer is cached: a repeat costs a map lookup.
 */
export function rideClearMs(routeLen: number, ms: number, easing: unknown, width: number): number {
  if (!(routeLen > 0) || !(ms > 0) || !(width > 0)) return RIDE_GAP_MS;
  const need = width / routeLen;
  if (need >= 1) return ms;
  const key = `${Math.round(routeLen)}|${Math.round(ms)}|${String(easing)}|${Math.round(width)}`;
  const hit = clearCache.get(key);
  if (hit !== undefined) return hit;
  const table = easeTable(easing);
  const STEPS = 60;
  let answer = ms;
  for (let gap = RIDE_GAP_MS; gap < ms; gap += 10) {
    let ok = true;
    for (let i = 0; i <= STEPS && ok; i++) {
      const t = gap + ((ms - gap) * i) / STEPS;
      const lead = Math.min(1, easeFast(table, t / ms)), follow = Math.min(1, easeFast(table, (t - gap) / ms));
      if (follow < 1 && lead - follow < need) ok = false;
    }
    if (ok) { answer = gap; break; }
  }
  if (clearCache.size >= CLEAR_CACHE_MAX) clearCache.clear();
  clearCache.set(key, answer);
  return answer;
}

/** A route with its first `d` units cut off: a token rides out of a part's
 *  edge rather than being centred on it, where it would cover what is still
 *  sitting in the slot beside the edge. Never cuts the route to nothing. */
export function trimStart(route: readonly Point[], d: number): Point[] {
  const out = [...route];
  let left = Math.max(0, d);
  while (out.length > 2 && left > 0) {
    const a = out[0]!, b = out[1]!, len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > left) break;
    left -= len;
    out.shift();
  }
  if (out.length < 2 || left <= 0) return out;
  const a = out[0]!, b = out[1]!, len = Math.hypot(b.x - a.x, b.y - a.y);
  const k = Math.min(left, len / 2) / (len || 1);
  out[0] = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  return out;
}

/** A trace's points as a path with its corners rounded by `r` (never more
 *  than half of either leg, so a short leg does not fold back). Numbers only. */
export function roundedPath(points: readonly Point[], r = 14): string {
  const pts = dedupe([...points]);
  if (pts.length === 0) return "";
  const f = (n: number) => n.toFixed(1);
  let d = `M${f(pts[0]!.x)} ${f(pts[0]!.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!, b = pts[i]!, c = pts[i + 1]!;
    const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = b.x + ((a.x - b.x) / l1) * rr, ay = b.y + ((a.y - b.y) / l1) * rr;
    const cx = b.x + ((c.x - b.x) / l2) * rr, cy = b.y + ((c.y - b.y) / l2) * rr;
    d += ` L${f(ax)} ${f(ay)} Q${f(b.x)} ${f(b.y)} ${f(cx)} ${f(cy)}`;
  }
  const e = pts[pts.length - 1]!;
  return pts.length === 1 ? d : `${d} L${f(e.x)} ${f(e.y)}`;
}

/** A needle's angle in degrees: -90 (empty, pointing left) to 90 (full). */
export const needleAngle = (value: unknown, max: unknown): number => -90 + 180 * fraction(value, max);

/**
 * An odometer's cells: each digit of `value` written with `digits` decimals,
 * and the characters between them (a point, a sign) as fixed glyphs. A cell
 * is a column of 0-9 slid to its digit, so a change rolls instead of blinking.
 */
export function odometerCells(value: unknown, digits: unknown): ({ digit: number } | { glyph: string })[] | null {
  const d = typeof digits === "number" && Number.isFinite(digits) ? Math.min(6, Math.max(0, Math.trunc(digits))) : 0;
  const v = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const text = v.toFixed(d);
  // Past ODO_MAX_DIGITS rolling cells the view writes the number as text: a
  // cell is a strip of ten digits, and a trillion is not read by its rolling.
  if (text.replace(/\D/g, "").length > ODO_MAX_DIGITS) return null;
  return [...text].map((ch) => (ch >= "0" && ch <= "9" ? { digit: ch.charCodeAt(0) - 48 } : { glyph: ch }));
}

/** The most rolling cells an odometer draws. */
export const ODO_MAX_DIGITS = 10;

const pt = (v: unknown): Point | undefined =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number" ? { x: v[0], y: v[1] } : undefined;

/** A part's box, from its props, in board units. */
export function partRect(n: CanvasNode): Rect | undefined {
  const x = n.x, y = n.y, w = n.w, h = n.h;
  if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") return undefined;
  return { x, y, w, h };
}

/** The board a node is drawn in, walking up its parents; undefined when it is not in one. */
export function boardOf(id: string, byId: ReadonlyMap<string, CanvasNode>): string | undefined {
  for (let cur = byId.get(id), hops = 0; cur && hops <= CANVAS_LIMITS.depth + 1; cur = cur.parent === undefined ? undefined : byId.get(cur.parent), hops++) {
    if (cur.type === "board") return cur.id;
  }
  return undefined;
}

/**
 * Every trace drawn in a board, in board units. An edge with `points` follows
 * them. One without follows an elbow between the centres of the parts its
 * ends are in (the part itself, or the part around the node it names): out
 * along the source's row, then down the target's column. A trace runs UNDER
 * the parts, so leaving from a centre is what makes it look plugged in.
 */
export function boardRoutes(scene: CanvasScene): Map<string, Point[]> {
  const byId = new Map(scene.map((n) => [n.id, n] as const));
  const partOf = (id: unknown): Rect | undefined => {
    if (typeof id !== "string") return undefined;
    for (let cur = byId.get(id), hops = 0; cur && hops <= CANVAS_LIMITS.depth + 1; cur = cur.parent === undefined ? undefined : byId.get(cur.parent), hops++) {
      if (cur.type === "part") return partRect(cur);
    }
    return undefined;
  };
  const out = new Map<string, Point[]>();
  for (const e of scene) {
    if (e.type !== "edge" || e.parent === undefined || byId.get(e.parent)?.type !== "board") continue;
    if (Array.isArray(e.points)) {
      const pts = e.points.map(pt).filter((p): p is Point => p !== undefined);
      if (pts.length >= 2) { out.set(e.id, pts); continue; }
    }
    const a = partOf(e.from), b = partOf(e.to);
    if (!a || !b) continue;
    const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const route = dedupe([ca, { x: cb.x, y: ca.y }, cb]);
    if (route.length >= 2) out.set(e.id, route);
  }
  return out;
}

/**
 * The etched lines and vias on a board's ground: decorative, and the same
 * every time for the same board, so a redraw never reshuffles the machine.
 * Seeded from the board's id; on the 24-unit grid.
 */
export function etching(seed: string, w: number, h: number, count = 26): { d: string; via: Point }[] {
  let s = 7;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) % 2147483647;
  if (s <= 0) s += 2147483646;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out: { d: string; via: Point }[] = [];
  for (let i = 0; i < count; i++) {
    const x = Math.round((rnd() * w) / 24) * 24, y = Math.round((rnd() * h) / 24) * 24;
    const l = (2 + Math.floor(rnd() * 5)) * 24, across = rnd() > 0.5, turn = rnd() > 0.5 ? 24 : -24;
    out.push({ d: across ? `M${x} ${y}h${l}v${turn}h24` : `M${x} ${y}v${l}h${turn}v24`, via: { x, y } });
  }
  return out;
}
