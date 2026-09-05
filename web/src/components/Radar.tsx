import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Panel } from "./Panel.tsx";
import { fmtUsd, fmtTokens, fmtEq, eqTitle } from "../lib/format.ts";
import type { AgentCard, AgentStatus } from "../lib/derive.ts";

const STATUS_COLOR: Record<string, string> = {
  working: "var(--success)",
  waiting: "var(--warning)",
  stalled: "var(--warning)",
  errored: "var(--error)",
  failed: "var(--error)",
  idle: "var(--text4)",
};
/** Legend order. `stalled` and `failed` share a hue with the state above them,
 *  which is deliberate — the dial has no room for a sixth colour anybody could
 *  learn, and the shape carries the difference: a stalled blip wears a broken
 *  ring nothing else on the dial has. */
const STATUS_ORDER: AgentStatus[] = ["working", "waiting", "stalled", "errored", "failed", "idle"];
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

/** Wide enough for a dossier beside the dial rather than under it. Measured on
 *  the panel body: this panel is three columns of a twelve-column grid on one
 *  window and the full width on another, so a viewport media query would be
 *  answering a different question. */
const DOSSIER_SIDE_AT = 470;

function useWide(ref: React.RefObject<HTMLElement | null>, at: number): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setWide(entries[0].contentRect.width >= at));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, at]);
  return wide;
}

/** Live radar: distance from centre = context window used. A fresh session
 *  sits at the middle; a blip drifting to the outer ring is about to
 *  compact. Sessions with no turn data yet fall back to recency, dimmed. */
export function Radar({ agents, onSelect }: { agents: AgentCard[]; onSelect?: (a: AgentCard) => void }) {
  /* The targeted blip, and it STAYS targeted after the pointer leaves. The
     readout it fills is a fixed slot, not a floating label, so clearing on
     mouse-out would blank the panel every time you moved to read it. */
  const [hover, setHover] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const wide = useWide(body, DOSSIER_SIDE_AT);
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

  // Every state the dial can show, minus the two exceptional ones when nothing
  // is in them: a legend line reading "stalled 0" teaches nothing and costs the
  // four everyday states a row of width on a narrow panel.
  const counts = STATUS_ORDER
    .map((s) => ({ s, n: agents.filter((a) => a.status === s).length }))
    .filter(({ s, n }) => n > 0 || (s !== "stalled" && s !== "failed"));

  // Sweep trail: a fan of radial lines fading behind the leading edge.
  const TRAIL = 66;
  const FAN = 16;
  const sweep = Array.from({ length: FAN }, (_, i) => {
    const t = i / (FAN - 1);
    const [x2, y2] = P(-t * TRAIL, R - 6);
    return { x2, y2, op: 0.34 * (1 - t) };
  });
  const [leadX, leadY] = P(0, R - 6);

  /* Nothing targeted yet shows the session closest to compacting, rather than
     an empty column: that is the one the dial exists to warn you about. The
     dossier labels it as such, so a readout you did not choose never reads as
     one you did. */
  let auto: (typeof blips)[number] | null = null;
  for (const b of blips) if (b.frac != null && (auto == null || b.frac > (auto.frac ?? 0))) auto = b;
  const target = blips.find((b) => b.a.key === hover) ?? auto ?? blips[0] ?? null;

  return (
    <Panel
      eyebrow="Radar"
      title="Live radar"
      right={<span className="text-[10px] t-dim2">{agents.length} tracked · edge = about to compact</span>}
    >
      {/* Dial and dossier: side by side when the panel is wide enough for both,
          stacked when it is not. The detail used to be a tooltip drawn inside
          the SVG, which sized its box from an estimated glyph width and then
          drew text that ignored the box — a 48-character session key painted
          straight out of the card and off the panel. A dossier in normal flow
          cannot overflow, and it does not cover the blips you are comparing. */}
      <div ref={body} className={`flex h-full min-h-0 ${wide ? "gap-3" : "flex-col"}`}>
        <div className="flex flex-col min-w-0 min-h-0 flex-1">
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

            {/* range rings — inner guides only, anchored to the blip band
                (OUTER). The edge itself is the dashed compaction ring below,
                so no solid ring is drawn at r=1: it sat outside the band and
                read as a second, redundant edge. */}
            {[0.34, 0.67].map((r) => (
              <circle
                key={r}
                cx={C}
                cy={C}
                r={OUTER * r}
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

            {/* range labels — distance is fraction-to-compaction, not raw model
                max; anchored to OUTER so `compact` sits on the dashed ring. */}
            <text x={C + 3} y={C - OUTER * 0.34 + 8} fontSize={7} fill="var(--text4)" className="tabular-nums">⅓ →compact</text>
            <text x={C + 3} y={C - OUTER + 10} fontSize={7} fill="var(--text4)" className="tabular-nums">compact</text>

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
                  onClick={() => onSelect?.(b.a)}
                >
                  {/* generous invisible hit area */}
                  <circle cx={b.x} cy={b.y} r={Math.max(b.size + 5, 8)} fill="transparent" />
                  {/* halo — a soft translucent disc (no SVG filter: filters
                      re-raster every frame as the sweep passes over them) */}
                  <circle cx={b.x} cy={b.y} r={b.size + (active ? 4 : 2.6)} fill={b.color} opacity={active ? 0.4 : 0.2} />
                  {/* core — dimmed when the position is recency fallback, not context */}
                  <circle cx={b.x} cy={b.y} r={active ? b.size + 1 : b.size} fill={b.color} opacity={b.frac == null ? 0.55 : 1} />
                  {/* A stalled session wears a broken ring. Colour cannot carry
                      it here — amber already means "waiting on you" — and at
                      four pixels a blip has no room for a silhouette, so the
                      difference goes outside the blip instead of inside it. */}
                  {b.a.status === "stalled" && (
                    <circle cx={b.x} cy={b.y} r={b.size + 4.5} fill="none" stroke={b.color}
                      strokeWidth="1.2" strokeDasharray="2.4 2.4" opacity={0.9} />
                  )}
                </motion.g>
              );
            })}

            {/* centre marker */}
            <circle cx={C} cy={C} r={3.4} fill="var(--primary)" />
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
            <div className="absolute inset-0 flex items-center justify-center text-[11px] t-dim2">No agents tracked yet</div>
          )}
        </div>

        {/* Dropped when the dossier is stacked under the dial: the panel header
            already says "edge = about to compact", and a line of repeated help
            text is worth less than the room the readout needs. */}
        {(wide || !target) && (
          <p className="text-center text-[10px] t-dim2 mt-1 px-2">
            center = fresh context · <span style={{ color: "var(--warning)" }}>edge = about to compact</span>
          </p>
        )}
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

        {target && <Dossier b={target} wide={wide} auto={target.a.key !== hover} />}
      </div>
    </Panel>
  );
}

