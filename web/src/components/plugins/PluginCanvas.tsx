import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { effectiveMs, loopingIds, type CanvasAction, type CanvasNode, type CanvasOp, type CanvasScene } from "../../../../shared/pluginCanvas.ts";
import type { Tone } from "../../../../shared/pluginUi.ts";
import { bgIsDark } from "../../lib/bootPaint.ts";
import { subscribeCanvas } from "../../lib/canvasLive.ts";
import { EMPTY_CANVAS, type CanvasState } from "../../lib/canvasState.ts";
import {
  PILE_MAX, SLOT_GAP, actionWithValue, arcPath, boardOf, boardRoutes, childrenIndex, pathLength, rideClearMs, trimStart, clampGrow, formatCountdown, fraction, parentsFirst, pathData,
  pileSplit, planFlip, rectOrAncestor, routeEdge, sparkPoints, type Point, type Rect,
} from "../../lib/canvasGeometry.ts";
import { CanvasMotion, FLOW_BUSY_MS, FLOW_MARKS, TRAVEL_MS } from "../../lib/canvasMotion.ts";
import { LUMA_MS, LUMA_MS_REDUCED, gateScene, type GateState } from "../../lib/canvasFlash.ts";
import { useAtTween, usePanelFit } from "../../lib/canvasView.ts";
import { TONE_COLOR, TONE_INK } from "../../lib/pluginTones.ts";
import { ICON } from "../../lib/iconSize.ts";
import { useDialogs, type ConfirmSpec } from "../ConfirmDialog.tsx";
import { Spinner } from "../Spinner.tsx";
import { Button as HouseButton, CHIP, CHIP_SURFACE, CHIP_SURFACE_CLS, EDGE, chipTone } from "../workspace/Chrome.tsx";
import { boardLeaf, type BoardHandle } from "./CanvasBoard.tsx";
import { CanvasSheet } from "./CanvasSheet.tsx";
import { Dock, Fold, GaugeGlyph, isGlyphShape, useFoldPhaseOf } from "./CanvasDock.tsx";
import { fixed, fmt, iconOf, int, num, str, toneOf } from "./canvasRead.ts";
import { CanvasGlyph } from "./panelGlyph.tsx";
import { PluginNotRunning } from "./PluginNotRunning.tsx";

/**
 * A plugin's LIVE panel: a scene of nodes it changes many times a second, drawn
 * with this app's own parts.
 *
 * The plugin says what is where (shared/pluginCanvas.ts); this file decides how
 * it is laid out, routed, coloured and moved. Nothing a scene carries reaches
 * a style, a selector or the DOM as markup: a tone, a gap, an easing and an icon
 * are words looked up in a table, every number is clamped first, text is text,
 * and a node is found by a ref, never by its id. There is no Markdown here, no
 * image, no link and no frame, on purpose: the window holds the API token, and
 * a scene must never make it fetch or open anything on its own.
 *
 * `onAction` is the only way out, the same as PluginTree.
 *
 * Wires are drawn ABOVE the layout, not under it: a lane is an opaque card, and
 * a wire between two chips in two lanes would vanish behind both. They do not
 * take the pointer, and a route runs between node edges, so they do not cover
 * what a person reads or presses.
 *
 * A `board` is the other way to draw: a stage of fixed units scaled as a
 * whole, with its traces UNDER its parts (CanvasBoard.tsx). What a board adds
 * here is only arithmetic: its traces come from props, not from measuring,
 * and a motion inside it is in board units, so a screen offset is divided by
 * the board's scale before it becomes a transform.
 */

export type CanvasActionFn = (action: CanvasAction) => void | Promise<void>;

interface Props {
  plugin: string;
  panel: string;
  /** Whether the plugin's process is up, as the panel list says. */
  running: boolean;
  onAction: CanvasActionFn;
}

const GAP = { sm: 6, md: 12, lg: 20 } as const;
const DIAL = 56;
const PIP_MAX = 40;

// ---------------------------------------------------------------- reading a node

const gapOf = (v: unknown, fallback: keyof typeof GAP): number => (v === "sm" || v === "md" || v === "lg" ? GAP[v] : GAP[fallback]);

/** A tint of a tone, as a ring (not a border: a border literal is a counted
 *  thing, and this is a mark, not an outline). */
