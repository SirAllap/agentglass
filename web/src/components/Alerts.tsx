import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { Alert } from "../lib/derive.ts";
import type { Insight, PendingGate } from "../../../shared/types.ts";
import { Panel } from "./Panel.tsx";
import { api } from "../lib/api.ts";
import { fmtAgo, agentLabel } from "../lib/format.ts";
import { usePoll } from "../lib/usePoll.ts";

const LEVEL: Record<Alert["level"], { color: string; icon: string }> = {
  error: { color: "var(--error)", icon: "✕" },
  warn: { color: "var(--warning)", icon: "⏳" },
  info: { color: "var(--info)", icon: "ℹ" },
};
const SEV: Record<Insight["severity"], string> = { bad: "var(--error)", warn: "var(--warning)", info: "var(--info)" };
const KIND_ICON: Record<Insight["kind"], string> = { loop: "↻", spend: "🔥", errors: "✕", burn: "⚡" };

export function Alerts({ alerts, onSelectApp, bump }: { alerts: Alert[]; onSelectApp?: (app: string) => void; bump?: number }) {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [gates, setGates] = useState<PendingGate[]>([]);
  const [acting, setActing] = useState<Record<string, boolean>>({});

  usePoll(true, () => api.insights().then((r) => setInsights(r.insights)).catch(() => {}), 15_000, true, String(bump ?? ""));

  // Pending gate requests are the most urgent thing — poll fast.
  usePoll(true, () => api.gatePending().then((r) => setGates(r.gates)).catch(() => {}), 2000, true);

  const decide = (g: PendingGate, decision: "allow" | "deny") => {
    setActing((a) => ({ ...a, [g.id]: true }));
    setGates((gs) => gs.filter((x) => x.id !== g.id)); // optimistic
    api.gateDecide(g.id, decision).catch(() => {});
  };

  const openCount = gates.length + alerts.length + insights.filter((i) => i.severity !== "info").length;
  const empty = gates.length === 0 && alerts.length === 0 && insights.length === 0;

  return (
    <Panel
      eyebrow="Alerts"
      title="What needs you"
      right={<span className="text-[10px] font-semibold" style={{ color: openCount ? "var(--error)" : "var(--text4)" }}>{openCount} open</span>}
    >
      <div className="h-full overflow-auto pr-0.5">
        {empty && (
          <div className="flex flex-col items-center justify-center h-full gap-2 py-4">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full rounded-full opacity-70" style={{ background: "var(--success)", animation: "ping-ring 1.8s ease-out infinite" }} />
              <span className="relative inline-flex rounded-full h-3 w-3" style={{ background: "var(--success)" }} />
            </span>
            <div className="text-[13px]" style={{ color: "var(--text2)" }}>All systems nominal</div>
            <div className="text-[10px] t-dim2">no agent needs you right now</div>
          </div>
        )}

        {/* control plane — pending tool calls awaiting your decision */}
        <AnimatePresence initial={false}>
          {gates.map((g) => (
            <motion.div
              key={g.id}
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 380, damping: 26 }}
              className="rounded-xl px-2.5 py-2 mb-2"
              style={{ background: "color-mix(in srgb, var(--warning) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 50%, transparent)" }}
            >
              <div className="flex items-center gap-2">
                <span style={{ color: "var(--warning)" }}>✋</span>
                <span className="text-[11.5px] font-semibold" style={{ color: "var(--text)" }}>Approve {g.tool_name}?</span>
                <span className="ml-auto text-[9.5px] t-dim2">{agentLabel(g)}</span>
              </div>
              <div className="text-[10.5px] t-dim mt-1 mb-2 break-all line-clamp-2" title={g.summary} style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {g.summary || "(no details)"}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => decide(g, "allow")}
                  disabled={acting[g.id]}
                  className="flex-1 rounded-lg py-1.5 text-[11px] font-semibold cursor-pointer"
                  style={{ color: "var(--bg2)", background: "var(--success)" }}
                >
                  ✓ Approve
                </button>
                <button
                  onClick={() => decide(g, "deny")}
                  disabled={acting[g.id]}
                  className="flex-1 rounded-lg py-1.5 text-[11px] font-semibold cursor-pointer"
                  style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 45%, transparent)" }}
                >
                  ✕ Deny
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {alerts.map((a) => {
            const l = LEVEL[a.level];
            return (
              <motion.div
                key={a.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                transition={{ type: "spring", stiffness: 350, damping: 28 }}
                onClick={() => onSelectApp?.(a.agent.split(":")[0])}
                className="flex items-start gap-2 rounded-xl px-2.5 py-2 mb-1.5 cursor-pointer"
                style={{ background: `color-mix(in srgb, ${l.color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${l.color} 35%, transparent)` }}
              >
                <span style={{ color: l.color }}>{l.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px]" style={{ color: "var(--text2)" }}>{a.agent}</div>
                  <div className="text-[10px] t-dim2">{a.text}</div>
                </div>
                <span className="text-[10px] t-dim2 shrink-0">{fmtAgo(a.ts)}</span>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {insights.length > 0 && (
          <>
            {alerts.length > 0 && <div className="text-[9px] uppercase tracking-[0.18em] t-dim2 px-1 pt-1 pb-1.5">Insights</div>}
            <AnimatePresence initial={false}>
              {insights.map((i) => {
                const color = SEV[i.severity];
                return (
                  <motion.div
                    key={i.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ type: "spring", stiffness: 350, damping: 28 }}
                    onClick={() => i.session && onSelectApp?.(i.session.split(":")[0])}
                    className="flex items-start gap-2 rounded-xl px-2.5 py-2 mb-1.5"
                    style={{
                      background: `color-mix(in srgb, ${color} 10%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
                      cursor: i.session ? "pointer" : "default",
                    }}
                  >
                    <span className="shrink-0" style={{ color }}>{KIND_ICON[i.kind]}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11.5px] font-medium" style={{ color: "var(--text2)" }}>{i.title}</div>
                      <div className="text-[10px] t-dim2 truncate" title={i.detail}>{i.detail}</div>
                      {i.session && <div className="text-[9.5px] mt-0.5" style={{ color: "var(--text4)" }}>{i.session}</div>}
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </>
        )}
      </div>
    </Panel>
  );
}
