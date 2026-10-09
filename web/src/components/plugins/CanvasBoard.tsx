import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { CanvasAction, CanvasNode } from "../../../../shared/pluginCanvas.ts";
import type { Tone } from "../../../../shared/pluginUi.ts";
import {
  SEALED_SLOT_H, SLOT_GAP, SLOT_H, baySplit, boardScale, etching, fraction, needleAngle, odometerCells, partRect,
  roundedPath, slotCell, type Rect,
} from "../../lib/canvasGeometry.ts";
import { FLOW_MARKS } from "../../lib/canvasMotion.ts";
import { TONE_COLOR, TONE_INK } from "../../lib/pluginTones.ts";
import { ICON } from "../../lib/iconSize.ts";
import { fixed, int, num, str, toneOf } from "./canvasRead.ts";
import { CanvasGlyph } from "./panelGlyph.tsx";
import type { Ctx } from "./PluginCanvas.tsx";
import "./canvasBoard.css";

/**
 * A board: one machine behind glass. The plugin places parts at fixed board
 * units; this file draws them, and the app scales the whole stage uniformly
 * to the width it has (`boardScale`), so what is next to what never changes
 * with the window.
 *
 * Layers, bottom to top: the ground (grid, etched lines), the traces (UNDER
 * the parts: a trace is wiring on the board, a part stands on it), the parts,
 * the tokens riding a trace (lifted by z-index, never a new layer that would
 * cover the parts' controls), and the glass, which takes no pointer.
 *
 * Nothing here takes a string from the scene into a style: positions and
 * sizes are clamped numbers, colours are a tone looked up in TONE_COLOR, and
 * the look is canvasBoard.css. A part's box is not checked against the board
 * when it is written (a later `set` on the board could make it wrong): the
 * slab clips.
 *
 * Chosen limits: a board draws `part`s and its own `edge`s and nothing else
 * directly inside it; a token directly in a part (not in a bay) is shown in
 * one centred strip of three and a "+N"; a core's disc is sized from its
 * part's box, so a core outside a part is a fixed 168.
 */

export interface BoardHandle { stage: HTMLElement; ghost: HTMLElement; w: number }

/** The lip under a glass slab, in board units: the glass's thickness seen from the front. */
const LIP = 10;
/** Tokens a part shows in its strip before "+N". */
const STRIP_MAX = 3;
/** The needle dial's width in board units: three fit, with gaps, in a 236-unit part. */
const DIAL_W = 66;
/** An odometer cell's strip: the ten digits, one per 32px line. */
const ODO_STRIP = "0\n1\n2\n3\n4\n5\n6\n7\n8\n9";
/** A core with no part around it. */
const CORE_D = 168;
/** A gate's blades: length, and how far each pulls back when open. */
const BLADE = 22;
const BLADE_OPEN = 14;
/** The smallest a mechanism is drawn, as a share of its size, when its part is crowded. */
const MECH_MIN = 0.4;
const SCREW = 12;

/** A part's box, for the leaves inside it that size themselves to it. */
const PartBox = createContext<Rect | null>(null);

/** A tone as the board paints it: `accent` is the machine's light (--bd-lit), the rest the house colours. */
const toneVar = (tone: Tone): CSSProperties => ({ "--bd-tone": tone === "accent" ? "var(--bd-lit)" : TONE_COLOR[tone] } as CSSProperties);

/**
 * A part or a row the plugin made pressable. A control inside one (a lever, a
 * button, a row) stops its own click, and a key only counts when this element
 * has the focus itself, so pressing the control never also presses the part.
 * A part with no action is a labelled group.
 */
const pressProps = (action: CanvasAction | undefined, ctx: Ctx, label: string | undefined) => {
  if (!action || ctx.stopped) return { role: "group" as const, "aria-label": label };
  const go = () => { void ctx.onAction(action); };
  return {
    role: "button" as const, tabIndex: 0, "aria-label": label, "data-press": "true",
    onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); go(); },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault(); e.stopPropagation(); go();
    },
  };
};

