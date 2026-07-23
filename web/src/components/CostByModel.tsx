import { memo, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { motion } from "motion/react";
import type { StatsSummary } from "../../../shared/types.ts";
import { Panel } from "./Panel.tsx";
import { fmtUsd, fmtTokens, modelColor } from "../lib/format.ts";

export const CostByModel = memo(function CostByModel({ stats }: { stats: StatsSummary | null }) {
  const models = (stats?.by_model ?? []).filter((m) => m.cost_usd > 0 || m.input_tokens > 0);
  const total = models.reduce((s, m) => s + m.cost_usd, 0);
  const data = models.map((m) => ({ name: m.model_name, value: Math.max(m.cost_usd, 0.0001) }));
  // Hovering a slice updates the centre label instead of a floating tooltip —
  // always legible, never overlapping the donut.
  const [hi, setHi] = useState<number | null>(null);
  const active = hi != null ? models[hi] : null;

  return (
    <Panel eyebrow="Cost" title="Where the money goes" right={<span className="text-[10px] t-dim2">By model</span>}>
      <div className="flex gap-4 h-full items-center">
        <div className="relative h-36 w-36 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data.length ? data : [{ name: "—", value: 1 }]}
                dataKey="value"
                innerRadius={44}
                outerRadius={66}
                paddingAngle={2}
                stroke="none"
                animationDuration={600}
                onMouseEnter={(_, i) => setHi(i)}
                onMouseLeave={() => setHi(null)}
              >
                {(data.length ? data : [{ name: "—" }]).map((d, i) => (
                  <Cell
                    key={i}
                    fill={data.length ? modelColor(d.name) : "color-mix(in srgb, var(--border) 40%, transparent)"}
                    fillOpacity={hi == null || hi === i ? 1 : 0.35}
                    style={{ transition: "fill-opacity .2s", cursor: "pointer" }}
                  />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center px-3">
            {active ? (
              <>
                <span className="text-[16px] font-semibold tabular-nums" style={{ color: modelColor(active.model_name) }}>{fmtUsd(active.cost_usd)}</span>
                <span className="text-[10px] t-dim2 truncate max-w-full">{active.model_name}</span>
              </>
            ) : (
              <>
                <span className="text-[17px] font-semibold tabular-nums" style={{ color: "var(--success)" }}>{fmtUsd(total)}</span>
                <span className="text-[10px] t-dim2">Total spend</span>
              </>
            )}
          </div>
        </div>
        <div className="flex-1 min-w-0 space-y-1.5">
          {models.length === 0 && <div className="t-dim2 text-[11px]">No token usage yet</div>}
          {models.map((m, i) => (
            <motion.div
              key={m.model_name}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.05 }}
              onMouseEnter={() => setHi(i)}
              onMouseLeave={() => setHi(null)}
              className="flex items-center justify-between text-[11px] rounded-md px-1.5 py-0.5 -mx-1.5 cursor-default"
              style={{ background: hi === i ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "transparent" }}
            >
              <span className="flex items-center gap-1.5 t-dim">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: modelColor(m.model_name) }} />
                {m.model_name}
              </span>
              <span className="flex items-center gap-3 tabular-nums">
                <span className="t-dim2">{fmtTokens(m.input_tokens + m.output_tokens)} tok</span>
                <span style={{ color: "var(--success)" }}>{fmtUsd(m.cost_usd)}</span>
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </Panel>
  );
});
