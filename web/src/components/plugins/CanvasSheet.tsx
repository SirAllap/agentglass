import { Fragment, useId, type ReactNode } from "react";
import type { CanvasNode } from "../../../../shared/pluginCanvas.ts";
import {
  arcPointsBox, bandPaths, bracketPath, edgePaths, hatchPath, labelLayout, moonRadius, onCircle, onPlane, pieSlice, planeGeom, tickPaths, trailSlices, VALUE_DROP,
  type LabelIn, type LabelSide, type PlaneGeom, type Pt,
} from "../../lib/canvasOrbit.ts";
import { TONE_COLOR, TONE_INK } from "../../lib/pluginTones.ts";
import { int, num, str, toneOf } from "./canvasRead.ts";
import "./canvasSheet.css";

/**
 * A sheet: one instrument drawn in SVG from a scene's `sheet` node
 * (shared/canvasSheet.ts). The plugin says what is at which angle; the
 * geometry is canvasOrbit.ts, and this file only turns it into elements.
 *
 * Every element it makes is one the reducer priced (`sheetCost`): no wrapper
 * group, many marks of one look in one path, an empty path not drawn. The
 * render test counts `svg *` against that function.
 *
 * Nothing from a scene reaches an attribute except a number (clamped by the
 * geometry) or a word looked up in a table: a tone is a CSS variable name, a
 * shape picks one of three marks, and text is text. Ids of defs are made with
 * useId, never from a scene's ids (a scene id would let two panels share a
 * gradient, or a plugin name one). The whole SVG takes no pointer: nothing in
 * a sheet is a control.
 *
 * Paint: one set of CSS variables per scheme (canvasSheet.css). `halo` is a
 * single element per token; the CSS decides whether it is a glow (dark) or an
 * accent ring (light), so there is no second code path.
 */

export interface SheetView {
  /** Where the clock is. */
  now: number;
  /** How far the planes have tipped (the fold opening): 0 = seen from above, 1 = as declared. */
  phase: number;
  /** Angles a moon is drawn at while it travels to the one the scene says. */
  at: ReadonlyMap<string, number>;
}

/** How far beyond the ring (as a share of its radius) the label columns keep clear: the clock, a gate band and a moon's halo. */
const BEYOND = 1.22;
const SHAPE_WORD: Record<string, string> = { ring: "waiting", dot: "in flight", diamond: "held" };
const ID_RE = /[^a-zA-Z0-9]/g;

interface Moon { n: CanvasNode; plane: PlaneGeom; at: number; x: number; y: number; r: number; near: number }

