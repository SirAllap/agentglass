import NumberFlow from "@number-flow/react";
import { motion } from "motion/react";
import type { StatsSummary } from "../../../shared/types.ts";
import type { AgentCard } from "../lib/derive.ts";
import { useTicker, fmtClock } from "../lib/motion.ts";
import { HealthRing } from "./HealthRing.tsx";

const enter = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } };

/** A compact area sparkline (spend over the window). */
function Spark({ values, color }: { values: number[]; color: string }) {
  const w = 104, h = 40;
  if (values.length < 2) return null;
  const max = Math.max(...values, 1e-9);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - (v / max) * (h - 6) - 3] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} ${w},${h} 0,${h}`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      <polygon points={area} fill={`color-mix(in srgb, ${color} 16%, transparent)`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={2.4} fill={color} />
    </svg>
  );
}

function PulseCell({ k, v, u, accent }: { k: string; v: number; u: string; accent?: string }) {
  return (
    <div className="px-4 py-3 min-w-0">
      <div className="panel-eyebrow">{k}</div>
      <div className="text-[23px] font-semibold leading-none tabular-nums mt-1" style={{ color: accent ?? "var(--text)" }}>
        <NumberFlow value={v} />
      </div>
      <div className="text-[10px] t-dim2 mt-1 truncate">{u}</div>
    </div>
  );
}

const CELL_BG = "color-mix(in srgb, var(--bg2) 66%, transparent)";

/** A status cell that only lights up when it needs attention. */
function StatusCell({ k, v, color }: { k: string; v: number; color: string }) {
  const hot = v > 0;
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 min-w-0"
      style={{ background: hot ? `color-mix(in srgb, ${color} 11%, transparent)` : CELL_BG }}
    >
      <span
        className="h-2.5 w-2.5 rounded-full shrink-0"
        style={{ background: hot ? color : "var(--text4)", boxShadow: hot ? `0 0 8px ${color}` : "none" }}
      />
      <div className="min-w-0">
        <div className="panel-eyebrow">{k}</div>
        <div className="text-[22px] font-semibold leading-none tabular-nums mt-0.5" style={{ color: hot ? color : "var(--text3)" }}>
          <NumberFlow value={v} />
        </div>
      </div>
    </div>
  );
}

export function Kpis({
  stats,
  agents,
  startedAt,
  epm,
}: {
  stats: StatsSummary | null;
  agents: AgentCard[];
  startedAt: number;
  epm: number;
}) {
  const elapsed = useTicker(startedAt);
  const t = stats?.totals;
  const working = agents.filter((a) => a.status === "working").length;
  const waiting = agents.filter((a) => a.status === "waiting").length;
  const failed = t?.errors ?? 0;
  const tools = t?.tool_calls ?? 0;
  const cost = t?.cost_usd ?? 0;
  const tokens = (t?.input_tokens ?? 0) + (t?.output_tokens ?? 0);
  const cached = t?.cache_read_tokens ?? 0;
  const health = tools > 0 ? Math.max(0, Math.round((1 - failed / Math.max(tools, 1)) * 100)) : 100;
  const spark = (stats?.timeline ?? []).slice(-24).map((b) => b.cost_usd);
  const healthLabel = health >= 80 ? "all nominal" : health >= 50 ? "degraded" : "critical";
  const healthColor = health >= 80 ? "var(--success)" : health >= 50 ? "var(--warning)" : "var(--error)";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1.1fr_1.4fr] gap-2">
      {/* hero — spend + health lead the eye */}
      {/* flex-wrap: on a phone the sparkline + health ring drop below the
          number instead of crushing it into a three-line label. */}
      <motion.div {...enter} transition={{ type: "spring", stiffness: 300, damping: 26 }} className="panel flex-row flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
        <div className="min-w-0 grow">
          <div className="panel-eyebrow">Spend · this window</div>
          <div className="text-[32px] font-semibold leading-none tabular-nums" style={{ color: "var(--success)" }}>
            <NumberFlow value={cost} format={{ style: "currency", currency: "USD", minimumFractionDigits: 2 }} />
          </div>
          <div className="text-[11px] t-dim2 mt-1.5 tabular-nums">
            <NumberFlow value={tokens} /> tokens · {(cached / 1000).toFixed(0)}k cached
          </div>
        </div>
        <Spark values={spark} color="var(--success)" />
        <div className="hidden sm:block w-px self-stretch my-1" style={{ background: "color-mix(in srgb, var(--primary) 14%, transparent)" }} />
        <div className="flex items-center gap-2.5 shrink-0">
          <HealthRing value={health} />
          <div className="text-[10px] t-dim2 leading-tight">
            health
            <br />
            <b className="font-semibold" style={{ color: healthColor }}>{healthLabel}</b>
          </div>
        </div>
      </motion.div>

      {/* pulse — the live tempo, grouped */}
      <motion.div {...enter} transition={{ delay: 0.05, type: "spring", stiffness: 300, damping: 26 }} className="panel">
        <div className="grid grid-cols-3 h-full" style={{ background: "color-mix(in srgb, var(--primary) 9%, transparent)", gap: "1px" }}>
          <div style={{ background: CELL_BG }}><PulseCell k="Working" v={working} u="live agents" accent="var(--success)" /></div>
          <div style={{ background: CELL_BG }}><PulseCell k="Events / min" v={epm} u="throughput" accent="var(--info)" /></div>
          <div style={{ background: CELL_BG }}><PulseCell k="Tools run" v={tools} u={`${(t?.events ?? 0).toLocaleString()} events`} /></div>
        </div>
      </motion.div>

      {/* attention — cells glow only on problems; uptime lives inside the panel footer */}
      <motion.div {...enter} transition={{ delay: 0.1, type: "spring", stiffness: 300, damping: 26 }} className="panel">
        <div className="grid grid-cols-2 flex-1" style={{ background: "color-mix(in srgb, var(--primary) 9%, transparent)", gap: "1px" }}>
          <StatusCell k="Failed" v={failed} color="var(--error)" />
          <StatusCell k="Waiting" v={waiting} color="var(--warning)" />
        </div>
        <div
          className="px-4 py-2 text-[10px] t-dim2 text-right tabular-nums"
          style={{ borderTop: "1px solid color-mix(in srgb, var(--primary) 10%, transparent)" }}
        >
          uptime <b className="font-semibold" style={{ color: "var(--text3)" }}>{fmtClock(elapsed)}</b> · {agents.length} sessions tracked
        </div>
      </motion.div>
    </div>
  );
}
