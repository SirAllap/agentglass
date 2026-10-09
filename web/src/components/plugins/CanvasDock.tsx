import { createContext, useContext, useId, type ReactNode } from "react";
import type { CanvasAction, CanvasNode } from "../../../../shared/pluginCanvas.ts";
import { arcPath, fraction, polar } from "../../lib/canvasGeometry.ts";
import { useFoldPhase } from "../../lib/canvasView.ts";
import { TONE_COLOR, TONE_INK } from "../../lib/pluginTones.ts";
import { int, num, str, toneOf } from "./canvasRead.ts";
import type { Ctx } from "./PluginCanvas.tsx";
import "./canvasDock.css";

/**
 * A `dock` (a tile that holds one gauge and says which stop of a journey it is)
 * and a `fold` (a bar that opens a drawer), and the gauge shapes they bring.
 * shared/canvasSheet.ts is the vocabulary.
 *
 * Both are DOM, not SVG: they are controls, they take focus and the keyboard,
 * and they sit in the page's own flow. What they do not do: a fold's height is
 * chosen when it is added and never changes (a control below it never moves
 * under the pointer because of a plugin), and whether it is OPEN is the
 * window's own state, kept across a reconnect and reset by nobody; a plugin
 * hears of it only through the fold's `action`, when it declared one.
 */

/** How far the enclosing fold has opened, for a sheet inside it to tip by. 1 outside any fold. */
export const FoldPhase = createContext(1);
export const useFoldPhaseOf = (): number => useContext(FoldPhase);

const GAUGE = 52;