// ---------------------------------------------------------------- the board

export function BoardView({ node: n, ctx, refCb }: { node: CanvasNode; ctx: Ctx; refCb: (el: HTMLElement | null) => void }) {
  const w = int(n.w, 320, 2400, 1180), h = int(n.h, 200, 1600, 560);
  const glass = n.material !== "plain";
  const lip = glass ? LIP : 0;
  const [width, setWidth] = useState(0);
  const wrap = useRef<HTMLDivElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const ghost = useRef<HTMLDivElement | null>(null);

  const setWrap = useCallback((el: HTMLDivElement | null) => { wrap.current = el; refCb(el); }, [refCb]);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver((entries) => { for (const e of entries) setWidth(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (stage.current && ghost.current) ctx.boards.set(n.id, { stage: stage.current, ghost: ghost.current, w });
    return () => { ctx.boards.delete(n.id); };
  }, [ctx.boards, n.id, w]);

  const { scale, scrolls } = boardScale(width || w, w);
  const inner: Ctx = { ...ctx, inBoard: true };
  const parts = (ctx.kids.get(n.id) ?? []).filter((k) => k.type === "part");
  const edges = ctx.scene.filter((e) => e.type === "edge" && e.parent === n.id);
  const etch = useMemo(() => (glass ? etching(n.id, w, h) : []), [glass, n.id, w, h]);
  const label = str(n.label);

  return (
    <div ref={setWrap} className="agx-board-wrap" data-scrolls={scrolls ? "true" : "false"} role="group" aria-label={label ?? "board"}>
      <div className="agx-board-size" style={{ width: w * scale, height: (h + lip) * scale }}>
        <div className="agx-board" data-material={glass ? "glass" : "plain"} style={{ width: w, height: h + lip, transform: `scale(${scale})` }}>
          <div ref={stage} className="bd-slab" style={{ width: w, height: h }}>
            <div className="bd-layer bd-ground" />
            {glass && <div className="bd-layer bd-grid" />}
            {glass && (
              <svg className="bd-svg bd-etch" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
                {etch.map((e, i) => <path key={i} d={e.d} />)}
                {etch.map((e, i) => <circle key={`v${i}`} cx={e.via.x} cy={e.via.y} r={3} />)}
              </svg>
            )}
            <Traces edges={edges} ctx={ctx} w={w} h={h} />
            {parts.map((p) => <PartView key={p.id} node={p} ctx={inner} />)}
            <div ref={ghost} aria-hidden className="bd-layer bd-ghost" />
            {glass && <>
              <div className="bd-sheen" aria-hidden />
              <div className="bd-glint" aria-hidden />
              <div className="bd-layer bd-glass" aria-hidden />
              {[[16, 16], [w - 16 - SCREW, 16], [16, h - 16 - SCREW], [w - 16 - SCREW, h - 16 - SCREW]].map(([x, y], i) => (
                <span key={i} className="bd-screw" aria-hidden style={{ left: x, top: y }} />
              ))}
            </>}
          </div>
          {glass && <div className="bd-lip" aria-hidden />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- traces

function Traces({ edges, ctx, w, h }: { edges: CanvasNode[]; ctx: Ctx; w: number; h: number }) {
  return (
    <svg className="bd-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      {edges.map((e) => {
        const route = ctx.routes.get(e.id);
        if (!route || route.length < 2) return null;
        const d = roundedPath(route, e.kind === "trace" || e.kind === undefined ? 14 : 8);
        const looping = ctx.loops.has(e.id);
        const busy = e.activity === "busy", flowing = e.activity === "flowing";
        const marks = !looping ? 0 : flowing ? FLOW_MARKS : busy ? 1 : 0;
        const tone = toneOf(e.tone, "accent");
        const end = route[route.length - 1]!, start = route[0]!;
        const mid = Math.floor((route.length - 1) / 2);
        const label = str(e.label);
        const kind = e.kind === "control" ? "control" : e.kind === "seal" ? "seal" : "trace";
        return (
          <g key={e.id} className="bd-tr" data-hot={busy && looping ? "true" : "false"} data-active={busy || flowing ? "true" : undefined} style={toneVar(tone)}>
            {kind === "trace" && <>
              <path className="bd-tr-groove" d={d} />
              <path className="bd-tr-inner" d={d} />
              <path className="bd-tr-glow" d={d} />
              <circle className="bd-tr-node" cx={start.x} cy={start.y} r={4} />
              <circle className="bd-tr-node" cx={end.x} cy={end.y} r={4} />
            </>}
            {kind === "control" && <path className="bd-tr-ctl" d={d} />}
            {kind === "seal" && <path className="bd-tr-seal" d={d} />}
            {Array.from({ length: marks }, (_, k) => (
              <g key={k} ref={(el) => { const key = `${e.id}:${k}`; if (el) ctx.marks.set(key, el); else ctx.marks.delete(key); }}>
                <circle className="bd-mark-halo" cx={end.x} cy={end.y} r={busy ? 7 : 6} />
                <circle className="bd-mark-dot" cx={end.x} cy={end.y} r={busy ? 3.5 : 2.6} />
              </g>
            ))}
            {label && (
              <text className="bd-tr-label" x={(route[mid]!.x + route[mid + 1]!.x) / 2} y={(route[mid]!.y + route[mid + 1]!.y) / 2 - 10} textAnchor="middle">{label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- parts

function PartView({ node: n, ctx }: { node: CanvasNode; ctx: Ctx }) {
  const box = partRect(n) ?? { x: 0, y: 0, w: 120, h: 80 };
  const kidsOf = ctx.kids.get(n.id) ?? [];
  const loose = kidsOf.filter((k) => k.type === "token");
  const rest = kidsOf.filter((k) => k.type !== "token");
  const hasBay = kidsOf.some((k) => k.type === "bay");
  const mech = kidsOf.some((k) => k.type === "gate" || k.type === "press" || k.type === "core");
  const onMech = mech ? rest.filter((k) => k.type === "bay") : [];
  const column = mech ? rest.filter((k) => k.type !== "bay") : rest;
  const step = num(n.step), title = str(n.title), hint = str(n.hint);
  const tone = toneOf(n.tone, "default");
  const depth = int(n.depth, 0, 4, 1);
  const style = {
    left: box.x, top: box.y, width: box.w, height: box.h,
    "--d": depth * 0.85,
    ...(tone === "default" ? {} : { "--bd-step": tone === "accent" ? "var(--bd-lit)" : TONE_COLOR[tone] }),
  } as CSSProperties;
  const shownLoose = loose.slice(0, loose.length > STRIP_MAX ? STRIP_MAX - 1 : STRIP_MAX);
  const moreLoose = loose.length - shownLoose.length;
  return (
    <div ref={ctx.refFor(n.id)} className="bd-part" style={style}
      {...pressProps(n.action as CanvasAction | undefined, ctx, title ?? (step !== undefined ? `Step ${int(step, 1, 99, 1)}` : "part"))}>
      {(step !== undefined || title || hint) && (
        <div className="bd-hd">
          {step !== undefined && <span className="bd-step">{int(step, 1, 99, 1)}</span>}
          {title && <span className="bd-hd-title" title={title}>{title}</span>}
          {hint && <span className="bd-hint" title={hint}>{hint}</span>}
        </div>
      )}
      <PartBox.Provider value={box}>
        <MechBays.Provider value={onMech}>
          <div className="bd-body" data-clip={hasBay || loose.length > 0 ? "false" : "true"}>
            {column.map((k) => ctx.draw(k, ctx))}
          </div>
        </MechBays.Provider>
      </PartBox.Provider>
      {loose.length > 0 && (
        <div className="bd-strip">
          {shownLoose.map((k) => <TokenChip key={k.id} node={k} ctx={ctx} />)}
          {moreLoose > 0 && <span className="bd-more">+{moreLoose}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- tokens and bays

function TokenChip({ node: n, ctx, cell, sealed }: { node: CanvasNode; ctx: Ctx; cell?: { col: number; row: number }; sealed?: boolean }) {
  const label = str(n.label) ?? "";
  const at: CSSProperties = cell ? { gridColumn: cell.col + 1, gridRow: cell.row + 1 } : {};
  if (sealed) return <span ref={ctx.refFor(n.id)} className="bd-frozen" role="img" aria-label={label} title={label} style={at} />;
  return (
    <span ref={ctx.refFor(n.id)} className="bd-tok" role="img" aria-label={label} title={label} data-canvas-loop={ctx.loops.has(n.id) ? "pulse" : undefined}
      style={{ ...toneVar(toneOf(n.tone, "accent")), ...at }}>
      <span className="bd-tok-t">{label}</span>
      <span className="bd-tok-b" aria-hidden><b /><b /><b /></span>
    </span>
  );
}

export function BayView({ node: n, ctx, refCb }: { node: CanvasNode; ctx: Ctx; refCb: (el: HTMLElement | null) => void }) {
  const cols = int(n.cols, 1, 12, 1), rows = int(n.rows, 1, 8, 1);
  const slots = Math.min(64, cols * rows);
  const sealed = n.sealed === true;
  const toks = (ctx.kids.get(n.id) ?? []).filter((k) => k.type === "token");
  const { shown, more } = baySplit(toks.length, slots);
  const grid: CSSProperties = {
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridAutoRows: sealed ? SEALED_SLOT_H : SLOT_H,
    gap: sealed ? `${SLOT_GAP * 2}px ${SLOT_GAP}px` : SLOT_GAP,
  };
  const filled = shown + (more > 0 ? 1 : 0);
  const caption = str(n.caption);
  const moreAt = slotCell(shown, cols);
  return (
    <div ref={refCb} className="bd-bay-wrap">
      <div className="bd-bay" data-sealed={sealed ? "true" : "false"} role="group"
        aria-label={`${caption ?? (sealed ? "sealed" : "slots")}: ${toks.length}`}>
        <div className="bd-grid-slots" style={grid} aria-hidden>
          {Array.from({ length: slots }, (_, i) => <span key={i} className="bd-slot" data-full={!sealed && i < filled ? "true" : "false"} />)}
        </div>
        <div className="bd-grid-slots" data-over="true" style={grid}>
          {toks.slice(0, shown).map((k, i) => <TokenChip key={k.id} node={k} ctx={ctx} cell={slotCell(i, cols)} sealed={sealed} />)}
          {more > 0 && <span className="bd-more" style={{ gridColumn: moreAt.col + 1, gridRow: moreAt.row + 1 }}>+{more}</span>}
        </div>
        {sealed && <span className="bd-lock" aria-hidden><CanvasGlyph icon="lock" size={ICON.xs} /></span>}
      </div>
      {caption && <div className="bd-bay-caption">{caption}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- instruments

/**
 * Where a mechanism sits. In a part it gets the band its part leaves free
 * (between what the plugin put above it and below it in the part's column),
 * and within that band it is centred on the PART's centre, where a trace
 * between part centres runs, as far as the band allows. A band shorter than
 * the mechanism shrinks it (not below MECH_MIN of its size) rather than let
 * it slide under the text around it. Outside a part it is a box of its own size.
 */
function useBand(natural: number): { band: (el: HTMLDivElement | null) => void; k: number; top: number; inPart: boolean } {
  const box = useContext(PartBox);
  const el = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<{ k: number; top: number }>({ k: 1, top: 0 });
  const measure = useCallback(() => {
    const b = el.current;
    if (!b || !box) return;
    const h = b.clientHeight;
    const k = Math.max(MECH_MIN, Math.min(1, h / natural));
    const size = natural * k;
    // offsetTop is from the part (the nearest positioned box), in board units.
    const top = Math.max(0, Math.min(Math.max(0, h - size), box.h / 2 - b.offsetTop - size / 2));
    setFit((f) => (Math.abs(f.k - k) < 0.005 && Math.abs(f.top - top) < 0.5 ? f : { k, top }));
  }, [box, natural]);
  useLayoutEffect(() => {
    measure();
    const b = el.current;
    if (!b || !box || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    return () => ro.disconnect();
  }, [measure, box]);
  const band = useCallback((b: HTMLDivElement | null) => { el.current = b; }, []);
  return box ? { band, k: fit.k, top: fit.top, inPart: true } : { band, k: 1, top: 0, inPart: false };
}

/** The bays of a part that holds a mechanism: drawn ON the mechanism (the
 *  token is in the gate, between the jaws, on the core's rim), not in the column. */
const MechBays = createContext<CanvasNode[]>([]);

function OnMech({ ctx, at }: { ctx: Ctx; at: "mid" | "rim" }) {
  const bays = useContext(MechBays);
  if (bays.length === 0) return null;
  return <div className="bd-mech-bay" data-at={at}>{bays.map((b) => ctx.draw(b, ctx))}</div>;
}

export function GateView({ node: n, ctx, refCb }: { node: CanvasNode; ctx: Ctx; refCb: (el: HTMLElement | null) => void }) {
  const closed = n.state === "closed";
  const max = num(n.max) === undefined ? 0 : int(n.max, 1, 60, 30);
  const value = num(n.value) ?? 0;
  const on = Math.min(max, Math.max(0, Math.round(value)));
  const given = str(n.label);
  // Closed is said in words as well as by the beam's colour, whatever the plugin's label says.
  const label = given ?? (max > 0 ? `${closed ? "closed" : "open"} · ${on}/${max}` : closed ? "closed" : "open");
  const said = closed && !/closed/i.test(label) ? `closed · ${label}` : label;
  const tone = toneOf(n.tone, "default");
  const natural = BLADE * 2 + 24;
  const { band, k, top, inPart } = useBand(natural);
  const blade = BLADE * k;
  return (
    <div ref={refCb} className="bd-gate" data-state={closed ? "closed" : "open"} role="status" aria-label={said} style={tone === "default" ? undefined : toneVar(tone)}>
      <div ref={band} className="bd-band" style={inPart ? undefined : { height: natural }}>
        <div className="bd-mech" style={{ width: 60 * k, height: natural * k, top }}>
          <span className="bd-post" style={{ left: 0, width: 9 * k }} aria-hidden />
          <span className="bd-post" style={{ right: 0, width: 9 * k }} aria-hidden />
          <span className="bd-blade" data-end="top" aria-hidden style={{ top: 8 * k, height: blade, "--gap": BLADE_OPEN * k } as CSSProperties} />
          <span className="bd-blade" data-end="bot" aria-hidden style={{ top: (16 + BLADE) * k, height: blade, "--gap": BLADE_OPEN * k } as CSSProperties} />
          <span className="bd-beam" aria-hidden />
          <OnMech ctx={ctx} at="mid" />
        </div>
      </div>
      <div className="bd-gate-ft">
        {max > 0 && (
          <span className="bd-pips" role="meter" aria-label="used" aria-valuemin={0} aria-valuemax={max} aria-valuenow={on}
            style={{ gridTemplateColumns: `repeat(${Math.min(15, max)}, 5px)` }}>
            {Array.from({ length: max }, (_, i) => <i key={i} data-on={i < on ? "true" : "false"} />)}
          </span>
        )}
        <span className="bd-gate-label">{said}</span>
      </div>
    </div>
  );
}

export function PressView({ node: n, ctx, refCb }: { node: CanvasNode; ctx: Ctx; refCb: (el: HTMLElement | null) => void }) {
  const label = str(n.label);
  const { band, k, top, inPart } = useBand(60);
  return (
    <div ref={refCb} className="bd-press" data-busy={n.activity === "busy" ? "true" : undefined} data-canvas-loop={ctx.loops.has(n.id) ? "press" : undefined} role="img" aria-label={label ?? "press"}>
      <div ref={band} className="bd-band" style={inPart ? undefined : { height: 60 }}>
        <div className="bd-mech" style={{ width: 88 * k, height: 60 * k, top }}>
          <span className="bd-jaw" data-end="top" aria-hidden />
          <span className="bd-scanner" aria-hidden />
          <span className="bd-jaw" data-end="bot" aria-hidden />
          <OnMech ctx={ctx} at="mid" />
        </div>
      </div>
      {label && <div className="bd-press-label">{label}</div>}
    </div>
  );
}

export function CoreView({ node: n, ctx, refCb }: { node: CanvasNode; ctx: Ctx; refCb: (el: HTMLElement | null) => void }) {
  const box = useContext(PartBox);
  // The bezel fills its part, less the header above and a margin all round
  // (a 240 x 270 part gives a 184 bezel); the band shrinks it further when
  // the plugin put more in the part.
  const most = box ? Math.max(80, Math.min(box.w - 48, box.h - 86)) : CORE_D;
  const { band, k, top, inPart } = useBand(most);
  const d = Math.round(most * k);
  const title = str(n.title), value = str(n.value), unit = str(n.unit), hint = str(n.hint), hint2 = str(n.hint2);
  const tone = toneOf(n.tone, "default");
  return (
    <div ref={refCb} className="bd-core" data-busy={n.activity === "busy" ? "true" : undefined} data-canvas-loop={ctx.loops.has(n.id) ? "core" : undefined} role="status"
      aria-label={[title, value, unit, hint, hint2].filter(Boolean).join(" ")} style={tone === "default" ? undefined : toneVar(tone)}>
      <div ref={band} className="bd-band" style={inPart ? undefined : { height: most }}>
        <div className="bd-mech" style={{ width: d, height: d, top, "--disc": `${d}px` } as CSSProperties} data-small={d < 120 ? "true" : undefined}>
          <span className="bd-disc bd-pulse" />
          <span className="bd-disc bd-bezel" />
          <span className="bd-disc bd-ring-b" />
          <span className="bd-disc bd-ring-a" />
          <div className="bd-disc bd-face" aria-hidden>
            {title && <span className="bd-face-nm">{title}</span>}
            <span className="bd-face-v">{value ?? "–"}{unit && <small>{unit}</small>}</span>
            {(hint || hint2) && <span className="bd-face-st">{hint && <span>{hint}</span>}{hint2 && <span>{hint2}</span>}</span>}
          </div>
          <OnMech ctx={ctx} at="rim" />
        </div>
      </div>
    </div>
  );
}

export function ItemView({ node: n, ctx, refCb }: { node: CanvasNode; ctx: Ctx; refCb: (el: HTMLElement | null) => void }) {
  const title = str(n.title) ?? "", meta = str(n.meta), badge = str(n.badge);
  const rank = num(n.rank);
  return (
    <div ref={refCb} className="bd-row" data-dim={n.dim === true ? "true" : "false"} data-selected={n.selected === true ? "true" : "false"}
      data-rank={rank === undefined ? "false" : "true"} aria-current={n.selected === true ? "true" : undefined}
      {...pressProps(n.action as CanvasAction | undefined, ctx, [title, meta, badge].filter(Boolean).join(", "))}>
      {rank !== undefined && <span className="bd-row-rank">{int(rank, 1, 999, 1)}</span>}
      <div className="bd-row-t" title={title}>{title}</div>
      <div className="bd-row-m">
        <span>{meta}</span>
        {badge && <span className="bd-pill" data-tone={toneOf(n.badgeTone, "default")}>{badge}</span>}
      </div>
    </div>
  );
}

export function LampView({ node: n, refCb }: { node: CanvasNode; refCb: (el: HTMLElement | null) => void }) {
  const label = str(n.label), on = n.on !== false;
  return (
    <span ref={refCb} className="bd-lamp" data-on={on ? "true" : "false"} style={toneVar(toneOf(n.tone, "success"))} role="img"
      aria-label={label ? `${label}: ${on ? "on" : "off"}` : on ? "on" : "off"} title={label ? `${label}: ${on ? "on" : "off"}` : on ? "on" : "off"}>
      <i aria-hidden />{label && <span>{label}</span>}
    </span>
  );
}

export function NeedleView({ node: n, refCb }: { node: CanvasNode; refCb: (el: HTMLElement | null) => void }) {
  const value = num(n.value) ?? 0, max = num(n.max) ?? 1;
  const label = str(n.label);
  const angle = needleAngle(value, max);
  const text = `${fixed(value, n.digits)}${n.hideMax === true ? "" : ` / ${fixed(max, n.digits)}`}`;
  return (
    <div ref={refCb} className="bd-dial" role="meter" aria-label={label ?? "gauge"} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}
      style={{ width: DIAL_W, ...toneVar(toneOf(n.tone, "accent")) }}>
      <svg viewBox="-9 -3 118 66" width={DIAL_W} height={Math.round((DIAL_W * 66) / 118)} aria-hidden>
        <path className="bd-dial-rim" d="M10 55 A40 40 0 0 1 90 55" />
        <path className="bd-dial-band" d="M10 55 A40 40 0 0 1 90 55" />
        <line className="bd-dial-tick" x1={50} y1={8} x2={50} y2={13} />
        <g className="bd-needle" style={{ transform: `rotate(${angle.toFixed(2)}deg)` }}>
          <line x1={50} y1={55} x2={50} y2={17} />
          <circle cx={50} cy={55} r={5} />
        </g>
      </svg>
      <div className="bd-dial-num">{text}</div>
      {label && <div className="bd-dial-lbl">{label}</div>}
    </div>
  );
}

export function OdometerView({ node: n, refCb }: { node: CanvasNode; refCb: (el: HTMLElement | null) => void }) {
  const value = num(n.value) ?? 0, prefix = str(n.prefix), unit = str(n.unit), label = str(n.label);
  const cells = odometerCells(value, n.digits);
  return (
    <div ref={refCb} className="min-w-0" role="img" aria-label={`${label ? `${label} ` : ""}${prefix ?? ""}${fixed(value, n.digits)}${unit ? ` ${unit}` : ""}`}>
      <div className="bd-odo" aria-hidden style={{ color: TONE_INK[toneOf(n.tone, "default")] }}>
        {prefix && <span className="bd-odo-pre">{prefix}</span>}
        {cells === null ? <span>{fixed(value, n.digits)}</span> : cells.map((c, i) =>
          "digit" in c ? (
            // Keyed from the right, so a new leading digit does not reset the
            // others. One strip of ten digits as one text node, not ten elements.
            <span key={cells.length - i} className="bd-odo-cell">
              <span className="bd-odo-col" style={{ transform: `translateY(${-32 * c.digit}px)` }}>{ODO_STRIP}</span>
            </span>
          ) : <span key={`g${cells.length - i}`} className="bd-odo-glyph">{c.glyph}</span>,
        )}
        {unit && <span className="bd-odo-pre" style={{ marginLeft: 4 }}>{unit}</span>}
      </div>
      {label && <div className="bd-small">{label}</div>}
    </div>
  );
}

export function RingCountdown({ node: n, ctx, refCb }: { node: CanvasNode; ctx: Ctx; refCb: (el: HTMLElement | null) => void }) {
  const period = int(n.period, 1, 86_400, 60);
  const left = Math.max(0, Math.ceil(((num(n.until) ?? 0) - ctx.now) / 1000));
  const f = fraction(left, period);
  const label = str(n.label);
  const text = left < 100 ? String(left) : `${Math.floor(left / 60)}m`;
  return (
    <div ref={refCb} className="bd-ring" role="timer" aria-label={`${label ? `${label}: ` : ""}${left} s`} style={toneVar(toneOf(n.tone, "accent"))}>
      <svg width={46} height={46} viewBox="0 0 54 54" aria-hidden>
        <circle className="bd-ring-trk" cx={27} cy={27} r={22} />
        <circle className="bd-ring-val" cx={27} cy={27} r={22} pathLength={100} strokeDasharray={`${(f * 100).toFixed(1)} 100`} transform="rotate(-90 27 27)" />
        <text x={27} y={31} textAnchor="middle">{text}</text>
      </svg>
      {label && <span className="bd-small">{label}</span>}
    </div>
  );
}

/**
 * How a leaf draws when it has a board's look: the instrument types always,
 * and a label, counter, stat, badge or token when it is inside a board, so a
 * machine never shows the flat house card in the middle of it. `undefined`
 * means "not mine": the flow view draws it.
 */
export function boardLeaf(n: CanvasNode, ctx: Ctx, refCb: (el: HTMLElement | null) => void): ReactNode | undefined {
  switch (n.type) {
    case "board": return <BoardView node={n} ctx={ctx} refCb={refCb} />;
    case "part": return null; // only ever drawn by its board
    case "bay": return <BayView node={n} ctx={ctx} refCb={refCb} />;
    case "gate": return <GateView node={n} ctx={ctx} refCb={refCb} />;
    case "press": return <PressView node={n} ctx={ctx} refCb={refCb} />;
    case "core": return <CoreView node={n} ctx={ctx} refCb={refCb} />;
    case "item": return <ItemView node={n} ctx={ctx} refCb={refCb} />;
    case "lamp": return <LampView node={n} refCb={refCb} />;
    case "gauge": return n.shape === "needle" ? <NeedleView node={n} refCb={refCb} /> : undefined;
    case "counter":
      if (n.style === "odometer") return <OdometerView node={n} refCb={refCb} />;
      if (!ctx.inBoard) return undefined;
      return (
        <div ref={refCb} className="bd-kv">
          <span>{str(n.label)}</span>
          <b style={{ color: TONE_INK[toneOf(n.tone, "default")] }}>{str(n.prefix)}{fixed(num(n.value) ?? 0, n.digits)}{str(n.unit) && ` ${str(n.unit)}`}</b>
        </div>
      );
    case "countdown": return n.shape === "ring" ? <RingCountdown node={n} ctx={ctx} refCb={refCb} /> : undefined;
    default: break;
  }
  if (!ctx.inBoard) return undefined;
  switch (n.type) {
    case "label":
      return <div ref={refCb} className="bd-label" data-size={n.size === "sm" ? "sm" : "md"} style={{ color: n.tone === undefined ? undefined : TONE_INK[toneOf(n.tone, "default")] }}>{str(n.text)}</div>;
    case "stat":
      return (
        <div ref={refCb} className="min-w-0">
          <div className="bd-kv"><span>{str(n.label)}</span><span className="bd-big" style={{ color: TONE_INK[toneOf(n.tone, "default")] }}>{str(n.value)}</span></div>
          {str(n.hint) && <div className="bd-small">{str(n.hint)}</div>}
        </div>
      );
    case "badge":
      return <span ref={refCb} className="bd-pill" data-tone={toneOf(n.tone, "muted")} style={{ alignSelf: "flex-start" }}>{str(n.text)}</span>;
    case "token":
      return <span ref={refCb} className="bd-tok" role="img" aria-label={str(n.label)} title={str(n.label)} style={{ ...toneVar(toneOf(n.tone, "accent")), width: 58, height: SLOT_H, alignSelf: "flex-start" }}>
        <span className="bd-tok-t">{str(n.label)}</span><span className="bd-tok-b" aria-hidden><b /><b /><b /></span>
      </span>;
    default:
      return undefined;
  }
}
