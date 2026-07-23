import { memo } from "react";
import { motion } from "motion/react";
import type { StatsSummary } from "../../../shared/types.ts";
import { Panel } from "./Panel.tsx";
import { fmtMs } from "../lib/format.ts";

export const Latency = memo(function Latency({ stats }: { stats: StatsSummary | null }) {
  const tools = (stats?.tool_latency ?? []).slice(0, 10);
  const max = Math.max(1, ...tools.map((t) => t.p95_ms));

  return (
    <Panel eyebrow="Performance" title="Tool wall-clock duration" right={<span className="text-[10px] t-dim2">p50 · p95</span>}>
      <div className="overflow-auto h-full pr-1">
        <p className="t-dim2 text-[10.5px] leading-snug mb-2">
          End-to-end tool duration from PreToolUse to PostToolUse, not model/API round-trip latency.
        </p>
        {tools.length === 0 && <div className="t-dim2 text-[11px] text-center py-6">No tool calls measured yet</div>}
        <div className="space-y-2">
          {tools.map((t, i) => (
            <motion.div key={t.tool_name} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
              <div className="flex items-center justify-between text-[11px] mb-0.5">
                <span style={{ color: "var(--text2)" }}>
                  {t.tool_name}
                  {t.errors > 0 && <span className="ml-1.5" style={{ color: "var(--error)" }}>{t.errors}✕</span>}
                  <span className="ml-1.5 t-dim2">· {t.calls} calls</span>
                </span>
                <span className="tabular-nums">
                  <span style={{ color: "var(--info)" }}>{fmtMs(t.p50_ms)}</span>
                  <span className="t-dim2"> / </span>
                  <span style={{ color: "var(--warning)" }}>{fmtMs(t.p95_ms)}</span>
                </span>
              </div>
              <div className="h-2 rounded-full relative overflow-hidden" style={{ background: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
                <motion.div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ background: "color-mix(in srgb, var(--info) 55%, transparent)" }}
                  initial={{ width: 0 }}
                  animate={{ width: `${(t.p50_ms / max) * 100}%` }}
                  transition={{ type: "spring", stiffness: 180, damping: 24 }}
                />
                <motion.div
                  className="absolute inset-y-0"
                  style={{ width: 2, background: "var(--warning)" }}
                  initial={{ left: 0 }}
                  animate={{ left: `${(t.p95_ms / max) * 100}%` }}
                  transition={{ type: "spring", stiffness: 180, damping: 24 }}
                />
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </Panel>
  );
});
