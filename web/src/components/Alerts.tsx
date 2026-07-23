import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { Alert, AgentCard } from "../lib/derive.ts";
import { collectAttention } from "../lib/attention.ts";
import { listChats, subscribe as subscribeChats } from "../lib/chatStore.ts";
import { listGates, subscribeGates, forgetGate } from "../lib/gateStore.ts";
import type { Insight, PendingGate, GateRecord } from "../../../shared/types.ts";
import { Panel } from "./Panel.tsx";
import { api } from "../lib/api.ts";
import { fmtAgo } from "../lib/format.ts";

const LEVEL: Record<Alert["level"], { color: string; icon: string }> = {
  error: { color: "var(--error)", icon: "✕" },
  warn: { color: "var(--warning)", icon: "⏳" },
  info: { color: "var(--info)", icon: "ℹ" },
};
const SEV: Record<Insight["severity"], string> = { bad: "var(--error)", warn: "var(--warning)", info: "var(--info)" };
const KIND_ICON: Record<Insight["kind"], string> = { loop: "↻", spend: "🔥", errors: "✕", burn: "⚡" };

export function Alerts({ alerts, agents = [], onSelectApp, bump }: { alerts: Alert[]; agents?: AgentCard[]; onSelectApp?: (app: string) => void; bump?: number }) {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [acting, setActing] = useState<Record<string, boolean>>({});

  /*
   * Read, not polled.
   *
   * The watching moved to gateStore, which keeps going while this panel is
   * unmounted. A hold that arrives while you are in the workspace is what the
   * notch is for, and it cannot be raised by a poll that only runs on the
   * dashboard.
   */
  const gates = useSyncExternalStore(subscribeGates, listGates, listGates);

  useEffect(() => {
    let alive = true;
    const load = () => api.insights().then((r) => alive && setInsights(r.insights)).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, [bump]);

  /*
   * The gates you didn't decide.
   *
   * A request resolved by the timeout — or by a restart that found its window
   * already closed — used to leave no trace at all: the card simply left the
   * panel, indistinguishable from one you approved. For the feature whose whole
   * purpose is human oversight, an outcome nobody chose is the single most
   * important one to say out loud, so the recent ones stay visible here.
   */
  const [autoResolved, setAutoResolved] = useState<GateRecord[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .gateHistory(25)
        .then((r) => {
          if (!alive) return;
          const cutoff = Date.now() - 30 * 60_000;
          setAutoResolved(r.gates.filter((g) => g.resolution !== "human" && (g.decided_at ?? 0) > cutoff).slice(0, 3));
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const decide = (g: PendingGate, decision: "allow" | "deny") => {
    setActing((a) => ({ ...a, [g.id]: true }));
    forgetGate(g.id); // optimistic
    api.gateDecide(g.id, decision).catch(() => {});
  };

  /*
   * One list, one count.
   *
   * This used to add up its own three sources, which meant the panel titled
   * "What needs you" could say "2 open" while the header's chat badge said 3 —
   * both right about their own corner, and neither about the whole. Now both
   * read the same selector, so they cannot disagree, and a chat blocked on a
   * refused tool finally shows up in the panel named for exactly that.
   */
  const chats = useSyncExternalStore(subscribeChats, listChats, listChats);
  const attention = useMemo(
    () => collectAttention({ gates, insights, alerts, chats, agents }),
    [gates, insights, alerts, chats, agents],
  );
  const openCount = attention.length;
  const empty = openCount === 0 && insights.length === 0 && autoResolved.length === 0;

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
                <span className="ml-auto text-[9.5px] t-dim2">{g.source_app}:{g.session_id.slice(0, 8)}</span>
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

        {autoResolved.length > 0 && (
          <div className="mb-2">
            {autoResolved.map((g) => (
              <div
                key={g.id}
                className="flex items-start gap-2 rounded-xl px-2.5 py-1.5 mb-1.5"
                style={{ background: "color-mix(in srgb, var(--text4) 10%, transparent)", border: "1px dashed color-mix(in srgb, var(--text4) 45%, transparent)" }}
                title={g.summary}
              >
                <span className="shrink-0 t-dim2">{g.decision === "deny" ? "✕" : "✓"}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px]" style={{ color: "var(--text2)" }}>
                    {g.tool_name} {g.decision === "deny" ? "denied" : "allowed"} without you
                  </div>
                  <div className="text-[9.5px] t-dim2 truncate">
                    {g.resolution === "restart" ? "window closed while the server was down" : "no decision before the timeout"} · {g.source_app}
                  </div>
                </div>
                <span className="text-[9.5px] t-dim2 shrink-0">{fmtAgo(g.decided_at ?? g.created)}</span>
              </div>
            ))}
          </div>
        )}

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
