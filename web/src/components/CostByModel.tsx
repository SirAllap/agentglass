import { memo, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { motion } from "motion/react";
import type { StatsSummary } from "../../../shared/types.ts";
import { Panel } from "./Panel.tsx";
import { fmtUsd, fmtTokens, modelColor } from "../lib/format.ts";

type View = "model" | "repo";
type Item = { key: string; label: string; color: string; cost: number; tokens: number };

const repoName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() || p;

export const CostByModel = memo(function CostByModel({ stats }: { stats: StatsSummary | null }) {
  const [view, setView] = useState<View>("model");

  const items: Item[] =
    view === "model"
      ? (stats?.by_model ?? [])
          .filter((m) => m.cost_usd > 0 || m.input_tokens > 0)
          .map((m) => ({ key: m.model_name, label: m.model_name, color: modelColor(m.model_name), cost: m.cost_usd, tokens: m.input_tokens + m.output_tokens }))
      : (stats?.by_repo ?? [])
          .filter((r) => r.cost_usd > 0 || r.input_tokens > 0)
          .map((r) => {
            const label = r.project_path ? repoName(r.project_path) : "no repo";
            return { key: r.project_path ?? "—", label, color: modelColor(label), cost: r.cost_usd, tokens: r.input_tokens + r.output_tokens };
          });

  const total = items.reduce((s, m) => s + m.cost, 0);
  const data = items.map((m) => ({ name: m.key, value: Math.max(m.cost, 0.0001) }));
  // Hovering a slice updates the centre label instead of a floating tooltip —
  // always legible, never overlapping the donut.
  const [hi, setHi] = useState<number | null>(null);
  const active = hi != null ? items[hi] : null;

  const toggle = (
    <div className="flex gap-0.5 text-[10px]">
      {(["model", "repo"] as const).map((v) => (
        <button
          key={v}
          onClick={() => { setView(v); setHi(null); }}
          className="rounded px-1.5 py-0.5 t-dim2"
          style={{ background: view === v ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent", color: view === v ? "var(--text2)" : undefined }}
        >
          by {v}
        </button>
      ))}
    </div>
  );

  return (
    <Panel eyebrow="Cost" title="Where the money goes" right={toggle}>
      <div className="flex gap-4 h-full items-center overflow-hidden">
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
                {(data.length ? items : [{ key: "—", color: "" }]).map((d, i) => (
                  <Cell
                    key={i}
                    fill={data.length ? d.color : "color-mix(in srgb, var(--border) 40%, transparent)"}
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
                <span className="text-[16px] font-semibold tabular-nums" style={{ color: active.color }}>{fmtUsd(active.cost)}</span>
                <span className="text-[10px] t-dim2 truncate max-w-full">{active.label}</span>
              </>
            ) : (
              <>
                <span className="text-[17px] font-semibold tabular-nums" style={{ color: "var(--success)" }}>{fmtUsd(total)}</span>
                <span className="text-[10px] t-dim2">total spend</span>
              </>
            )}
          </div>
        </div>
        <div className="flex-1 min-w-0 space-y-1.5 max-h-full overflow-y-auto pr-1">
          {items.length === 0 && <div className="t-dim2 text-[11px]">no token usage yet</div>}
          {items.map((m, i) => (
            <motion.div
              key={m.key}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.05 }}
              onMouseEnter={() => setHi(i)}
              onMouseLeave={() => setHi(null)}
              className="flex items-center justify-between text-[11px] rounded-md px-1.5 py-0.5 -mx-1.5 cursor-default"
              style={{ background: hi === i ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "transparent" }}
            >
              <span className="flex items-center gap-1.5 t-dim min-w-0">
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: m.color }} />
                <span className="truncate">{m.label}</span>
              </span>
              <span className="flex items-center gap-3 tabular-nums shrink-0">
                <span className="t-dim2">{fmtTokens(m.tokens)} tok</span>
                <span style={{ color: "var(--success)" }}>{fmtUsd(m.cost)}</span>
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </Panel>
  );
});
