/**
 * What a plugin may draw LIVE, as data: a scene of nodes and a stream of
 * operations on it.
 *
 * A panel drawn with `UiNode` (pluginUi.ts) is a document the plugin re-posts
 * whenever it changes. A canvas is a small retained scene that changes many
 * times a second: things arrive in a lane, wait behind a gate, ride a wire to
 * the next stage, leave. The plugin says WHAT is where; the app decides how it
 * is laid out, routed, coloured and moved. No pixel, no colour, no style, no
 * URL and nothing that runs: the same promise `pluginUi.ts` makes, for the
 * same reason (the window holds the API token and can open a shell).
 *
 * Two files hold the rules and both sides run them: this one (the vocabulary
 * and a pure reducer, used by the server to keep the retained scene and by the
 * window to keep its copy) and server/src/plugin-canvas.ts (who may send, how
 * fast, how big). A batch of operations is atomic: one bad operation refuses
 * the whole batch, so a window and the server never disagree about the scene.
 *
 * A scene is either the house flow layout (lanes that hold tokens, wires
 * routed between measured boxes) or a BOARD: a stage of fixed width and height
 * that the app scales as a whole, with `part`s at fixed places and depths,
 * `bay`s of slots that hold tokens, and `edge`s that follow a list of points
 * drawn under the parts. Nothing about it is one plugin's: a build farm or a
 * queue monitor draws a machine with the same words. Why a stage and not more
 * layout: a machine is about where things are, and measured routing cannot say
 * "this trace runs under that part".
 *
 * A scene can also hold a SHEET (canvasSheet.ts): an SVG instrument of fixed
 * size, a body and a tilted ring of stations with a clock round it. A sheet
 * does tilt and roll, but only as two numbers on a plane, never as a transform
 * the plugin writes; what a board cannot do holds for it too.
 *
 * What a board cannot do, chosen: no rotation of a part, no free drawing (a trace is a
 * short list of integer points, never a path string), and no plugin CSS. A
 * part's box is not checked against its board when it is written, because a
 * later `set` on the board could make it wrong; the window clips to the board.
 *
 * Ceilings, chosen: no arbitrary drawing and no per-frame code from a plugin;
 * no links (the tree's `link` node shows its host, a canvas has none yet); no
 * Markdown anywhere, because it renders images by URL and a scene must never
 * make the window fetch something on its own. Motion is a fixed set of named
 * one-shots and `activity` states the app animates itself, and every one of
 * them collapses to nothing under `prefers-reduced-motion`.
 */
import { ACTION_ID_RE, CANVAS_ACTIVITY, CANVAS_ID_RE, CANVAS_LIMITS, INVISIBLE, SHEET_LIMITS, action, activity, bool, idRef, num, oneOf, shortStr, toneCheck, unitStr, PERIOD, UNTIL, type CanvasActivity, type Check } from "./canvasChecks.ts";

import { ADD_ONLY, EDGE_EXTRA, GAUGE_EXTRA, GAUGE_SHAPES, SHEET_CONTAINERS, SHEET_REQUIRED, SHEET_SPEC, SHEET_TYPES, TOKEN_EXTRA, contextError, dependants, invariantError, sceneError, sheetPlaceError } from "./canvasSheet.ts";

export { CANVAS_ACTIVITY, CANVAS_ID_RE, CANVAS_LIMITS, SHEET_LIMITS };
export type { CanvasActivity };



/** The board's own units: a part and a point are placed in these, and the
 *  window scales the stage as a whole. */
export const CANVAS_BOARD_MAX = { w: 2400, h: 1600 } as const;


/** A word the app maps to its own glyph. A plugin ships no image. */
export const CANVAS_ICONS = ["dot", "lock", "unlock", "check", "cross", "bolt", "alert", "clock", "eye", "database", "shield", "arrow", "gate", "spark"] as const;
export type CanvasIcon = (typeof CANVAS_ICONS)[number];

