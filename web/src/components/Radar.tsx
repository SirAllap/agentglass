import { useState } from "react";
import { motion } from "motion/react";
import { Panel } from "./Panel.tsx";
import { fmtUsd, fmtTokens } from "../lib/format.ts";
import type { AgentCard, AgentStatus } from "../lib/derive.ts";

const STATUS_COLOR: Record<string, string> = {
  working: "var(--success)",
  waiting: "var(--warning)",
  errored: "var(--error)",
  idle: "var(--text4)",
};
const STATUS_ORDER: AgentStatus[] = ["working", "waiting", "errored", "idle"];
/**
 * A finished blip, tinted by how it finished.
 *
 * The fleet wall and the radar show the same sessions, so they have to agree:
 * a run marked as having stopped on an unanswered question over there must not
 * be an anonymous grey dot here. Only idle blips are tinted — everything live
 * keeps its status colour, because that is still the more urgent fact.
 */
const OUTCOME_COLOR: Record<string, string> = {
  unanswered: "var(--warning)",
  faulted: "var(--error)",
  // settled and unclear both stay grey: neither wants anything from you, and
  // a wall of green dots for "done" would drown the two that do.
};

// viewBox geometry — everything is authored in these units and scaled to fit.
const VB = 240;
const C = VB / 2;
const R = 104; // outer ring radius
/** Compaction typically fires before the raw model max is reached.
 *  Anchor the outer ring to this fraction of ctxLimit so "edge" means
 *  "about to compact", not "model max". */
const COMPACT_FRAC = 0.9;
const INNER = 16;
const OUTER = R - 10; // keep a small margin inside the drawn ring

const P = (deg: number, rad: number): [number, number] => [
  C + rad * Math.cos((deg * Math.PI) / 180),
  C + rad * Math.sin((deg * Math.PI) / 180),
];

/** A session's fixed bearing on the dial — hashed from its key so a blip
 *  keeps its angle for its whole life instead of jumping every re-sort. */
