import { memo } from "react";
import { ComposedChart, Area, Line, XAxis, ResponsiveContainer, Tooltip } from "recharts";
import type { StatsSummary } from "../../../shared/types.ts";
import { Panel } from "./Panel.tsx";
import { fmtTime, fmtUsd } from "../lib/format.ts";
import { EDGE } from "./workspace/Chrome.tsx";

export const MissionTimeline = memo(function MissionTimeline({ stats }: { stats: StatsSummary | null }) {
  const data = (stats?.timeline ?? []).map((b) => ({ t: b.t, events: b.events, errors: b.errors, cost: Number(b.cost_usd.toFixed(4)) }));

  return (
    <Panel eyebrow="Mission timeline" title="Activity over time">
      <div className="h-full w-full min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 6, right: 6, left: 6, bottom: 2 }}>
            <defs>
              <linearGradient id="mt" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.4} />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="t" tickFormatter={(t) => fmtTime(t)} minTickGap={70} tick={{ fill: "var(--text4)", fontSize: 10 }} axisLine={false} tickLine={false} />
            <Tooltip
              labelFormatter={(t) => fmtTime(Number(t))}
              formatter={(v: number, n: string) => (n === "cost" ? fmtUsd(v) : v)}
              contentStyle={{ background: "var(--surface-card)", border: EDGE, borderRadius: 8, fontSize: 12, color: "var(--text)" }}
            />
            <Area type="monotone" dataKey="events" stroke="var(--primary)" strokeWidth={1.5} fill="url(#mt)" name="events" isAnimationActive={false} />
            <Line type="monotone" dataKey="errors" stroke="var(--error)" strokeWidth={2} dot={false} name="errors" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
});