/** Named curves; the window maps each to a CSS timing function. */
export const CANVAS_EASINGS = ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "spring"] as const;
export type CanvasEasing = (typeof CANVAS_EASINGS)[number];


export const CANVAS_CONTAINERS = ["stack", "row", "lane", "board", "part", "bay", ...SHEET_CONTAINERS] as const;
export const CANVAS_TYPES = [
  "stack", "row", "lane", "board", "part", "bay",
  "token", "label", "counter", "stat", "badge", "icon", "spark", "gauge", "countdown",
  "edge",
  "button", "segmented", "disclosure",
  "gate", "press", "core", "item", "lamp",
  ...SHEET_TYPES,
] as const;
export type CanvasType = (typeof CANVAS_TYPES)[number];

export interface CanvasAction { id: string; payload?: unknown }

/** One node, flat: `parent` is an id (absent = the root) and siblings keep
 *  the order they have in the scene array. The rest is that type's props. */
export interface CanvasNode { id: string; type: CanvasType; parent?: string; [prop: string]: unknown }
export type CanvasScene = CanvasNode[];

export type CanvasOp =
  | { op: "add"; node: CanvasNode; before?: string }
  | { op: "set"; id: string; props: Record<string, unknown> }
  | { op: "move"; id: string; parent?: string | null; before?: string; via?: string; ms?: number; easing?: CanvasEasing }
  | { op: "remove"; id: string }
  | { op: "clear" }
  | { op: "animate"; id: string; kind: "enter" | "exit" | "pulse"; ms?: number };

const encoder = new TextEncoder();
/** Bytes on the wire, not UTF-16 units: 128 K units of CJK text is three times that. */
export const sizeOf = (v: unknown): number => encoder.encode(JSON.stringify(v)).length;

/** What the private socket sends a window (server/src/plugin-canvas.ts) and
 *  what the window sends back: `{type:"subscribe"|"unsubscribe", plugin, panel}`.
 *  A frame that does not follow what the window has is always a `snapshot`,
 *  never a guess, so the window never has to reconcile. */
export type CanvasFrame =
  | { type: "snapshot"; plugin: string; panel: string; epoch: number; version: number; scene: CanvasScene; running: boolean }
  | { type: "ops"; plugin: string; panel: string; epoch: number; from: number; to: number; ops: CanvasOp[] }
  | { type: "gone"; plugin: string; panel: string };

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

// ---------------------------------------------------------------- props

const iconCheck: Check = oneOf(CANVAS_ICONS);
const gap: Check = oneOf(["sm", "md", "lg"] as const);
const grow: Check = num(1, 4, true);
const size: Check = oneOf(["sm", "md", "lg"] as const);

const sparkValues: Check = (v) => {
  if (!Array.isArray(v) || v.length > CANVAS_LIMITS.spark) return undefined;
  const out: number[] = [];
  for (const n of v) {
    if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e12) return undefined;
    out.push(n);
  }
  return out;
};

const options: Check = (v) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > CANVAS_LIMITS.options) return undefined;
  const out: { value: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const o of v) {
    if (!o || typeof o !== "object") return undefined;
    const r = o as Record<string, unknown>;
    const value = typeof r.value === "string" && ACTION_ID_RE.test(r.value) ? r.value : undefined;
    const label = shortStr(r.label);
    if (value === undefined || label === undefined || seen.has(value)) return undefined;
    seen.add(value);
    out.push({ value, label: label as string });
  }
  return out;
};

/** A trace: 2..12 `[x, y]` integer pairs in board units. Rebuilt pair by pair,
 *  so nothing the plugin holds a reference to ends up in the scene. */
const points: Check = (v) => {
  if (!Array.isArray(v) || v.length < 2 || v.length > CANVAS_LIMITS.points) return undefined;
  const px = num(0, CANVAS_BOARD_MAX.w, true);
  const py = num(0, CANVAS_BOARD_MAX.h, true);
  const out: [number, number][] = [];
  for (let i = 0; i < v.length; i++) {
    const p: unknown = v[i];
    if (!Array.isArray(p) || p.length !== 2) return undefined;
    const x = px(p[0]);
    const y = py(p[1]);
    if (x === undefined || y === undefined) return undefined;
    out.push([x as number, y as number]);
  }
  return out;
};

