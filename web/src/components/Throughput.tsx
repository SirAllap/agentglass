import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { motion } from "motion/react";
import type { WatchEvent } from "../../../shared/types.ts";
import { Panel } from "./Panel.tsx";
import { rollingRate } from "../lib/motion.ts";

/** "How busy the fleet is" — a live flowing area of events/sec over the last 60s. */
export function Throughput({ events }: { events: WatchEvent[] }) {
  const rate = rollingRate(
    events.map((e) => e.timestamp),
    60,
    1000
  );
  const data = rate.map((v, i) => ({ i, v }));
  const perSec = rate.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const peak = Math.max(...rate, 1);
  const avg = rate.reduce((a, b) => a + b, 0) / rate.length;

  return (
    <Panel
      eyebrow="Throughput"
      title="How busy the fleet is"
      right={
        <div className="text-right leading-tight">
          <div className="text-[22px] font-semibold tabular-nums" style={{ color: "var(--primary-ink)" }}>
            {perSec.toFixed(2)}
          </div>
          <div className="text-[10px] t-dim2">events / sec · peak {peak}/s</div>
        </div>
      }
    >
      <div className="h-full w-full min-h-[120px] relative">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="tp" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.55} />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis hide domain={[0, "dataMax + 1"]} />
            <Area
              type="monotone"
              dataKey="v"
              stroke="var(--primary)"
              strokeWidth={2}
              fill="url(#tp)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
        <motion.div
          className="absolute left-0 right-0 border-t border-dashed"
          style={{ borderColor: "color-mix(in srgb, var(--text4) 50%, transparent)", bottom: `${(avg / (peak + 1)) * 100}%` }}
          initial={false}
        />
        <span className="absolute bottom-0 left-0 text-[10px] t-dim2">dashed = avg {avg.toFixed(2)}/s · last 60s</span>
      </div>
    </Panel>
  );
}