export function CanvasSheet({ sheet, kids, edges, view, className }: { sheet: CanvasNode; kids: ReadonlyMap<string | undefined, CanvasNode[]>; edges: readonly CanvasNode[]; view: SheetView; className?: string }) {
  const uid = useId().replace(ID_RE, "");
  const w = int(sheet.w, 320, 1200, 776), h = int(sheet.h, 200, 700, 412);
  const own = kids.get(sheet.id) ?? [];
  const planes = own.filter((k) => k.type === "plane");
  const orb = own.find((k) => k.type === "orb");
  const hatches = own.filter((k) => k.type === "hatch");
  const phase = view.phase;

  const geoms = new Map<string, PlaneGeom>(planes.map((p) => [p.id, planeGeom(p, phase)] as const));
  const moons: Moon[] = [];
  const moonById = new Map<string, Moon>();
  for (const p of planes) {
    const g = geoms.get(p.id)!;
    for (const k of kids.get(p.id) ?? []) {
      if (k.type !== "token") continue;
      const at = view.at.get(k.id) ?? num(k.at) ?? 0;
      const pt = onPlane(g, 1, at);
      const m: Moon = { n: k, plane: g, at, x: pt.x, y: pt.y, near: pt.near, r: moonRadius(k.size, pt.near, g.depth) };
      moons.push(m); moonById.set(k.id, m);
    }
  }
  const ordered = [...moons].sort((a, b) => a.near - b.near);

  // The room the label columns have: beside the widest ellipse, never off the sheet.
  let minX = w, maxX = 0;
  for (const p of planes) {
    for (const q of arcPointsBox(geoms.get(p.id)!)) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); }
    // A band or the clock sits outside the ring itself: leave room for the widest of them.
    for (const q of arcPointsBox(geoms.get(p.id)!, BEYOND)) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); }
  }
  const labelled: LabelIn[] = moons.filter((m) => str(m.n.label) && m.n.leader && m.n.leader !== "none")
    .map((m) => ({ id: m.n.id, x: m.x, y: m.y, r: m.r, side: m.n.leader as LabelSide, lines: str(m.n.value) ? 2 : 1 }));
  const { labels, dropped } = labelLayout(labelled, { w, h, left: Math.max(100, minX - 8), right: Math.min(w - 100, maxX + 8) });
  const labelOf = new Map(labels.map((l) => [l.id, l] as const));

  const orbC: Pt | undefined = orb ? { x: num(orb.cx) ?? 0, y: num(orb.cy) ?? 0 } : undefined;
  const orbR = orb ? int(orb.r, 8, 300, 40) : 0;
  const key = Array.isArray(sheet.key) ? (sheet.key as { shape: string; label: string }[]) : [];
  const keyWord = new Map(key.map((e) => [e.shape, e.label] as const));
  const chip = (() => {
    for (const p of planes) for (const k of kids.get(p.id) ?? []) if (k.type === "reticle") return { reticle: k, chip: str(k.chip) };
    return undefined;
  })();

  const label = str(sheet.label) ?? "instrument";
  const fade = Math.max(0, (phase - 0.6) / 0.4);

  // The planets' ring and clock are drawn per plane, in the order the plane lists them.
  const behind: ReactNode[] = [], front: ReactNode[] = [], edgesNear: ReactNode[] = [];
  for (const p of planes) {
    const g = geoms.get(p.id)!;
    // `kids` leaves edges out (they are drawn between nodes); the ones in this plane are drawn with it.
    for (const k of [...(kids.get(p.id) ?? []), ...edges.filter((e) => e.parent === p.id)]) {
      if (k.type === "band") {
        const paths = bandPaths(g, k);
        const color = TONE_COLOR[toneOf(k.tone, "accent")];
        const bucket = k.layer === "back" ? behind : front;
        bucket.push(<path key={`${k.id}-o`} className="cv-band-line" d={paths.outline} style={{ stroke: color }} />);
        if (paths.unlit) bucket.push(<path key={`${k.id}-u`} className="cv-band-unlit" d={paths.unlit} />);
        if (paths.lit) bucket.push(<path key={`${k.id}-l`} className="cv-band-lit" d={paths.lit} style={{ fill: color }} data-halo={k.halo === true ? "" : undefined} />);
      } else if (k.type === "ticks") {
        const t = tickPaths(g, k, view.now);
        const color = TONE_COLOR[toneOf(k.tone, "accent")];
        behind.push(<path key={`${k.id}-u`} className="cv-tick" d={t.unlit} />);
        if (t.passed) behind.push(<path key={`${k.id}-p`} className="cv-tick cv-tick-passed" d={t.passed} />);
        if (t.lit) behind.push(<path key={`${k.id}-l`} className="cv-tick cv-tick-lit" d={t.lit} style={{ stroke: color }} />);
        if (t.mark) behind.push(<path key={`${k.id}-m`} className="cv-tick cv-tick-mark" d={t.mark} />);
        behind.push(<path key={`${k.id}-h`} className="cv-hand" d={t.hand} style={{ stroke: color }} />);
        behind.push(<circle key={`${k.id}-d`} className="cv-hand-dot" cx={t.handDot.x} cy={t.handDot.y} r={2.4} style={{ fill: color }} />);
        const nums = Array.isArray(k.numerals) ? (k.numerals as { at: number; text: string }[]) : [];
        for (let i = 0; i < nums.length; i++) {
          const q = onPlane(g, 1 + 16 / g.rx, nums[i]!.at);
          behind.push(<text key={`${k.id}-n${i}`} className="cv-numeral" x={q.x} y={q.y + 3} textAnchor="middle" style={{ opacity: fade }}>{nums[i]!.text}</text>);
        }
      } else if (k.type === "edge") {
        const a = moonById.get(k.from as string), b = moonById.get(k.to as string);
        if (!a || !b) continue;
        const e = edgePaths(g, a.at, b.at, num(k.breakAt), num(k.breakGap));
        const color = TONE_COLOR[toneOf(k.tone, "accent")];
        const broken = k.breakAt !== undefined;
        if (e.far) behind.push(<path key={`${k.id}-f`} className="cv-edge cv-edge-far" d={e.far} style={{ stroke: color }} data-broken={broken ? "" : undefined} />);
        if (e.near) edgesNear.push(<path key={`${k.id}-n`} className="cv-edge cv-edge-near" d={e.near} style={{ stroke: color }} data-broken={broken ? "" : undefined} />);
        if (e.marks) edgesNear.push(<path key={`${k.id}-m`} className="cv-edge-marks" d={e.marks} style={{ stroke: TONE_COLOR[toneOf(k.tone, "danger")] }} />);
      }
    }
  }

  const stars = "M40 30h1M120 66h1M700 40h1M740 110h1M60 380h1M690 372h1M300 22h1M510 26h1M24 210h1M752 250h1";

  return (
    <div className={`cv-sheet ${className ?? ""}`} data-material={sheet.material === "inset" ? "inset" : "plain"} style={{ maxWidth: w }}>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="cv-svg" style={{ aspectRatio: `${w} / ${h}`, ["--cv-uid" as string]: uid }}>
        <defs>
          <radialGradient id={`${uid}-body`} cx="38%" cy="34%" r="75%"><stop offset="0%" style={{ stopColor: "var(--cv-orb-hi)" }} /><stop offset="100%" style={{ stopColor: "var(--cv-orb-lo)" }} /></radialGradient>
          <radialGradient id={`${uid}-sheen`} cx="50%" cy="50%" r="50%"><stop offset="0%" style={{ stopColor: "var(--cv-sheen)" }} /><stop offset="100%" style={{ stopColor: "var(--cv-sheen)", stopOpacity: 0 }} /></radialGradient>
        </defs>
        <rect className="cv-ground" x={0} y={0} width={w} height={h} />
        <path className="cv-stars" d={stars} />
        {planes.map((p) => {
          const g = geoms.get(p.id)!;
          return <ellipse key={p.id} className="cv-guide" cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} transform={`rotate(${(g.roll * 180) / Math.PI} ${g.cx} ${g.cy})`} />;
        })}
        {behind}
        {orb && orbC && <Orb orb={orb} c={orbC} r={orbR} uid={uid} roll={planes[0] ? geoms.get(planes[0].id)!.roll : 0} />}
        {hatches.map((hx) => {
          const target = own.find((k) => k.id === hx.of) ?? findBand(planes, kids, str(hx.of));
          if (!target || !orbC) return null;
          const onBand = target.type === "band";
          const g = onBand ? geoms.get(target.parent ?? "") : undefined;
          const c = onBand && g ? { x: g.cx, y: g.cy } : orbC;
          const r = onBand && g ? (num(target.r1) ?? 1) * g.rx : orbR;
          const from = num(hx.from) ?? 0, to = num(hx.to) ?? 360;
          const clip = `${uid}-clip-${hx.id.replace(ID_RE, "")}`;
          return (
            <Fragment key={hx.id}>
              <clipPath id={clip}><path d={pieSlice(c, r, from, to)} /></clipPath>
              <path className="cv-hatch" d={hatchPath(c, r, int(hx.gap, 6, 24, 8), num(hx.angle) ?? 45)} clipPath={`url(#${clip})`} />
            </Fragment>
          );
        })}
        {front}
        {edgesNear}
        {ordered.map((m) => <MoonMarks key={m.n.id} m={m} fade={fade} label={labelOf.get(m.n.id)} />)}
        {chip?.reticle && moonById.get(str(chip.reticle.of) ?? "") && (
          <path className="cv-reticle" d={bracketPath(moonById.get(str(chip.reticle.of)!)!, moonById.get(str(chip.reticle.of)!)!.r)} />
        )}
        {chip?.chip && <text className="cv-chip" x={16} y={24}>{chip.chip}</text>}
        {key.map((e, i) => {
          const x = w - 16 - (key.length - i) * 92;
          return (
            <Fragment key={i}>
              {e.shape === "diamond"
                ? <path className="cv-key-diamond" d={`M${x} ${20}l4 4-4 4-4-4z`} />
                : <circle className={e.shape === "dot" ? "cv-key-dot" : "cv-key-ring"} cx={x} cy={24} r={4} />}
              <text className="cv-key" x={x + 9} y={27}>{e.label}</text>
            </Fragment>
          );
        })}
        {(["left", "right"] as const).map((side) => dropped[side] > 0 && (
          <text key={side} className="cv-more" x={side === "left" ? Math.max(100, minX - 8) : Math.min(w - 100, maxX + 8)} y={h - 4} textAnchor={side === "left" ? "end" : "start"}>+{dropped[side]}</text>
        ))}
      </svg>
      <ul className="sr-only">
        {moons.map((m) => (
          <li key={m.n.id}>{[str(m.n.label), str(m.n.value) && `${str(m.n.value)}${str(m.n.unit) ? ` ${str(m.n.unit)}` : ""}`, m.n.shape !== undefined ? keyWord.get(String(m.n.shape)) ?? SHAPE_WORD[String(m.n.shape)] : undefined].filter(Boolean).join(", ")}</li>
        ))}
      </ul>
    </div>
  );
}