const text = (max: number): Check => (v) => (typeof v === "string" && v.length <= max ? v : undefined);

/** Props each type accepts. Anything else is refused by name, so a typo and an
 *  attempt (`style`, `href`, `onclick`, `innerHTML`) fail the same way. */
const SPEC: Record<CanvasType, Record<string, Check>> = {
  stack: { gap, grow },
  row: { gap, grow, align: oneOf(["start", "center", "between"] as const), wrap: bool },
  lane: { title: shortStr, state: oneOf(["open", "closed", "sealed"] as const), layout: oneOf(["list", "grid", "pile"] as const), icon: iconCheck, activity, tone: toneCheck, grow },
  token: { label: shortStr, tone: toneCheck, size, count: num(0, 1e9, true), icon: iconCheck, activity, ...TOKEN_EXTRA },
  label: { text: shortStr, tone: toneCheck, size, mono: bool },
  counter: { label: shortStr, value: num(-1e12, 1e12), unit: unitStr, tone: toneCheck, digits: num(0, 6, true), prefix: (v) => (typeof v === "string" && v.length <= 4 && !INVISIBLE.test(v) ? v : undefined), style: oneOf(["plain", "odometer"] as const) },
  stat: { label: shortStr, value: shortStr, hint: shortStr, tone: toneCheck },
  badge: { text: shortStr, tone: toneCheck },
  icon: { icon: iconCheck, tone: toneCheck, label: shortStr },
  spark: { values: sparkValues, cap: num(-1e12, 1e12), tone: toneCheck },
  gauge: { shape: oneOf(["arc", "ring", "bar", "pips", "needle", ...GAUGE_SHAPES] as const), ...GAUGE_EXTRA, value: num(0, 1e9), max: num(1, 1e9), label: shortStr, tone: toneCheck, digits: num(0, 4, true), hideMax: bool },
  countdown: { until: UNTIL, label: shortStr, tone: toneCheck, shape: oneOf(["text", "ring"] as const), period: PERIOD },
  edge: { from: idRef, to: idRef, activity, tone: toneCheck, label: shortStr, kind: oneOf(["trace", "control", "seal"] as const), points, ...EDGE_EXTRA },
  button: { label: shortStr, action, tone: oneOf(["primary", "default", "danger"] as const), confirm: shortStr, disabled: bool },
  segmented: { label: shortStr, options, value: (v) => (typeof v === "string" && ACTION_ID_RE.test(v) ? v : undefined), action, style: oneOf(["chips", "lever"] as const) },
  disclosure: { title: shortStr, text: text(CANVAS_LIMITS.disclosure), open: bool },
  board: { w: num(320, CANVAS_BOARD_MAX.w, true), h: num(200, CANVAS_BOARD_MAX.h, true), material: oneOf(["glass", "plain"] as const), label: shortStr },
  part: { x: num(0, CANVAS_BOARD_MAX.w, true), y: num(0, CANVAS_BOARD_MAX.h, true), w: num(24, CANVAS_BOARD_MAX.w, true), h: num(24, CANVAS_BOARD_MAX.h, true), depth: num(0, 4, true), step: num(1, 99, true), title: shortStr, hint: shortStr, tone: toneCheck, action },
  bay: { cols: num(1, 12, true), rows: num(1, 8, true), sealed: bool, caption: shortStr },
  gate: { state: oneOf(["open", "closed"] as const), value: num(0, 1e9), max: num(1, CANVAS_LIMITS.pips, true), label: shortStr, tone: toneCheck },
  press: { activity, label: shortStr, tone: toneCheck },
  core: { title: shortStr, value: shortStr, unit: unitStr, hint: shortStr, hint2: shortStr, activity, tone: toneCheck },
  item: { title: shortStr, rank: num(1, 999, true), meta: shortStr, badge: shortStr, badgeTone: toneCheck, dim: bool, selected: bool, action },
  lamp: { tone: toneCheck, label: shortStr, on: bool },
  ...SHEET_SPEC,
};