function bearingOf(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

/** Live radar: distance from centre = context window used. A fresh session
 *  sits at the middle; a blip drifting to the outer ring is about to
 *  compact. Sessions with no turn data yet fall back to recency, dimmed. */
export function Radar({ agents, onSelect }: { agents: AgentCard[]; onSelect?: (a: AgentCard) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const now = Date.now();

  const blips = agents.slice(0, 24).map((a) => {
    // Raw fraction of model max, then re-anchor so 1.0 == compaction threshold.
    const rawFrac = a.ctxTokens > 0 && a.ctxLimit > 0 ? Math.min(1, a.ctxTokens / a.ctxLimit) : null;
    const compactFrac = rawFrac == null ? null : Math.min(1, rawFrac / COMPACT_FRAC);
    // Mild ease-in: expand the outer band where compaction decisions live.
    const eased = compactFrac == null ? null : Math.pow(compactFrac, 0.7);
    const age = Math.min(1, (now - a.lastSeen) / (5 * 60_000)); // recency fallback: 0 fresh → 1 old
    const radius = INNER + (eased ?? age) * (OUTER - INNER);
    const angle = bearingOf(a.key);
    const busy = Math.min(1, a.spark.reduce((s, v) => s + v, 0) / 12);
    const [x, y] = P(angle, radius);
    const color = (a.status === "idle" ? OUTCOME_COLOR[a.outcome] : undefined) ?? STATUS_COLOR[a.status] ?? "var(--text4)";
    // `frac` stays the raw fraction of the model max: it feeds the tooltip and
    // the legend, which talk about context used. Only the *radius* is anchored
    // to the compaction threshold.
    return { a, x, y, frac: rawFrac, size: 3.4 + busy * 4.2, color };
  });

  const counts = STATUS_ORDER.map((s) => ({ s, n: agents.filter((a) => a.status === s).length }));

  // Sweep trail: a fan of radial lines fading behind the leading edge.
  const TRAIL = 66;
  const FAN = 16;
  const sweep = Array.from({ length: FAN }, (_, i) => {
    const t = i / (FAN - 1);
    const [x2, y2] = P(-t * TRAIL, R - 6);
    return { x2, y2, op: 0.34 * (1 - t) };
  });
  const [leadX, leadY] = P(0, R - 6);

  const hovered = blips.find((b) => b.a.key === hover);

  return (
    <Panel
      eyebrow="Radar"
      title="Live radar"
      right={<span className="text-[10px] t-dim2">{agents.length} tracked · edge = about to compact</span>}
    >
      <div className="flex flex-col h-full">
        <div className="relative flex-1 min-h-0 flex items-center justify-center">
          <svg
            viewBox={`0 0 ${VB} ${VB}`}
            preserveAspectRatio="xMidYMid meet"
            className="w-full h-full"
            style={{ maxWidth: 340, maxHeight: 340 }}
          >
            <defs>
              <radialGradient id="rdr-field" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="color-mix(in srgb, var(--primary) 20%, transparent)" />
                <stop offset="70%" stopColor="color-mix(in srgb, var(--primary) 6%, transparent)" />
                <stop offset="100%" stopColor="transparent" />
              </radialGradient>
            </defs>

            {/* field wash */}
            <circle cx={C} cy={C} r={R} fill="url(#rdr-field)" />

            {/* range rings (relative to outer drawing radius) */}
            {[0.34, 0.67, 1].map((r) => (
              <circle
                key={r}
                cx={C}
                cy={C}
                r={R * r}
                fill="none"
                stroke="color-mix(in srgb, var(--primary) 22%, transparent)"
                strokeWidth={1}
              />
            ))}

            {/* compaction threshold ring — the "danger line" blips cross */}
            <circle
              cx={C}
              cy={C}
              r={OUTER}
              fill="none"
              stroke="color-mix(in srgb, var(--warning) 70%, transparent)"
              strokeWidth={1.4}
              strokeDasharray="3 3"
              opacity={0.9}
            />

            {/* cross axes */}
            <line x1={C} y1={C - R} x2={C} y2={C + R} stroke="color-mix(in srgb, var(--primary) 14%, transparent)" />
            <line x1={C - R} y1={C} x2={C + R} y2={C} stroke="color-mix(in srgb, var(--primary) 14%, transparent)" />

            {/* bearing ticks every 30° */}
            {Array.from({ length: 12 }, (_, i) => i * 30).map((deg) => {
              const [x1, y1] = P(deg, R);
              const [x2, y2] = P(deg, deg % 90 === 0 ? R - 8 : R - 4);
              return (
                <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2} stroke="color-mix(in srgb, var(--primary) 30%, transparent)" strokeWidth={1} />
              );
            })}

            {/* range labels — distance is fraction-to-compaction, not raw model max */}
            <text x={C + 3} y={C - R * 0.34 + 8} fontSize={7} fill="var(--text4)" className="tabular-nums">⅓ →compact</text>
            <text x={C + 3} y={C - R + 10} fontSize={7} fill="var(--text4)" className="tabular-nums">compact</text>

            {/* (sweep lives in a separate, GPU-composited <svg> overlay below) */}

            {/* blips */}
            {blips.map((b) => {
              const active = b.a.key === hover;
              return (
                <motion.g
                  key={b.a.key}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.4 }}
                  style={{ cursor: onSelect ? "pointer" : "default" }}
                  onMouseEnter={() => setHover(b.a.key)}
                  onMouseLeave={() => setHover((h) => (h === b.a.key ? null : h))}
                  onClick={() => onSelect?.(b.a)}
                >
                  {/* generous invisible hit area */}
                  <circle cx={b.x} cy={b.y} r={Math.max(b.size + 5, 8)} fill="transparent" />
                  {/* halo — a soft translucent disc (no SVG filter: filters
                      re-raster every frame as the sweep passes over them) */}
                  <circle cx={b.x} cy={b.y} r={b.size + (active ? 4 : 2.6)} fill={b.color} opacity={active ? 0.4 : 0.2} />
                  {/* core — dimmed when the position is recency fallback, not context */}
                  <circle cx={b.x} cy={b.y} r={active ? b.size + 1 : b.size} fill={b.color} opacity={b.frac == null ? 0.55 : 1} />
                </motion.g>
              );
            })}

            {/* centre marker */}
            <circle cx={C} cy={C} r={3.4} fill="var(--primary)" />

            {/* hover tooltip (rendered last, on top) */}
            {hovered && <Tooltip b={hovered} />}
          </svg>

          {/* Sweep as a separate <svg> ELEMENT rotated by CSS. Rotating a
              replaced element composites on the GPU (0 layout/frame); rotating
              an inner <g> forced a main-thread layout every frame. */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <svg className="rdr-sweep" viewBox={`0 0 ${VB} ${VB}`} preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "100%", maxWidth: 340, maxHeight: 340 }}>
              {sweep.map((s, i) => (
                <line key={i} x1={C} y1={C} x2={s.x2} y2={s.y2} stroke="var(--primary)" strokeWidth={1.2} strokeOpacity={s.op} strokeLinecap="round" />
              ))}
              <line x1={C} y1={C} x2={leadX} y2={leadY} stroke="var(--primary)" strokeWidth={1.8} strokeOpacity={0.95} strokeLinecap="round" />
            </svg>
          </div>

          {agents.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-[11px] t-dim2">no agents tracked yet</div>
          )}
        </div>

        <p className="text-center text-[10px] t-dim2 mt-1 px-2">
          center = fresh context · <span style={{ color: "var(--warning)" }}>edge = about to compact</span>
        </p>
        <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 mt-1 text-[10px] t-dim2">
          {counts.map(({ s, n }) => (
            <span key={s} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[s] }} />
              {s}
              <span className="tabular-nums" style={{ color: n ? "var(--text3)" : "var(--text4)" }}>{n}</span>
            </span>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function Tooltip({ b }: { b: { a: AgentCard; x: number; y: number; frac: number | null } }) {
  const lines = [
    b.a.key,
    `${b.a.status} · ${b.a.lastType || "—"}`,
    b.frac != null
      ? `ctx ${fmtTokens(b.a.ctxTokens)} / ${fmtTokens(b.a.ctxLimit)} (${Math.round(b.frac * 100)}% · ${Math.round(Math.min(1, b.frac / COMPACT_FRAC) * 100)}%→compact)`
      : "ctx unknown — placed by recency",
    `${b.a.tools} tools · ${fmtUsd(b.a.cost)}`,
  ];
  const w = Math.min(150, Math.max(...lines.map((l) => l.length)) * 4.4 + 12);
  const h = 12 + lines.length * 10;
  const tx = Math.max(2, Math.min(VB - w - 2, b.x + 8));
  const ty = Math.max(2, Math.min(VB - h - 2, b.y - h - 6));
  return (
    <g pointerEvents="none">
      <rect x={tx} y={ty} width={w} height={h} rx={4} fill="var(--bg2)" stroke="var(--border)" strokeWidth={1} opacity={0.97} />
      {lines.map((l, i) => (
        <text
          key={i}
          x={tx + 6}
          y={ty + 11 + i * 10}
          fontSize={i === 0 ? 8 : 7.5}
          fontWeight={i === 0 ? 600 : 400}
          fill={i === 0 ? "var(--text)" : "var(--text3)"}
        >
          {l}
        </text>
      ))}
    </g>
  );
}