const tint = (tone: Tone, fill: number, ring: number): CSSProperties => ({
  background: `color-mix(in srgb, ${TONE_COLOR[tone]} ${fill}%, transparent)`,
  boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${TONE_COLOR[tone]} ${ring}%, transparent)`,
});
const NEUTRAL: CSSProperties = { background: "color-mix(in srgb, var(--text) 5%, transparent)", border: EDGE };
const skin = (tone: Tone): CSSProperties => (tone === "default" || tone === "muted" ? NEUTRAL : tint(tone, 12, 30));

// ---------------------------------------------------------------- hooks

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const q = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** True while nobody can see the canvas: the window is hidden, or it is
 *  scrolled or switched away. Motion and the countdown's tick stop then. */
function useUnseen(ref: React.RefObject<HTMLElement>): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver((entries) => { for (const e of entries) setOnScreen(e.isIntersecting); });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return hidden || !onScreen;
}

/** Whether the painted theme is a dark one, by the app's own rule (the
 *  luminance of --bg): a board's materials are designed per scheme, and the
 *  theme is painted as variables on <html>, not as a class. */
function useDarkScheme(): boolean {
  const read = () => typeof document !== "undefined" && bgIsDark(getComputedStyle(document.documentElement).getPropertyValue("--bg"));
  const [dark, setDark] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver !== "function") return;
    const mo = new MutationObserver(() => setDark(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    setDark(read());
    return () => mo.disconnect();
  }, []);
  return dark;
}

/** The clock a countdown reads, ticking once a second and only while asked to. */
function useNow(tick: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!tick) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [tick]);
  return now;
}

/**
 * The scene as it is DRAWN: luminance-bearing props (an orb's light, a lit
 * band, a halo, a tone) take a new value at most once per 400 ms per node, 1 s
 * under reduced motion (canvasFlash.ts). The scene the reducer holds stays
 * exact; a plugin that flips a big state sixty times a second cannot flash the
 * window. The held value is applied by a timer, not by the next frame.
 */
function useDrawnScene(scene: CanvasScene, reduced: boolean): CanvasScene {
  const gate = useRef<GateState | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const out = useMemo(() => {
    void tick;
    const r = gateScene(gate.current, scene, Date.now(), reduced ? LUMA_MS_REDUCED : LUMA_MS);
    gate.current = r.state;
    return { shown: r.state.shown, nextAt: r.nextAt };
  }, [scene, reduced, tick]);
  useEffect(() => {
    clearTimeout(timer.current);
    if (out.nextAt !== undefined) timer.current = setTimeout(() => setTick((t) => t + 1), Math.max(0, out.nextAt - Date.now()));
    return () => clearTimeout(timer.current);
  }, [out]);
  return out.shown;
}

// ---------------------------------------------------------------- the canvas

interface Pending { before: Map<string, Rect> | null; ops: CanvasOp[] }

interface Routes { sig: string; byEdge: Map<string, Point[]> }
const NO_ROUTES: Routes = { sig: "", byEdge: new Map() };

export function PluginCanvas({ plugin, panel, running, onAction }: Props) {
  const [state, setState] = useState<CanvasState>(EMPTY_CANVAS);
  const [routes, setRoutes] = useState<Routes>(NO_ROUTES);
  const { ask, dialog } = useDialogs();
  const reduced = useReducedMotion();

  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>()).current;
  const marks = useRef(new Map<string, SVGElement>()).current;
  const boards = useRef(new Map<string, BoardHandle>()).current;
  const dark = useDarkScheme();
  const pending = useRef<Pending>({ before: null, ops: [] });
  const motionRef = useRef<CanvasMotion | null>(null);
  motionRef.current ??= new CanvasMotion();
  const motion = motionRef.current;

  const unseen = useUnseen(wrapRef);
  const drawn = useDrawnScene(state.scene, reduced);
  const scene = drawn;
  const kids = useMemo(() => childrenIndex(scene), [scene]);
  const parentOf = useMemo(() => {
    const m = new Map<string, string | undefined>();
    for (const n of scene) m.set(n.id, n.parent);
    return (id: string) => m.get(id);
  }, [scene]);
  const loops = useMemo(() => loopingIds(scene, reduced), [scene, reduced]);
  const byId = useMemo(() => new Map(scene.map((n) => [n.id, n] as const)), [scene]);
  const traces = useMemo(() => boardRoutes(scene), [scene]);
  const edges = useMemo(() => scene.filter((n) => n.type === "edge"), [scene]);
  // A countdown, and a clock's ticks that count to a time, need the 1 Hz ticker; nothing else does.
  const hasCountdown = useMemo(() => scene.some((n) => n.type === "countdown" || (n.type === "ticks" && n.until !== undefined)), [scene]);
  const now = useNow(hasCountdown && !unseen);
  const fit = usePanelFit(wrapRef);
  const at = useAtTween(scene, reduced, unseen);
  // Whether a fold is open is the window's: it survives a reconnect and is reset by nobody but the plugin or panel changing.
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  useEffect(() => { setFolds(new Map()); }, [plugin, panel]);
  const setFold = useCallback((id: string, open: boolean) => setFolds((m) => new Map(m).set(id, open)), []);
  const revealFold = useCallback(() => {
    const f = sceneRef.current.find((n) => n.type === "fold");
    if (f) setFolds((m) => (m.get(f.id) ?? f.open === true) ? m : new Map(m).set(f.id, true));
  }, []);

  const stopped = !running || state.gone || (state.loaded && !state.running);

  // Where every drawn node sits, relative to the stage, so scrolling the panel
  // changes nothing and a wire's ends are in the overlay's own coordinates.
  const measure = useCallback((): Map<string, Rect> => {
    const out = new Map<string, Rect>();
    const stage = stageRef.current;
    if (!stage) return out;
    const o = stage.getBoundingClientRect();
    for (const [id, el] of els) {
      const r = el.getBoundingClientRect();
      out.set(id, { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height });
    }
    return out;
  }, [els]);

  const sceneRef = useRef<CanvasScene>(scene);
  sceneRef.current = scene;
  const byIdRef = useRef(byId);
  byIdRef.current = byId;

  /** The board a node is drawn in and its scale now (screen px per board
   *  unit), or undefined for a node in the flow layout and for the board's
   *  own box, which sits in the flow. */
  const boardAt = useCallback((id: string): { handle: BoardHandle; scale: number } | undefined => {
    const b = boardOf(id, byIdRef.current);
    if (b === undefined || b === id) return undefined;
    const handle = boards.get(b);
    if (!handle) return undefined;
    const scale = handle.stage.getBoundingClientRect().width / handle.w;
    return scale > 0 ? { handle, scale } : undefined;
  }, [boards]);

  const relayout = useCallback((rects: Map<string, Rect>): Map<string, Point[]> => {
    const sc = sceneRef.current;
    const parents = new Map<string, string | undefined>();
    for (const n of sc) parents.set(n.id, n.parent);
    const byEdge = new Map<string, Point[]>();
    const boardIds = new Set(sc.filter((b) => b.type === "board" || b.type === "plane").map((b) => b.id));
    for (const e of sc) {
      if (e.type !== "edge") continue;
      // A board's traces are placed by the board, in its own units; an edge in a plane follows the plane, drawn by its sheet.
      if (e.parent !== undefined && boardIds.has(e.parent)) continue;
      const from = str(e.from), to = str(e.to);
      if (!from || !to || from === to) continue;
      const a = rectOrAncestor(from, rects, (id) => parents.get(id));
      const b = rectOrAncestor(to, rects, (id) => parents.get(id));
      if (a && b) byEdge.set(e.id, routeEdge(a, b));
    }
    const sig = [...byEdge].map(([id, r]) => `${id}${pathData(r)}`).join("|");
    setRoutes((prev) => (prev.sig === sig ? prev : { sig, byEdge }));
    return byEdge;
  }, []);

  // ------------------------------------------------------------ the socket

  useEffect(() => {
    setState(EMPTY_CANVAS);
    pending.current = { before: null, ops: [] };
    return subscribeCanvas(plugin, panel, (next, applied) => {
      if (applied && applied.length > 0) {
        const p = pending.current;
        // What things looked like BEFORE this change reaches the DOM: the first
        // frame since the last commit is the one that still sees the old layout.
        p.before ??= measure();
        p.ops.push(...applied);
        const layer = ghostRef.current, stage = stageRef.current;
        if (layer && stage) {
          const o = stage.getBoundingClientRect();
          for (const op of applied) {
            if (op.op !== "remove") continue;
            const el = els.get(op.id);
            if (!el) continue;
            const inBoard = boardAt(op.id);
            if (inBoard) {
              const b = inBoard.handle.stage.getBoundingClientRect();
              motion.exitClone(el, inBoard.handle.ghost, { left: b.left, top: b.top }, undefined, inBoard.scale);
            } else motion.exitClone(el, layer, { left: o.left, top: o.top });
          }
        }
      } else {
        pending.current = { before: null, ops: [] };
      }
      setState(next);
    });
  }, [plugin, panel, measure, els, motion, boardAt]);

  // ------------------------------------------------------------ motion

  useLayoutEffect(() => {
    motion.reduced = reduced;
    if (reduced) motion.cancelAll();
  }, [motion, reduced]);

  useEffect(() => {
    motion.setPaused(unseen);
  }, [motion, unseen]);

  useEffect(() => () => motion.cancelAll(), [motion]);

  // After every change to the scene: measure where things landed, work out the
  // wires, and start what the operations asked for.
  useLayoutEffect(() => {
    const after = measure();
    const byEdge = relayout(after);
    const p = pending.current;
    pending.current = { before: null, ops: [] };
    if (p.ops.length === 0) return;

    const added = new Set<string>();
    const rides = new Map<string, Extract<CanvasOp, { op: "move" }>>();
    for (const op of p.ops) {
      if (op.op === "add") added.add(op.node.id);
      else if (op.op === "move" && op.via) rides.set(op.id, op);
    }

    // Reduced motion: nothing travels or glows, but every step still shows.
    // The part a token arrived in, and whatever the plugin asked to pulse or
    // enter, is marked lit for a moment: a static outline, not a movement.
    if (reduced) {
      const partOf = (id: string): string => {
        for (let cur = byId.get(id), hops = 0; cur && hops < 8; cur = cur.parent === undefined ? undefined : byId.get(cur.parent), hops++) if (cur.type === "part") return cur.id;
        return id;
      };
      for (const id of rides.keys()) { const el = els.get(partOf(id)); if (el) motion.mark(el); }
      for (const op of p.ops) if (op.op === "animate" && op.kind !== "exit") { const el = els.get(op.id); if (el) motion.mark(el); }
    }

    // FLIP: everything that stayed but sits somewhere else slides from where it was.
    if (p.before && !reduced && !unseen) {
      // A token in a bay does not slide to its new slot: when the front of a
      // queue leaves, every slot shifts and the diagonal paths across a grid
      // cross each other. It takes its new slot in place; slots never overlap.
      const inBay = scene.filter((k) => k.type === "token" && k.parent !== undefined && byId.get(k.parent)?.type === "bay").map((k) => k.id);
      const shifts = planFlip(p.before, after, parentsFirst(scene), parentOf, new Set([...added, ...rides.keys(), ...inBay]), () => motion.budget.acquire());
      for (const s of shifts) {
        const el = els.get(s.id);
        if (!el) { motion.budget.release(); continue; }
        // Inside a board a transform is in board units.
        const k = boardAt(s.id)?.scale ?? 1;
        motion.shift(el, s.dx / k, s.dy / k);
      }
    }

    for (const [id, op] of rides) {
      const el = els.get(id);
      if (!el) continue;
      const trace = traces.get(op.via!);
      const inBoard = trace ? boardAt(id) : undefined;
      if (trace && inBoard) {
        // A ride on a board trace, in board units, spaced behind the last one
        // on the same trace; one that would start too late lands in place.
        // Everything that costs is decided after the cheap refusals: a ride
        // that cannot start (reduced, hidden, budget full) or that is already
        // too late behind the last one lands in place and spends nothing.
        if (!motion.canStart()) continue;
        const now = performance.now();
        if (motion.rideTurn(op.via!, now) === null) { motion.enter(el); continue; }
        // Measured at rest: a motion still running on it would offset the landing.
        motion.stop(el);
        const o = inBoard.handle.stage.getBoundingClientRect(), r = el.getBoundingClientRect();
        const landing = { x: (r.left - o.left + r.width / 2) / inBoard.scale, y: (r.top - o.top + r.height / 2) / inBoard.scale };
        // Spaced by the time the previous token needs to clear its own width
        // at this trace's length, time and curve, never less than RIDE_GAP_MS;
        // and it leaves from the part's edge, not centred on it.
        const width = r.width / inBoard.scale;
        const route = trimStart(trace, width / 2);
        const ms = effectiveMs(op.ms, TRAVEL_MS, false);
        const gap = rideClearMs(pathLength([...route, landing]), ms, op.easing, width + SLOT_GAP);
        const delay = motion.rideTurn(op.via!, now, gap);
        if (delay === null) motion.enter(el);
        else if (motion.travel(el, route, landing, op.ms, op.easing, delay)) motion.rideTaken(op.via!, now + delay);
        continue;
      }
      const route = byEdge.get(op.via!), box = after.get(id);
      if (route && box) motion.travel(el, route, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, op.ms, op.easing);
    }
    for (const id of added) { const el = els.get(id); if (el) motion.enter(el); }
    for (const op of p.ops) {
      if (op.op !== "animate") continue;
      const el = els.get(op.id);
      if (!el) continue;
      if (op.kind === "enter") motion.enter(el, op.ms);
      else if (op.kind === "exit") motion.fadeOut(el, op.ms);
      else motion.pulse(el, op.ms);
    }
  }, [scene]); // eslint-disable-line react-hooks/exhaustive-deps

  // A layout that changes on its own (the window resized, a font arrived)
  // moves the wires without moving the scene.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver !== "function") return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { relayout(measure()); });
    });
    ro.observe(stage);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, [measure, relayout]);

  // The marks riding each `flowing` wire that is allowed to loop, and the one
  // faster mark on a `busy` board trace (a busy wire in the flow pulses instead).
  useEffect(() => {
    const wanted = new Map<Element, { route: Point[]; delay: number; ms?: number }>();
    for (const e of scene) {
      if (e.type !== "edge" || !loops.has(e.id)) continue;
      const trace = traces.get(e.id);
      const busy = e.activity === "busy";
      if (busy && !trace) continue;
      const route = trace ?? routes.byEdge.get(e.id);
      if (!route) continue;
      const count = busy ? 1 : FLOW_MARKS;
      for (let i = 0; i < count; i++) {
        const el = marks.get(`${e.id}:${i}`);
        if (el) wanted.set(el, { route, delay: (i * 2400) / FLOW_MARKS, ms: busy ? FLOW_BUSY_MS : undefined });
      }
    }
    motion.syncFlows(wanted);
  }, [scene, loops, routes, traces, marks, motion, unseen]);

  // ------------------------------------------------------------ drawing

  const refFor = useCallback((id: string) => (el: HTMLElement | null) => { if (el) els.set(id, el); else els.delete(id); }, [els]);
  // The plugin's name on every question it asks: a dialog is the app's own
  // chrome, and a scene must not be able to borrow its voice anonymously.
  const askAs = useCallback((spec: ConfirmSpec) => ask({ ...spec, title: `${plugin}: ${spec.title}` }), [ask, plugin]);
  const view: CanvasView = { fit, reduced, now, at, folds, setFold, revealFold };
  const ctx: Ctx = { kids, loops, now, stopped, refFor, onAction, ask: askAs, scene, edges, routes: traces, marks, boards, draw: drawNode, view };

  const roots = kids.get(undefined) ?? [];
  const empty = !state.loaded || (roots.length === 0 && !scene.some((n) => n.type === "edge"));
  const inert = stopped ? ({ inert: "" } as object) : {};

  return (
    <div ref={wrapRef} className="agx-canvas flex-1 min-h-0 min-w-0 w-full flex flex-col gap-3 overflow-hidden" data-paused={unseen ? "true" : "false"} data-scheme={dark ? "dark" : "light"}>
      {stopped && !empty && <PluginNotRunning plugin={plugin} bar />}
      {stopped && empty ? (
        <PluginNotRunning plugin={plugin} />
      ) : empty ? (
        <div className="flex-1 min-h-[240px] flex items-center justify-center"><Spinner label={`Waiting for ${plugin} to draw…`} /></div>
      ) : null}
      <div ref={stageRef} className="relative min-w-0 w-full" aria-disabled={stopped || undefined}
        style={{ opacity: stopped ? 0.5 : 1, pointerEvents: stopped ? "none" : undefined, display: empty ? "none" : undefined }} {...inert}>
        <div className="flex flex-col min-w-0 w-full" style={{ gap: GAP.md }}>
          {roots.map((n) => <NodeView key={n.id} node={n} ctx={ctx} />)}
        </div>
        <Wires scene={scene} routes={routes} loops={loops} marks={marks} />
        <div ref={ghostRef} aria-hidden className="absolute inset-0 pointer-events-none" />
      </div>
      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------- wires

function Wires({ scene, routes, loops, marks }: { scene: CanvasScene; routes: Routes; loops: ReadonlySet<string>; marks: Map<string, SVGElement> }) {
  return (
    <svg aria-hidden className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: "visible" }}>
      {scene.map((e) => {
        if (e.type !== "edge") return null;
        const route = routes.byEdge.get(e.id);
        if (!route || route.length < 2) return null;
        const color = TONE_COLOR[toneOf(e.tone, "muted")];
        const flowing = e.activity === "flowing", busy = e.activity === "busy";
        const looping = loops.has(e.id);
        const end = route[route.length - 1]!;
        const i = Math.floor((route.length - 1) / 2);
        const label = str(e.label);
        return (
          <g key={e.id}>
            <g data-canvas-loop={busy && looping ? "pulse" : undefined}>
              <path d={pathData(route)} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
                strokeDasharray={flowing ? "4 4" : undefined} opacity={0.75} />
              <circle cx={end.x} cy={end.y} r={2.5} fill={color} />
            </g>
            {flowing && looping && Array.from({ length: FLOW_MARKS }, (_, k) => (
              <circle key={k} ref={(el) => { const key = `${e.id}:${k}`; if (el) marks.set(key, el); else marks.delete(key); }}
                cx={end.x} cy={end.y} r={3} fill={color} />
            ))}
            {label && (
              <text x={(route[i]!.x + route[i + 1]!.x) / 2} y={(route[i]!.y + route[i + 1]!.y) / 2 - 4} textAnchor="middle"
                fontSize={10} fill="var(--text3)">{label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- nodes

/** What the window knows about a sheet and a fold that the scene does not say. */
export interface CanvasView {
  fit: "wide" | "narrow";
  reduced: boolean;
  now: number;
  /** The angle each moon is drawn at while it travels. */
  at: ReadonlyMap<string, number>;
  /** Folds the person has opened or closed; absent = what the plugin added it as. */
  folds: ReadonlyMap<string, boolean>;
  setFold: (id: string, open: boolean) => void;
  /** A dock was pressed: open the first fold if it is shut. */
  revealFold: () => void;
}

export interface Ctx {
  kids: Map<string | undefined, CanvasNode[]>;
  loops: ReadonlySet<string>;
  now: number;
  stopped: boolean;
  refFor: (id: string) => (el: HTMLElement | null) => void;
  onAction: CanvasActionFn;
  ask: (spec: ConfirmSpec) => Promise<boolean>;
  scene: CanvasScene;
  /** The edges of the scene (`kids` leaves them out). */
  edges: readonly CanvasNode[];
  /** Every board trace, in board units (`boardRoutes`). */
  routes: ReadonlyMap<string, Point[]>;
  marks: Map<string, SVGElement>;
  boards: Map<string, BoardHandle>;
  /** Draw a child node: the board draws its parts' contents through this. */
  draw: (n: CanvasNode, ctx: Ctx) => ReactNode;
  /** Inside a board: leaves take the board's look. */
  inBoard?: boolean;
  view: CanvasView;
}

const grown = (n: CanvasNode): CSSProperties => {
  const g = clampGrow(n.grow);
  return g === undefined ? {} : { flex: `${g} 1 0px` };
};

const drawNode = (n: CanvasNode, ctx: Ctx): ReactNode => <NodeView key={n.id} node={n} ctx={ctx} />;

function Kids({ parent, ctx }: { parent: string; ctx: Ctx }) {
  return <>{(ctx.kids.get(parent) ?? []).map((k) => <NodeView key={k.id} node={k} ctx={ctx} />)}</>;
}

function NodeView({ node: n, ctx }: { node: CanvasNode; ctx: Ctx }): ReactNode {
  const ref = ctx.refFor(n.id);
  const loop = ctx.loops.has(n.id) ? "pulse" : undefined;
  const special = boardLeaf(n, ctx, ref);
  if (special !== undefined) return special;
  switch (n.type) {
    case "stack":
      return <div ref={ref} className="flex flex-col min-w-0" style={{ gap: gapOf(n.gap, "md"), ...grown(n) }}><Kids parent={n.id} ctx={ctx} /></div>;
    case "row":
      return (
        <div ref={ref} className="flex min-w-0" style={{
          gap: gapOf(n.gap, "sm"), alignItems: "stretch", flexWrap: n.wrap === true ? "wrap" : "nowrap",
          justifyContent: n.align === "between" ? "space-between" : n.align === "center" ? "center" : "flex-start",
          ...grown(n),
        }}><Kids parent={n.id} ctx={ctx} /></div>
      );
    case "lane":
      return <Lane node={n} ctx={ctx} refCb={ref} loop={loop} />;
    case "token": {
      const tone = toneOf(n.tone, "default");
      const icon = iconOf(n.icon), count = num(n.count);
      return (
        <span ref={ref} data-canvas-loop={loop} className={`inline-flex items-center gap-1.5 rounded-lg self-start max-w-full min-w-0 ${n.size === "sm" ? "text-[10.5px] px-2 py-0.5" : "text-[11px] px-2.5 py-1"}`}
          style={{ ...skin(tone), color: TONE_INK[tone] }}>
          {icon && <CanvasGlyph icon={icon} size={ICON.xs} />}
          <span className="truncate">{str(n.label)}</span>
          {count !== undefined && <span className="tabular-nums shrink-0 px-1 rounded" style={{ background: "color-mix(in srgb, var(--text) 10%, transparent)", color: "var(--text2)" }}>{fmt.format(count)}</span>}
        </span>
      );
    }
    case "label":
      return (
        <div ref={ref} className={`min-w-0 whitespace-pre-wrap break-words ${n.mono === true ? "t-mono" : ""}`}
          style={{ fontSize: n.size === "sm" ? 11 : 12.5, color: TONE_INK[toneOf(n.tone, "default")], lineHeight: 1.5 }}>{str(n.text)}</div>
      );
    case "counter": {
      const v = num(n.value);
      return (
        <div ref={ref} className="rounded-lg px-3 py-2 min-w-[96px]" style={{ background: "var(--surface-inset)", border: EDGE }}>
          <div className="text-[10px] uppercase tracking-wide truncate" style={{ color: "var(--text3)" }}>{str(n.label)}</div>
          <div className="text-[18px] font-semibold tabular-nums leading-tight" style={{ color: TONE_INK[toneOf(n.tone, "default")] }}>
            {v === undefined ? "" : `${str(n.prefix) ?? ""}${fixed(v, n.digits)}`}{str(n.unit) && <span className="text-[11px] font-normal ml-1" style={{ color: "var(--text3)" }}>{str(n.unit)}</span>}
          </div>
        </div>
      );
    }
    case "stat":
      return (
        <div ref={ref} className="rounded-lg px-3 py-2.5 min-w-[112px]" style={{ background: "var(--surface-inset)", border: EDGE }}>
          <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text3)" }}>{str(n.label)}</div>
          <div className="text-[20px] font-semibold tabular-nums leading-tight" style={{ color: TONE_INK[toneOf(n.tone, "default")] }}>{str(n.value)}</div>
          {str(n.hint) && <div className="text-[10.5px] mt-0.5" style={{ color: "var(--text3)" }}>{str(n.hint)}</div>}
        </div>
      );
    case "badge": {
      const tone = toneOf(n.tone, "muted");
      return (
        <span ref={ref} className="shrink-0 self-start text-[10px] px-1.5 py-px rounded-full uppercase tracking-wide whitespace-nowrap"
          style={{ color: TONE_INK[tone], background: `color-mix(in srgb, ${TONE_COLOR[tone]} 12%, transparent)` }}>{str(n.text)}</span>
      );
    }
    case "icon": {
      const icon = iconOf(n.icon);
      return (
        <span ref={ref} role="img" aria-label={str(n.label) ?? str(n.icon)} title={str(n.label)} className="inline-flex shrink-0 self-start"
          style={{ color: TONE_INK[toneOf(n.tone, "default")] }}>
          {icon && <CanvasGlyph icon={icon} size={ICON.md} />}
        </span>
      );
    }
    case "spark": {
      const values = Array.isArray(n.values) ? n.values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)) : [];
      return (
        <span ref={ref} className="block w-full min-w-[64px]">
          <svg role="img" aria-label="trend" viewBox="0 0 100 24" preserveAspectRatio="none" className="w-full block" style={{ height: 24 }}>
            <polyline points={sparkPoints(values, 100, 24)} fill="none" stroke={TONE_COLOR[toneOf(n.tone, "accent")]} strokeWidth={1.5}
              strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
        </span>
      );
    }
    case "gauge":
      return <Gauge node={n} refCb={ref} />;
    case "dock":
      return <Dock node={n} ctx={ctx} refCb={ref} />;
    case "fold":
      return <Fold node={n} ctx={ctx} refCb={ref} />;
    case "sheet":
      return <SheetHost node={n} ctx={ctx} />;
    case "countdown":
      return (
        <div ref={ref} className="min-w-0">
          {str(n.label) && <div className="text-[10px] uppercase tracking-wide truncate" style={{ color: "var(--text3)" }}>{str(n.label)}</div>}
          <div className="text-[18px] font-semibold tabular-nums leading-tight t-mono" style={{ color: TONE_INK[toneOf(n.tone, "default")] }}>
            {formatCountdown(num(n.until) ?? 0, ctx.now)}
          </div>
        </div>
      );
    case "button":
      return <CanvasButton node={n} ctx={ctx} refCb={ref} />;
    case "segmented":
      return <CanvasSegmented node={n} ctx={ctx} refCb={ref} />;
    case "disclosure":
      return (
        <details ref={ref} open={n.open === true} className="rounded-lg min-w-0" style={{ background: "var(--surface-inset)", border: EDGE }}>
          <summary className="text-[11.5px] px-3 py-2 cursor-pointer select-none" style={{ color: "var(--text2)" }}>{str(n.title)}</summary>
          <pre className="t-mono text-[11.5px] px-3 pb-3 m-0 overflow-auto whitespace-pre-wrap break-words" style={{ color: "var(--text2)", maxHeight: 420 }}>{str(n.text)}</pre>
        </details>
      );
    default:
      return null;
  }
}

function Lane({ node: n, ctx, refCb, loop }: { node: CanvasNode; ctx: Ctx; refCb: (el: HTMLElement | null) => void; loop: string | undefined }) {
  const tone = toneOf(n.tone, "default");
  const icon = iconOf(n.icon);
  const closed = n.state === "closed", sealed = n.state === "sealed";
  const kidsOf = ctx.kids.get(n.id) ?? [];
  const layout = n.layout === "grid" ? "grid" : n.layout === "pile" ? "pile" : "list";
  const { shown, hidden } = pileSplit(kidsOf, PILE_MAX);
  const body: CSSProperties = layout === "grid"
    ? { display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", alignItems: "start" }
    : { display: "flex", flexDirection: "column", gap: layout === "pile" ? 2 : 6 };
  return (
    <section ref={refCb} aria-label={str(n.title)} className="rounded-xl min-w-0 flex flex-col"
      style={{ background: "var(--surface-card)", border: EDGE, boxShadow: "var(--surface-lift)", opacity: sealed ? 0.6 : 1, ...grown(n) }}>
      <header data-canvas-loop={loop} className="flex items-center gap-2 px-3 pt-2.5 pb-2 min-w-0">
        {icon && <span className="shrink-0 inline-flex" style={{ color: TONE_INK[tone] }}><CanvasGlyph icon={icon} size={ICON.sm} /></span>}
        <span className="text-[12px] font-semibold truncate min-w-0 flex-1" style={{ color: "var(--text)" }}>{str(n.title)}</span>
        {sealed && <span className="shrink-0 inline-flex" style={{ color: "var(--text3)" }} title="sealed"><CanvasGlyph icon="lock" size={ICON.sm} /></span>}
        {closed && <span className="shrink-0 text-[10px] uppercase tracking-wide" style={{ color: "var(--warning-ink)" }}>closed</span>}
      </header>
      <div className="px-3 pb-3 min-w-0 flex flex-col gap-1.5">
        {closed && <div role="separator" aria-label="closed" className="rounded-full w-full" style={{ height: 6, background: "color-mix(in srgb, var(--warning) 70%, transparent)" }} />}
        <div className="min-w-0" style={body}>
          {layout === "pile"
            ? <>{shown.map((k) => <NodeView key={k.id} node={k} ctx={ctx} />)}{hidden > 0 && <span className="text-[10.5px] tabular-nums self-start px-1" style={{ color: "var(--text3)" }}>+{hidden}</span>}</>
            : <Kids parent={n.id} ctx={ctx} />}
        </div>
      </div>
    </section>
  );
}

/** A sheet is drawn only when its `fit` is the panel's; the other stays in the scene and costs nothing. */
function SheetHost({ node: n, ctx }: { node: CanvasNode; ctx: Ctx }) {
  const phase = useFoldPhaseOf();
  if (n.fit !== ctx.view.fit) return null;
  return (
    <div ref={ctx.refFor(n.id)} className="min-w-0 cv-sheet-host" style={{ flex: `0 1 ${int(n.w, 320, 1200, 776)}px`, maxWidth: "100%" }}>
      <CanvasSheet sheet={n} kids={ctx.kids} edges={ctx.edges} view={{ now: ctx.view.now, phase, at: ctx.view.at }} />
    </div>
  );
}

function Gauge({ node: n, refCb }: { node: CanvasNode; refCb: (el: HTMLElement | null) => void }) {
  const value = num(n.value) ?? 0, max = num(n.max) ?? 1;
  const f = fraction(value, max);
  const color = TONE_COLOR[toneOf(n.tone, "accent")];
  const label = str(n.label);
  const c = DIAL / 2, r = c - 6;
  let shape: ReactNode;
  if (isGlyphShape(n)) {
    shape = <GaugeGlyph node={n} />;
  } else if (n.shape === "arc") {
    shape = (
      <svg width={DIAL} height={DIAL} viewBox={`0 0 ${DIAL} ${DIAL}`} aria-hidden>
        <path d={arcPath(c, c, r, -135, 135)} fill="none" stroke="var(--surface-line)" strokeWidth={5} strokeLinecap="round" />
        {f > 0 && <path d={arcPath(c, c, r, -135, -135 + 270 * f)} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" />}
      </svg>
    );
  } else if (n.shape === "ring") {
    const circ = 2 * Math.PI * r;
    shape = (
      <svg width={DIAL} height={DIAL} viewBox={`0 0 ${DIAL} ${DIAL}`} aria-hidden>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--surface-line)" strokeWidth={5} />
        <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" strokeDasharray={`${circ * f} ${circ}`} transform={`rotate(-90 ${c} ${c})`} />
      </svg>
    );
  } else if (n.shape === "pips") {
    const total = Number.isInteger(max) && max <= PIP_MAX ? max : 20;
    const on = Math.round(f * total);
    shape = (
      <div className="flex flex-wrap gap-0.5" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className="rounded-sm" style={{ width: 6, height: 12, background: i < on ? color : "var(--surface-line)" }} />
        ))}
      </div>
    );
  } else {
    shape = (
      <div className="relative h-[6px] rounded-full overflow-hidden w-full min-w-[96px]" style={{ background: "var(--surface-inset)" }} aria-hidden>
        <div className="absolute left-0 top-0 bottom-0 rounded-full" style={{ width: `${Math.round(f * 100)}%`, background: color }} />
      </div>
    );
  }
  const dial = isGlyphShape(n) || n.shape === "arc" || n.shape === "ring";
  return (
    <div ref={refCb} role="meter" aria-label={label ?? "gauge"} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}
      className={`min-w-0 flex gap-2 ${dial ? "items-center" : "flex-col"}`}>
      {shape}
      <div className="min-w-0">
        {label && <div className="text-[10px] uppercase tracking-wide truncate" style={{ color: "var(--text3)" }}>{label}</div>}
        <div className="text-[12px] tabular-nums" style={{ color: "var(--text2)" }}>{fmt.format(value)} / {fmt.format(max)}</div>
      </div>
    </div>
  );
}

function CanvasButton({ node: n, ctx, refCb }: { node: CanvasNode; ctx: Ctx; refCb: (el: HTMLElement | null) => void }) {
  const [busy, setBusy] = useState(false);
  const label = str(n.label) ?? "";
  const action = n.action as CanvasAction | undefined;
  const tone = n.tone === "primary" ? "primary" : n.tone === "danger" ? "danger" : "plain";
  const press = async () => {
    if (!action) return;
    const sure = str(n.confirm);
    if (sure && !(await ctx.ask({ title: label, body: sure, confirmLabel: label, danger: n.tone === "danger" }))) return;
    setBusy(true);
    try { await ctx.onAction(action); } finally { setBusy(false); }
  };
  return (
    <span ref={refCb} className="inline-flex self-start" onClick={(e) => e.stopPropagation()}>
      <HouseButton tone={tone} pending={busy} disabled={n.disabled === true || ctx.stopped || !action} onClick={() => { void press(); }}>{label}</HouseButton>
    </span>
  );
}

function CanvasSegmented({ node: n, ctx, refCb }: { node: CanvasNode; ctx: Ctx; refCb: (el: HTMLElement | null) => void }) {
  const options = (Array.isArray(n.options) ? n.options : []) as { value: string; label: string }[];
  const action = n.action as CanvasAction | undefined;
  const value = str(n.value);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const choose = (v: string) => { if (action && v !== value) void ctx.onAction(actionWithValue(action, v)); };
  const at = options.findIndex((o) => o.value === value);
  const [snap, setSnap] = useState(false);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0 || options.length === 0) return;
    e.preventDefault();
    setSnap(true);
    const next = (i + step + options.length) % options.length;
    buttons.current[next]?.focus();
    choose(options[next]!.value);
  };
  if (n.style === "lever") {
    // A change from the arrow keys puts the knob there at once: the person is
    // stepping, and a 320 ms slide per step would lag behind the keys. A
    // pointer press keeps the slide.
    // The board's lever: one knob that slides to the chosen option. The knob
    // is a transform with a CSS transition, so a new value mid-slide goes on
    // from where the knob is; its width is one option less the track's inset.
    const count = Math.max(1, options.length);
    return (
      <div ref={refCb} className="bd-lever" role="radiogroup" aria-label={str(n.label) ?? "options"}>
        {at >= 0 && <span className="bd-knob" aria-hidden data-snap={snap ? "true" : "false"} style={{ width: `calc(${(100 / count).toFixed(4)}% - 6px)`, transform: `translateX(calc(${at} * (100% + 6px)))` }} />}
        {options.map((o, i) => {
          const on = o.value === value;
          return (
            <button key={o.value} ref={(el) => { buttons.current[i] = el; }} type="button" role="radio" aria-checked={on}
              tabIndex={on || (at < 0 && i === 0) ? 0 : -1} disabled={ctx.stopped} className="bd-lever-opt"
              onClick={(e) => { e.stopPropagation(); setSnap(false); choose(o.value); }} onKeyDown={(e) => onKey(e, i)}>{o.label}</button>
          );
        })}
      </div>
    );
  }
  return (
    <div ref={refCb} className="flex items-center gap-2 min-w-0 flex-wrap">
      {str(n.label) && <span className="text-[11px]" style={{ color: "var(--text3)" }}>{str(n.label)}</span>}
      <div role="radiogroup" aria-label={str(n.label) ?? "options"} className="flex items-center gap-1.5 flex-wrap">
        {options.map((o, i) => {
          const on = o.value === value;
          return (
            <button key={o.value} ref={(el) => { buttons.current[i] = el; }} type="button" role="radio" aria-checked={on}
              tabIndex={on || (at < 0 && i === 0) ? 0 : -1} disabled={ctx.stopped}
              className={`${CHIP} ${CHIP_SURFACE_CLS}`} style={{ ...CHIP_SURFACE, ...chipTone(on) }}
              onClick={(e) => { e.stopPropagation(); choose(o.value); }} onKeyDown={(e) => onKey(e, i)}>{o.label}</button>
          );
        })}
      </div>
    </div>
  );
}