/** What a type needs before it can be drawn. */
const REQUIRED: Partial<Record<CanvasType, string[]>> = {
  token: ["label"], label: ["text"], counter: ["label", "value"], stat: ["label", "value"], badge: ["text"],
  icon: ["icon"], spark: ["values"], gauge: ["shape", "value", "max"], countdown: ["until"],
  edge: ["from", "to"], button: ["label", "action"], segmented: ["options", "value", "action"], disclosure: ["title", "text"],
  board: ["w", "h"], part: ["x", "y", "w", "h"], bay: ["cols", "rows"], gate: ["state"], item: ["title"],
  ...SHEET_REQUIRED,
};

const isContainer = (t: CanvasType) => (CANVAS_CONTAINERS as readonly string[]).includes(t);
const isType = (v: unknown): v is CanvasType => typeof v === "string" && (CANVAS_TYPES as readonly string[]).includes(v);
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Where a type may be written, for `add` and `move` alike. `parent` is the
 *  node it would sit in, undefined for the root. Returns the refusal or nothing. */
function placeError(w: Working, n: CanvasNode, parent: CanvasNode | undefined, moving: boolean): string | undefined {
  const pt = parent?.type;
  if (n.type === "board") {
    if (parent) return "a board lives at the root";
    if (!moving && w.order.filter((x) => x.type === "board").length >= CANVAS_LIMITS.boards) return `at most ${CANVAS_LIMITS.boards} boards in a scene`;
  }
  // The window draws only parts and edges directly in a board; anything else
  // there would be invisible and still spend the loop and node budgets.
  if (pt === "board" && n.type !== "part" && n.type !== "edge") return "a board holds only parts and edges";
  if (n.type === "part" && pt !== "board") return "a part lives directly in a board";
  if (n.type === "bay" && pt !== "part") return "a bay lives directly in a part";
  if (pt === "bay" && n.type !== "token") return "a bay holds only tokens";
  if (n.type === "edge" && parent && pt !== "board" && pt !== "plane") return "an edge lives at the root, directly in a board or directly in a plane";
  if (n.type === "edge" && n.points !== undefined && pt !== "board") return "an edge with points lives directly in a board";
  return sheetPlaceError(n, parent);
}

/** A bay's grid is checked on what the node would be, not on the op. */
function slotsError(n: CanvasNode): string | undefined {
  return n.type === "bay" && typeof n.cols === "number" && typeof n.rows === "number" && n.cols * n.rows > CANVAS_LIMITS.slots
    ? `a bay holds at most ${CANVAS_LIMITS.slots} slots (cols x rows)` : undefined;
}

/** Everything a node may be given where it sits: its place, its slots, what it
 *  may say in that place and the rules that span its props. Run on the node as
 *  it WOULD be, for add, set and move alike. */
function shapeError(w: Working, n: CanvasNode, parent: CanvasNode | undefined, moving: boolean): string | undefined {
  return placeError(w, n, parent, moving) ?? slotsError(n) ?? contextError(n, parent) ?? invariantError(n);
}

/** A gauge never reads past full: clamped where the prop is written, add or set. */
function clampGauge(type: CanvasType, props: Record<string, unknown>): void {
  if (type === "gauge" && typeof props.value === "number" && typeof props.max === "number" && props.value > props.max) props.value = props.max;
}

