import { memo, useEffect, useState } from "react";
import { motion } from "motion/react";
import type { SessionRollup } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { Panel } from "./Panel.tsx";
import { fmtUsd, fmtMs, fmtTokens, modelColor, modelLabelOf } from "../lib/format.ts";

export const Sessions = memo(function Sessions({ provider = "" }: { provider?: string }) {
  const [sessions, setSessions] = useState<SessionRollup[]>([]);
  useEffect(() => {
    const load = () => api.sessions(40, provider || undefined).then(setSessions).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [provider]);

  const now = Date.now();
  const min = sessions.length ? Math.min(...sessions.map((s) => s.started_at)) : now;
  const max = Math.max(now, ...sessions.map((s) => s.ended_at ?? s.last_seen));
  const span = Math.max(1, max - min);

  return (
    <Panel eyebrow="Timeline" title="Sessions over time" right={<span className="text-[10px] t-dim2">{sessions.length} sessions</span>}>
      <div className="overflow-auto h-full space-y-1.5 pr-1">
        {sessions.length === 0 && <div className="t-dim2 text-[11px] text-center py-6">No sessions yet</div>}
        {sessions.map((s, i) => {
          const start = ((s.started_at - min) / span) * 100;
          const end = (((s.ended_at ?? s.last_seen) - min) / span) * 100;
          const width = Math.max(2, end - start);
          const live = s.ended_at == null;
          const dur = (s.ended_at ?? s.last_seen) - s.started_at;
          const model = modelLabelOf(s.model_name);
          return (
            <div key={s.session_id} className="flex items-center gap-2 text-[11px]">
              <div className="w-24 shrink-0 truncate t-dim2" title={s.session_id}>
                {s.source_app}:{s.session_id.slice(0, 5)}
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
