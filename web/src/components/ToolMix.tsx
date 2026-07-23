import { motion } from "motion/react";
import type { WatchEvent } from "../../../shared/types.ts";
import { Panel } from "./Panel.tsx";

// A curated categorical palette — distinct, high-separation hues so each
// chunk is easy to tell apart at a glance (identity, not magnitude), assigned
// by rank. Overflow tools collapse into a single muted "Other" segment.
const RAMP = [
  "#a78bfa", // violet
  "#f472b6", // pink
  "#34d399", // green
  "#60a5fa", // blue
  "#fbbf24", // amber
  "#22d3ee", // cyan
  "#a3e635", // lime
  "#fb923c", // orange
];
const OTHER = "color-mix(in srgb, var(--text4) 55%, transparent)";
const TOP = 6;

/** "What the fleet is doing" — share of tool calls, top-N + Other. */
export function ToolMix({ events }: { events: WatchEvent[] }) {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.hook_event_type === "PostToolUse" || e.hook_event_type === "PostToolUseFailure") {
      if (e.tool_name) counts.set(e.tool_name, (counts.get(e.tool_name) ?? 0) + 1);
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  const seg = sorted.slice(0, TOP).map(([name, n], i) => ({
    name,
    n,
    pct: total ? (n / total) * 100 : 0,
    color: RAMP[i],
  }));
  const restN = sorted.slice(TOP).reduce((a, [, n]) => a + n, 0);
  if (restN > 0) seg.push({ name: "Other", n: restN, pct: total ? (restN / total) * 100 : 0, color: OTHER });

  return (
    <Panel eyebrow="Tool mix" title="What the fleet is doing" right={<span className="text-[10px] t-dim2">{total} runs</span>}>
      <div className="flex flex-col justify-center h-full gap-3">
        <div className="flex h-4 rounded-full overflow-hidden gap-[2px]" style={{ background: "color-mix(in srgb, var(--border) 22%, transparent)" }}>
          {seg.map((m) => (
            <motion.div
              key={m.name}
              initial={{ width: 0 }}
              animate={{ width: `${m.pct}%` }}
              transition={{ type: "spring", stiffness: 200, damping: 26 }}
              style={{ background: m.color }}
              title={`${m.name} ${m.pct.toFixed(0)}%`}
            />
          ))}
          {seg.length === 0 && <div className="w-full shimmer" />}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {seg.map((m) => (
            <span key={m.name} className="flex items-center gap-1.5 text-[11px] t-dim">
              <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: m.color }} />
              <span className="truncate max-w-[160px]">{m.name}</span>
              <span className="t-dim2 tabular-nums">{m.pct.toFixed(0)}%</span>
            </span>
          ))}
          {seg.length === 0 && <span className="text-[11px] t-dim2">Waiting for tool calls…</span>}
        </div>
      </div>
    </Panel>
  );
}