function findBand(planes: CanvasNode[], kids: ReadonlyMap<string | undefined, CanvasNode[]>, id: string | undefined): CanvasNode | undefined {
  if (!id) return undefined;
  for (const p of planes) for (const k of kids.get(p.id) ?? []) if (k.type === "band" && k.id === id) return k;
  return undefined;
}

function Orb({ orb, c, r, uid, roll }: { orb: CanvasNode; c: Pt; r: number; uid: string; roll: number }) {
  const light = num(orb.light) ?? 300;
  const bands = int(orb.bands, 0, 8, 0);
  const dir = onCircle({ x: 0, y: 0 }, 1, light);
  const sheen = { x: c.x + dir.x * r * 0.32, y: c.y + dir.y * r * 0.32 };
  // Latitude lines: chords parallel to the ring's roll, one path.
  let chords = "";
  const cr = Math.cos(roll), sr = Math.sin(roll);
  for (let i = 1; i <= bands; i++) {
    const o = -r + (2 * r * i) / (bands + 1);
    const half = Math.sqrt(Math.max(0, r * r - o * o));
    chords += `M${(c.x - half * cr - o * sr).toFixed(1)} ${(c.y - half * sr + o * cr).toFixed(1)}L${(c.x + half * cr - o * sr).toFixed(1)} ${(c.y + half * sr + o * cr).toFixed(1)}`;
  }
  const night = light + 180;
  const a = onCircle(c, r, night - 90), b = onCircle(c, r, night + 90);
  const bow = { x: c.x + dir.x * r * 0.28, y: c.y + dir.y * r * 0.28 };
  const edge = `M${a.x.toFixed(1)} ${a.y.toFixed(1)}Q${bow.x.toFixed(1)} ${bow.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  const shade = `${edge}A${r} ${r} 0 0 1 ${a.x.toFixed(1)} ${a.y.toFixed(1)}Z`;
  const tone = TONE_COLOR[toneOf(orb.tone, "accent")];
  return (
    <>
      {orb.halo === true && <circle className="cv-halo" cx={c.x} cy={c.y} r={r * 1.25} style={{ ["--cv-tone" as string]: tone }} />}
      <circle className="cv-orb" cx={c.x} cy={c.y} r={r} fill={`url(#${uid}-body)`} />
      {bands > 0 && <path className="cv-orb-bands" d={chords} />}
      <circle className="cv-orb-sheen" cx={sheen.x} cy={sheen.y} r={r * 0.62} fill={`url(#${uid}-sheen)`} />
      {orb.terminator === true && <path className="cv-orb-shade" d={shade} />}
      {orb.terminator === true && <path className="cv-orb-edge" d={edge} />}
    </>
  );
}