function cleanProps(type: CanvasType, raw: Record<string, unknown>, what: string, partial: boolean): Ok<Record<string, unknown>> | Err {
  const spec = SPEC[type];
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) {
    if (!hasOwn(spec, k)) return { ok: false, error: `${what}: "${k}" is not a property of ${type}` };
    if (raw[k] === null) { if (!partial) return { ok: false, error: `${what}: ${k} may not be null when adding` }; out[k] = null; continue; }
    const v = spec[k]!(raw[k]);
    if (v === undefined) return { ok: false, error: `${what}: ${k} is not a valid ${type} ${k}` };
    out[k] = v;
  }
  if (!partial) for (const r of REQUIRED[type] ?? []) if (out[r] === undefined) return { ok: false, error: `${what}: ${type} needs ${r}` };
  if (partial) for (const r of REQUIRED[type] ?? []) if (out[r] === null) return { ok: false, error: `${what}: ${r} cannot be unset on ${type}` };
  clampGauge(type, out);
  return { ok: true, value: out };
}

// ---------------------------------------------------------------- reducer

/** The working copy of a scene a batch changes. Copy on write: a node is
 *  cloned the first time an op touches it and not before, so what comes out
 *  shares every untouched node with what went in. The window memoises on that
 *  (a sheet whose nodes are the same objects is not redrawn), and the input is
 *  never mutated. The cost: `scene` out holds the caller's node objects, so a
 *  caller must treat a node as frozen. */
class Working {
  byId = new Map<string, CanvasNode>();
  order: CanvasNode[];
  private readonly owned = new Set<CanvasNode>();
  constructor(scene: CanvasScene) {
    this.order = [...scene];
    for (const n of this.order) this.byId.set(n.id, n);
  }
  /** The node to write to: a private copy, in the same place in the scene. */
  own(n: CanvasNode): CanvasNode {
    if (this.owned.has(n)) return n;
    const c = { ...n };
    this.order[this.order.indexOf(n)] = c;
    this.byId.set(c.id, c);
    this.owned.add(c);
    return c;
  }
  kids(parent: string | undefined): CanvasNode[] { return this.order.filter((n) => (n.parent ?? undefined) === parent); }
  depthOf(id: string | undefined): number {
    let d = 0;
    for (let cur = id; cur !== undefined; d++) {
      if (d > CANVAS_LIMITS.depth + 2) return d;
      cur = this.byId.get(cur)?.parent;
    }
    return d;
  }
  /** Depth of the deepest node under `id`, counting `id` as 1. */
  heightOf(id: string): number {
    if (!isContainer(this.byId.get(id)?.type as CanvasType)) return 1;
    let h = 1;
    for (const k of this.kids(id)) h = Math.max(h, 1 + this.heightOf(k.id));
    return h;
  }
  subtree(id: string): Set<string> {
    const out = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of this.order) if (n.parent !== undefined && out.has(n.parent) && !out.has(n.id)) { out.add(n.id); grew = true; }
    }
    return out;
  }
  removeSet(ids: Set<string>): void {
    this.order = this.order.filter((n) => !ids.has(n.id));
    for (const id of ids) this.byId.delete(id);
  }
  /** Put `n` among `parent`'s children, before `before` or last. */
  place(n: CanvasNode, parent: string | undefined, before: string | undefined): boolean {
    this.order = this.order.filter((x) => x !== n);
    this.owned.add(n);
    if (before !== undefined) {
      const b = this.byId.get(before);
      if (!b || b === n || (b.parent ?? undefined) !== parent) return false;
      this.order.splice(this.order.indexOf(b), 0, n);
    } else {
      this.order.push(n);
    }
    if (parent === undefined) delete n.parent; else n.parent = parent;
    return true;
  }
}