/** The graphic of a gauge, with no text: an arc, ring, bar, pips, needle, ticks or segments. Also `mark` and `values`. */
export function GaugeGlyph({ node: n, size = GAUGE }: { node: CanvasNode; size?: number }): ReactNode {
  const uid = useId();
  const value = num(n.value) ?? 0, max = num(n.max) ?? 1;
  const f = fraction(value, max);
  const color = TONE_COLOR[toneOf(n.tone, "accent")];
  const c = size / 2, r = c - 5;
  const mark = num(n.mark);
  const track = "var(--surface-line)";
  const tick = (frac: number, from: number, sweep: number, r0: number, r1: number) => {
    const a = from + sweep * frac, p0 = polar(c, c, r0, a), p1 = polar(c, c, r1, a);
    return `M${p0.x.toFixed(1)} ${p0.y.toFixed(1)}L${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  };
  const svg = (children: ReactNode) => <svg key={uid} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0">{children}</svg>;
  switch (n.shape) {
    case "arc":
    case "needle": {
      const values = Array.isArray(n.values) ? (n.values as number[]).slice(0, 3) : undefined;
      if (values) {
        return svg(<>
          {values.map((v, i) => (
            <g key={i}>
              <path d={arcPath(c, c, r - i * 6, -135, 135)} fill="none" stroke={track} strokeWidth={4} strokeLinecap="round" />
              {v > 0 && <path d={arcPath(c, c, r - i * 6, -135, -135 + 270 * v)} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round" opacity={1 - i * 0.28} />}
            </g>
          ))}
          {mark !== undefined && <path d={tick(mark, -135, 270, r - 14, r + 3)} stroke="var(--text2)" strokeWidth={1.6} />}
        </>);
      }
      return svg(<>
        <path d={arcPath(c, c, r, -135, 135)} fill="none" stroke={track} strokeWidth={5} strokeLinecap="round" />
        {f > 0 && <path d={arcPath(c, c, r, -135, -135 + 270 * f)} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" />}
        {mark !== undefined && <path d={tick(mark, -135, 270, r - 6, r + 5)} stroke="var(--text2)" strokeWidth={1.6} />}
      </>);
    }
    case "ring": {
      const circ = 2 * Math.PI * r;
      return svg(<>
        <circle cx={c} cy={c} r={r} fill="none" stroke={track} strokeWidth={5} />
        <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" strokeDasharray={`${circ * f} ${circ}`} transform={`rotate(-90 ${c} ${c})`} />
        {mark !== undefined && <path d={tick(mark, -90, 360, r - 6, r + 5)} stroke="var(--text2)" strokeWidth={1.6} />}
      </>);
    }
    case "ticks": {
      const total = int(n.max, 8, 120, 60), lit = Math.round(Math.min(total, Math.max(0, value)));
      let on = "", off = "";
      for (let i = 0; i < total; i++) {
        const seg = tick(i / total, -90, 360, r - 6, r + 1);
        if (i < lit) on += seg; else off += seg;
      }
      return svg(<>
        <path d={off} fill="none" stroke={track} strokeWidth={1.6} strokeLinecap="round" />
        <path d={on} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
        {mark !== undefined && <path d={tick(mark, -90, 360, r - 9, r + 4)} stroke="var(--text2)" strokeWidth={1.6} />}
      </>);
    }
    case "segments": {
      const total = int(n.max, 1, 12, 4), lit = Math.round(Math.min(total, Math.max(0, value)));
      const w = 360 / total, pad = Math.min(14, w / 4);
      let on = "", off = "";
      for (let i = 0; i < total; i++) {
        const d = arcPath(c, c, r, -90 + i * w + pad / 2, -90 + (i + 1) * w - pad / 2);
        if (i < lit) on += d; else off += d;
      }
      return svg(<>
        <path d={off} fill="none" stroke={track} strokeWidth={5} strokeLinecap="round" />
        <path d={on} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" />
      </>);
    }
    case "pips": {
      const total = Number.isInteger(max) && max <= 40 ? max : 20, on = Math.round(f * total);
      return (
        <div className="flex flex-wrap gap-0.5" aria-hidden style={{ maxWidth: size * 2 }}>
          {Array.from({ length: total }, (_, i) => <span key={i} className="rounded-sm" style={{ width: 5, height: 11, background: i < on ? color : track }} />)}
        </div>
      );
    }
    default:
      return (
        <div className="relative h-[6px] rounded-full overflow-hidden" aria-hidden style={{ width: size, background: "var(--surface-inset)" }}>
          <div className="absolute left-0 top-0 bottom-0 rounded-full" style={{ width: `${Math.round(f * 100)}%`, background: color }} />
        </div>
      );
  }
}

/** Shapes the flow view's own Gauge does not draw: it hands them (and `mark`/`values`) to the glyph above. */
export const isGlyphShape = (n: CanvasNode): boolean => n.shape === "ticks" || n.shape === "segments" || n.mark !== undefined || n.values !== undefined;

export function Dock({ node: n, ctx, refCb }: { node: CanvasNode; ctx: Ctx; refCb: (el: HTMLElement | null) => void }) {
  const tone = toneOf(n.tone, "default");
  const gauge = (ctx.kids.get(n.id) ?? []).find((k) => k.type === "gauge");
  const action = n.action as CanvasAction | undefined;
  const selected = n.selected === true, here = n.here === true;
  const leg = n.leg === "busy" || n.leg === "flowing" ? n.leg : "idle";
  const value = str(n.value), unit = str(n.unit);
  const press = () => {
    ctx.view.revealFold();
    if (action) void ctx.onAction(action);
  };
  return (
    <button ref={refCb as (el: HTMLButtonElement | null) => void} type="button" className="cv-dock" data-selected={selected ? "true" : "false"} data-here={here ? "true" : "false"} data-leg={leg}
      aria-pressed={selected} disabled={ctx.stopped} onClick={(e) => { e.stopPropagation(); press(); }}>
      <span className="cv-dock-journey" aria-hidden><i className="cv-dock-leg" /><i className="cv-dock-node" /></span>
      <span className="cv-dock-title">{str(n.title)}</span>
      <span className="cv-dock-main">
        {gauge && <GaugeGlyph node={gauge} />}
        <span className="min-w-0">
          {value && <span className="cv-dock-value" style={{ color: TONE_INK[tone === "default" ? "default" : tone] }}>{value}</span>}
          {unit && <span className="cv-dock-unit">{unit}</span>}
        </span>
      </span>
      {str(n.hint) && <span className="cv-dock-hint">{str(n.hint)}</span>}
      {str(n.hint2) && <span className="cv-dock-hint">{str(n.hint2)}</span>}
    </button>
  );
}

export function Fold({ node: n, ctx, refCb }: { node: CanvasNode; ctx: Ctx; refCb: (el: HTMLElement | null) => void }) {
  const open = ctx.view.folds.get(n.id) ?? n.open === true;
  const phase = useFoldPhase(open, ctx.view.reduced);
  const wide = int(n.h, 160, 760, 420);
  const h = ctx.view.fit === "narrow" ? int(n.hNarrow, 160, 760, wide) : wide;
  const id = useId();
  return (
    <section ref={refCb} className="cv-fold" data-open={open ? "true" : "false"}>
      <button type="button" className="cv-fold-bar" aria-expanded={open} aria-controls={id} disabled={ctx.stopped}
        onClick={(e) => { e.stopPropagation(); ctx.view.setFold(n.id, !open); if (n.action) void ctx.onAction(n.action as CanvasAction); }}>
        <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden style={{ transform: `rotate(${-90 * (1 - phase)}deg)` }}><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="cv-fold-label">{str(n.label)}</span>
      </button>
      <div id={id} className="cv-fold-clip" style={{ height: h * phase }} aria-hidden={!open || undefined} {...(open ? {} : { inert: "" } as object)}>
        {(open || phase > 0) && (
          <FoldPhase.Provider value={phase}>
            <div className="cv-fold-inner" style={{ height: h }}>{(ctx.kids.get(n.id) ?? []).map((k) => ctx.draw(k, ctx))}</div>
          </FoldPhase.Provider>
        )}
      </div>
    </section>
  );
}