function MoonMarks({ m, fade, label }: { m: Moon; fade: number; label: { anchor: "start" | "middle" | "end"; x: number; y: number; line: string; side: string } | undefined }) {
  const n = m.n;
  const tone = toneOf(n.tone, "default");
  const color = TONE_COLOR[tone];
  const shape = n.shape === "dot" ? "dot" : n.shape === "diamond" ? "diamond" : "ring";
  const trail = int(n.trail, 0, 12, 0);
  const slices = trail > 0 ? trailSlices(m.plane, m.at, num(n.trailSpan) ?? 40, trail) : [];
  const count = num(n.count);
  const value = str(n.value);
  const unit = str(n.unit);
  return (
    <>
      {slices.map((s, i) => <path key={i} className="cv-trail" d={s.d} style={{ stroke: color, opacity: s.opacity }} />)}
      {n.halo === true && <circle className="cv-halo" cx={m.x} cy={m.y} r={m.r * 2.1} style={{ ["--cv-tone" as string]: color }} />}
      {shape === "diamond"
        ? <path className="cv-moon cv-moon-diamond" d={`M${m.x} ${m.y - m.r * 1.15}l${m.r * 1.15} ${m.r * 1.15}-${m.r * 1.15} ${m.r * 1.15}-${m.r * 1.15}-${m.r * 1.15}z`} style={{ stroke: color }} />
        : <circle className={`cv-moon cv-moon-${shape}`} cx={m.x} cy={m.y} r={m.r} style={{ stroke: color, ["--cv-fill" as string]: color }} />}
      {count !== undefined && <text className="cv-count" x={m.x} y={m.y + m.r * 0.38} textAnchor="middle" style={{ fontSize: m.r * 1.05 }}>{count > 99 ? "99+" : count}</text>}
      {label && str(n.label) && (
        <>
          <path className="cv-leader" d={label.line} style={{ opacity: fade }} />
          <text className="cv-label" x={label.x} y={label.y} textAnchor={label.anchor} style={{ opacity: fade, fill: TONE_INK[tone === "default" ? "muted" : tone] }}>{str(n.label)}</text>
        </>
      )}
      {label && value && <text className="cv-value" x={label.x} y={label.y + VALUE_DROP} textAnchor={label.anchor} style={{ opacity: fade }}>{`${value}${unit ? ` ${unit}` : ""}`}</text>}
    </>
  );
}
