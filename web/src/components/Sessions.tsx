import { memo, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import type { SessionRollup } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { Panel } from "./Panel.tsx";
import { Select } from "./Select.tsx";
import { fmtUsd, fmtMs, fmtTokens, modelColor, modelLabelOf, agentLabel } from "../lib/format.ts";

type Sort = "recent" | "cost-desc" | "cost-asc";
const SORT_OPTIONS = [
  { value: "recent", label: "Recent" },
  { value: "cost-desc", label: "Cost ↓" },
  { value: "cost-asc", label: "Cost ↑" },
];

export const Sessions = memo(function Sessions({ provider = "" }: { provider?: string }) {
  const [sessions, setSessions] = useState<SessionRollup[]>([]);
  const [sort, setSort] = useState<Sort>("recent");
  useEffect(() => {
    const load = () => api.sessions(40, provider || undefined).then(setSessions).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [provider]);

  // `recent` keeps the server order (last_seen DESC). Cost sorts reorder rows
  // vertically only — the bar positions below stay keyed off timestamps.
  const ordered = useMemo(() => {
    if (sort === "recent") return sessions;
    const dir = sort === "cost-desc" ? -1 : 1;
    return [...sessions].sort((a, b) => (a.cost_usd - b.cost_usd) * dir);
  }, [sessions, sort]);

  const now = Date.now();
  const min = sessions.length ? Math.min(...sessions.map((s) => s.started_at)) : now;
  const max = Math.max(now, ...sessions.map((s) => s.ended_at ?? s.last_seen));
  const span = Math.max(1, max - min);

  const right = (
    <div className="flex items-center gap-2">
      <span className="text-[10px] t-dim2">{sessions.length} sessions</span>
      <Select value={sort} options={SORT_OPTIONS} onChange={(v) => setSort(v as Sort)} align="right" title="Sort sessions" />
    </div>
  );

  return (
    <Panel eyebrow="Timeline" title="Sessions over time" right={right}>
      <div className="overflow-auto h-full space-y-1.5 pr-1">
        {sessions.length === 0 && <div className="t-dim2 text-[11px] text-center py-6">no sessions yet</div>}
        {ordered.map((s, i) => {
          const start = ((s.started_at - min) / span) * 100;
          const end = (((s.ended_at ?? s.last_seen) - min) / span) * 100;
          const width = Math.max(2, end - start);
          const live = s.ended_at == null;
          const dur = (s.ended_at ?? s.last_seen) - s.started_at;
          const model = modelLabelOf(s.model_name);
          return (
            <div key={s.session_id} className="flex items-center gap-2 text-[11px]">
              <div className="w-24 shrink-0 truncate t-dim2" title={s.session_id}>
                {agentLabel(s)}
              </div>
              <div className="flex-1 relative h-5 rounded" style={{ background: "color-mix(in srgb, var(--border) 22%, transparent)" }}>
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${width}%` }}
                  transition={{ type: "spring", stiffness: 160, damping: 24, delay: i * 0.02 }}
                  className="absolute inset-y-0 rounded flex items-center px-1.5 overflow-hidden"
                  style={{ left: `${start}%`, background: `color-mix(in srgb, ${modelColor(model)} 38%, transparent)`, borderLeft: `2px solid ${modelColor(model)}` }}
                  title={`${model} · ${fmtMs(dur)} · ${s.event_count} events`}
                >
                  {live && <span className="h-1.5 w-1.5 rounded-full mr-1" style={{ background: "var(--success)", animation: "ping-ring 1.6s ease-out infinite" }} />}
                  <span className="truncate" style={{ color: "var(--text2)" }}>{fmtTokens(s.input_tokens + s.output_tokens)} tok</span>
                </motion.div>
              </div>
              <div className="w-14 shrink-0 text-right tabular-nums" style={{ color: "var(--success)" }}>{fmtUsd(s.cost_usd)}</div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
});