/**
 * The targeted blip, read out in full.
 *
 * The key is one string doing two jobs — an app and a session id — so it is
 * split: the name at full weight, the id underneath where it can wrap. That is
 * what fixes the overflow. Nothing here measures text; the browser does.
 */
function Dossier({ b, wide, auto }: {
  b: { a: AgentCard; frac: number | null; color: string };
  /** Beside the dial (a column) or under it (a strip). */
  wide: boolean;
  /** True when this is the panel's own pick, not the one you pointed at. */
  auto: boolean;
}) {
  const a = b.a;
  const toCompact = b.frac == null ? null : Math.round(Math.min(1, b.frac / COMPACT_FRAC) * 100);
  const name = a.title || a.source_app;
  const hot = toCompact != null && toCompact >= 75;

  const status = (
    <span className="flex items-center gap-1 min-w-0">
      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: b.color }} />
      <span className="truncate">{a.status} · {a.lastType || "—"}</span>
    </span>
  );
  const meter = (
    <span className="flex items-center gap-1.5 min-w-0 flex-1">
      <span className="h-1 flex-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--border) 45%, transparent)", minWidth: 32 }}>
        <span className="block h-full rounded-full" style={{
          width: `${toCompact ?? 0}%`,
          background: hot ? "var(--warning)" : "var(--primary)",
        }} />
      </span>
      <span className="tabular-nums shrink-0" style={{ color: hot ? "var(--warning)" : "var(--text3)" }}>
        {toCompact}%→compact
      </span>
    </span>
  );

  // Stacked: three lines, because the dial pays for every one of them in height.
  if (!wide) {
    return (
      <div className="shrink-0 mt-1.5 pt-1.5 flex flex-col gap-1 text-[9.5px] t-dim2 min-w-0"
        style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[10.5px] font-medium truncate" style={{ color: "var(--text)" }}>{name}</span>
          {status}
          <span className="ml-auto tabular-nums shrink-0">{a.tools} tools · {fmtUsd(a.cost)}</span>
        </div>
        <div className="truncate" title={a.key}>{a.session_id}</div>
        {toCompact != null
          ? <div className="flex items-center gap-2 min-w-0">{meter}<span className="tabular-nums shrink-0" title={eqTitle(a.tokens)}>{fmtEq(a.tokens)}</span></div>
          : <div>ctx unknown — placed by recency</div>}
      </div>
    );
  }

  // Beside the dial: room for the id in full and for the numbers to line up.
  return (
    <div className="shrink-0 w-[176px] pl-3 flex flex-col gap-2 text-[9.5px] t-dim2 min-w-0"
      style={{ borderLeft: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>
          {auto ? "closest to compact" : "targeted"}
        </span>
        <span className="text-[11.5px] font-medium truncate" style={{ color: "var(--text)" }} title={a.key}>{name}</span>
        <span className="break-all leading-snug">{a.session_id}</span>
      </div>
      {status}
      {toCompact != null ? (
        <div className="flex flex-col gap-1.5">
          {meter}
          <Row k="context" v={`${fmtTokens(a.ctxTokens)} / ${fmtTokens(a.ctxLimit)}`} />
        </div>
      ) : (
        <div className="leading-snug">ctx unknown — placed by recency</div>
      )}
      <Row k="tool calls" v={String(a.tools)} />
      <Row k="cost" v={fmtUsd(a.cost)} />
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 min-w-0">
      <span className="shrink-0">{k}</span>
      <span className="tabular-nums truncate" style={{ color: "var(--text3)" }}>{v}</span>
    </div>
  );
}