function applyOne(w: Working, raw: unknown, i: number): Ok<CanvasOp> | Err {
  const at = `op ${i}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `${at} must be an object` };
  const o = raw as Record<string, unknown>;
  const need = (id: unknown): CanvasNode | string => {
    if (typeof id !== "string" || !CANVAS_ID_RE.test(id)) return `${at}: id must match ${CANVAS_ID_RE}`;
    return w.byId.get(id) ?? `${at}: no node "${id}"`;
  };
  const optRef = (v: unknown, name: string): string | undefined | Err => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !CANVAS_ID_RE.test(v)) return { ok: false, error: `${at}: ${name} must be a node id` };
    return v;
  };
  const optMs = (v: unknown, where: string): number | undefined | Err => {
    if (v === undefined) return undefined;
    const ms = num(0, CANVAS_LIMITS.ms)(v);
    return ms === undefined ? { ok: false, error: `${where}: ms must be 0-${CANVAS_LIMITS.ms}` } : (ms as number);
  };
  const isErr = (v: unknown): v is Err => !!v && typeof v === "object" && (v as Err).ok === false;

  switch (o.op) {
    case "add": {
      const nr = o.node;
      if (!nr || typeof nr !== "object" || Array.isArray(nr)) return { ok: false, error: `${at}: add needs a node` };
      const { id, type, parent, ...rest } = nr as Record<string, unknown>;
      if (typeof id !== "string" || !CANVAS_ID_RE.test(id)) return { ok: false, error: `${at}: node id must match ${CANVAS_ID_RE}` };
      if (w.byId.has(id)) return { ok: false, error: `${at}: "${id}" already exists (use set)` };
      if (!isType(type)) return { ok: false, error: `${at}: unknown node type` };
      const p = optRef(parent, "parent");
      if (isErr(p)) return p;
      if (p !== undefined) {
        const pn = w.byId.get(p);
        if (!pn) return { ok: false, error: `${at}: no parent "${p}"` };
        if (!isContainer(pn.type)) return { ok: false, error: `${at}: ${pn.type} cannot hold children` };
      }
      if (w.depthOf(p) + 1 > CANVAS_LIMITS.depth) return { ok: false, error: `${at}: deeper than ${CANVAS_LIMITS.depth}` };
      if (w.order.length + 1 > CANVAS_LIMITS.nodes) return { ok: false, error: `${at}: more than ${CANVAS_LIMITS.nodes} nodes` };
      const props = cleanProps(type, rest, at, false);
      if (!props.ok) return props;
      const before = optRef(o.before, "before");
      if (isErr(before)) return before;
      const node: CanvasNode = { id, type, ...props.value };
      const where = shapeError(w, node, p === undefined ? undefined : w.byId.get(p), false);
      if (where) return { ok: false, error: `${at}: ${where}` };
      w.byId.set(id, node);
      if (!w.place(node, p, before)) { w.byId.delete(id); return { ok: false, error: `${at}: "before" is not a child of that parent` }; }
      return { ok: true, value: { op: "add", node: { ...node }, ...(before ? { before } : {}) } };
    }
    case "set": {
      const n = need(o.id);
      if (typeof n === "string") return { ok: false, error: n };
      if (!o.props || typeof o.props !== "object" || Array.isArray(o.props)) return { ok: false, error: `${at}: set needs props` };
      const props = cleanProps(n.type, o.props as Record<string, unknown>, at, true);
      if (!props.ok) return props;
      for (const k of ADD_ONLY[n.type] ?? []) if (hasOwn(props.value, k)) return { ok: false, error: `${at}: ${k} of a ${n.type} is set when it is added and never changed` };
      // What the node WOULD be: a half-applied set is never left in the scene.
      const merged: CanvasNode = { ...n };
      for (const [k, v] of Object.entries(props.value)) { if (v === null) delete merged[k]; else merged[k] = v; }
      const where = shapeError(w, merged, n.parent === undefined ? undefined : w.byId.get(n.parent), true);
      if (where) return { ok: false, error: `${at}: ${where}` };
      const mine = w.own(n);
      for (const k of Object.keys(props.value)) { if (merged[k] === undefined) delete mine[k]; else mine[k] = merged[k]; }
      clampGauge(mine.type, mine);
      return { ok: true, value: { op: "set", id: n.id, props: props.value } };
    }
    case "move": {
      const n = need(o.id);
      if (typeof n === "string") return { ok: false, error: n };
      if (o.parent !== undefined && o.parent !== null && (typeof o.parent !== "string" || !CANVAS_ID_RE.test(o.parent))) return { ok: false, error: `${at}: parent must be a node id or null` };
      const parent = o.parent === undefined ? n.parent : o.parent === null ? undefined : (o.parent as string);
      if (parent !== undefined) {
        const pn = w.byId.get(parent);
        if (!pn) return { ok: false, error: `${at}: no parent "${parent}"` };
        if (!isContainer(pn.type)) return { ok: false, error: `${at}: ${pn.type} cannot hold children` };
        if (w.subtree(n.id).has(parent)) return { ok: false, error: `${at}: a node cannot move into itself` };
      }
      const where = shapeError(w, n, parent === undefined ? undefined : w.byId.get(parent), true);
      if (where) return { ok: false, error: `${at}: ${where}` };
      if (w.depthOf(parent) + w.heightOf(n.id) > CANVAS_LIMITS.depth) return { ok: false, error: `${at}: deeper than ${CANVAS_LIMITS.depth}` };
      const before = optRef(o.before, "before");
      if (isErr(before)) return before;
      const via = optRef(o.via, "via");
      if (isErr(via)) return via;
      if (via !== undefined && w.byId.get(via)?.type !== "edge") return { ok: false, error: `${at}: via must name an edge` };
      const ms = optMs(o.ms, at);
      if (isErr(ms)) return ms;
      const easing = o.easing === undefined ? undefined : oneOf(CANVAS_EASINGS)(o.easing);
      if (o.easing !== undefined && easing === undefined) return { ok: false, error: `${at}: unknown easing` };
      if (!w.place(w.own(n), parent, before)) return { ok: false, error: `${at}: "before" is not a child of that parent` };
      return { ok: true, value: { op: "move", id: n.id, ...(o.parent !== undefined ? { parent: parent ?? null } : {}), ...(before ? { before } : {}), ...(via ? { via } : {}), ...(ms !== undefined ? { ms } : {}), ...(easing ? { easing: easing as CanvasEasing } : {}) } };
    }
    case "remove": {
      const n = need(o.id);
      if (typeof n === "string") return { ok: false, error: n };
      const gone = w.subtree(n.id);
      // A wire to something that is gone is not left dangling.
      for (const id of dependants(w.order, gone)) gone.add(id);
      w.removeSet(gone);
      return { ok: true, value: { op: "remove", id: n.id } };
    }
    case "clear":
      w.order = []; w.byId.clear();
      return { ok: true, value: { op: "clear" } };
    case "animate": {
      const n = need(o.id);
      if (typeof n === "string") return { ok: false, error: n };
      const kind = oneOf(["enter", "exit", "pulse"] as const)(o.kind);
      if (!kind) return { ok: false, error: `${at}: kind must be enter, exit or pulse` };
      const ms = optMs(o.ms, at);
      if (isErr(ms)) return ms;
      return { ok: true, value: { op: "animate", id: n.id, kind: kind as "enter" | "exit" | "pulse", ...(ms !== undefined ? { ms } : {}) } };
    }
    default:
      return { ok: false, error: `${at}: unknown op` };
  }
}

/**
 * Apply a batch, all or nothing. Returns the new scene and the operations as
 * they were understood (cleaned, unknown keys refused, numbers clamped to
 * range), which are what the window replays; a caller must never forward the
 * raw ones. The input scene is not touched.
 */
export function applyOps(scene: CanvasScene, raw: unknown): Ok<{ scene: CanvasScene; ops: CanvasOp[] }> | Err {
  if (!Array.isArray(raw)) return { ok: false, error: "ops must be a list" };
  if (raw.length > CANVAS_LIMITS.batchOps) return { ok: false, error: `at most ${CANVAS_LIMITS.batchOps} ops in a batch` };
  const w = new Working(scene);
  const r = runOps(w, raw);
  return r.ok ? { ok: true, value: { scene: w.order, ops: r.value } } : r;
}

/** Every op in order on `w`, then the size of what is left. */
function runOps(w: Working, raw: unknown[]): Ok<CanvasOp[]> | Err {
  const ops: CanvasOp[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = applyOne(w, raw[i], i);
    if (!r.ok) return r;
    ops.push(r.value);
  }
  let bytes: number;
  try { bytes = sizeOf(w.order); } catch { return { ok: false, error: "scene is not JSON" }; }
  if (bytes > CANVAS_LIMITS.sceneBytes) return { ok: false, error: `scene would be over ${CANVAS_LIMITS.sceneBytes} bytes` };
  const across = sceneError(w.order);
  if (across) return { ok: false, error: across };
  return { ok: true, value: ops };
}

/** A scene from the wire (a snapshot), checked as if it were one big batch of
 *  adds: the window trusts what the server kept, but not the shape. */
export function validateScene(raw: unknown): Ok<CanvasScene> | Err {
  if (!Array.isArray(raw)) return { ok: false, error: "scene must be a list" };
  if (raw.length > CANVAS_LIMITS.nodes) return { ok: false, error: `more than ${CANVAS_LIMITS.nodes} nodes` };
  // A scene that had a container moved keeps its children earlier in the
  // array than their parent, and the replay adds in order: parents go first,
  // siblings keep the order they had. One working copy and one size check for
  // the whole snapshot, not one per hundred nodes.
  const w = new Working([]);
  const r = runOps(w, parentsFirst(raw).map((node) => ({ op: "add", node })));
  return r.ok ? { ok: true, value: w.order } : r;
}

function parentsFirst(raw: unknown[]): unknown[] {
  const kids = new Map<string | undefined, unknown[]>();
  for (const n of raw) {
    const parent = n && typeof n === "object" && typeof (n as CanvasNode).parent === "string" ? (n as CanvasNode).parent : undefined;
    let l = kids.get(parent);
    if (!l) kids.set(parent, (l = []));
    l.push(n);
  }
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  // A walk from the roots: each node, then its children in the order they had.
  const walk = (list: unknown[] | undefined, depth: number): void => {
    if (!list || depth > CANVAS_LIMITS.depth + 2) return;
    for (const n of list) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
      const id = n && typeof n === "object" ? (n as CanvasNode).id : undefined;
      if (typeof id === "string") walk(kids.get(id), depth + 1);
    }
  };
  walk(kids.get(undefined), 0);
  // What the walk did not reach has a parent that is missing or a cycle: left
  // in place for the replay to refuse by name.
  for (const n of raw) if (!seen.has(n)) out.push(n);
  return out;
}

/** Motion the window may run. Under reduced motion every duration is 0 and
 *  no loop runs: the scene still changes, it just does not travel. */
export function effectiveMs(ms: number | undefined, fallback: number, reducedMotion: boolean): number {
  return reducedMotion ? 0 : Math.min(ms ?? fallback, CANVAS_LIMITS.ms);
}

/** A flowing edge draws this many travelling marks, each its own looping animation. */
export const CANVAS_FLOW_MARKS = 3;

/** A busy `core` runs a spin and a pulse, a busy `press` two jaws: two looping
 *  animations each, so each is charged two. */
export const CANVAS_INSTRUMENT_LOOPS = 2;

/** Which nodes may loop, in scene order, until the budget of looping
 *  ANIMATIONS (not nodes) is spent: a flowing edge costs its marks. The rest
 *  draw still. */
export function loopingIds(scene: CanvasScene, reducedMotion: boolean): Set<string> {
  const out = new Set<string>();
  if (reducedMotion) return out;
  let spent = 0;
  for (const n of scene) {
    if (!((n.type === "edge" || n.type === "token" || n.type === "lane" || n.type === "core" || n.type === "press") && (n.activity === "busy" || n.activity === "flowing"))) continue;
    const cost = n.type === "edge" && n.activity === "flowing" ? CANVAS_FLOW_MARKS : n.type === "core" || n.type === "press" ? CANVAS_INSTRUMENT_LOOPS : 1;
    if (spent + cost > CANVAS_LIMITS.loops) break;
    spent += cost;
    out.add(n.id);
  }
  return out;
}
