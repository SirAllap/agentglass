import { motion, AnimatePresence } from "motion/react";
import type { StatsSummary } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { fmtUsd, fmtTokens, typeColor } from "../lib/format.ts";

const WINDOW_LABELS: [number, string][] = [
  [15 * 60_000, "last 15m"],
  [3_600_000, "last 1h"],
  [6 * 3_600_000, "last 6h"],
  [24 * 3_600_000, "last 24h"],
  [7 * 86_400_000, "last 7d"],
  [30 * 86_400_000, "last 30d"],
  [3650 * 86_400_000, "all time"],
];
const windowLabel = (ms: number) =>
  WINDOW_LABELS.find(([w]) => w === ms)?.[1] ?? `last ${Math.round(ms / 3_600_000)}h`;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** When the fleet works — a day×hour activity heatmap (GitHub-style). */
function Heatmap({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <div className="w-full">
      <div className="grid gap-[4px] w-full" style={{ gridTemplateColumns: "30px repeat(24, minmax(0,1fr))" }}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-[8px] t-dim2 text-center tabular-nums">{h % 3 === 0 ? h : ""}</span>
        ))}
        {DAYS.map((day, d) => (
          <div key={d} className="contents">
            <span className="text-[9px] t-dim2 self-center pr-1 text-right">{day}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const n = data[d * 24 + h] ?? 0;
              const intensity = n === 0 ? 0 : 0.18 + (n / max) * 0.82;
              return (
                <div
                  key={`${d}-${h}`}
                  title={`${day} ${h}:00 — ${n} events`}
                  className="rounded-[3px]"
                  style={{ aspectRatio: "1", background: n ? `color-mix(in srgb, var(--primary) ${Math.round(intensity * 100)}%, transparent)` : "color-mix(in srgb, var(--border) 16%, transparent)" }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A ranked magnitude list: single-hue bars, values in text tokens, optional
 *  identity dot per row (identity never rides on the bar colour). */
function BarList({
  rows,
  empty,
}: {
  rows: { label: string; value: number; right?: string; dot?: string }[];
  empty: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <div className="t-dim2 text-[11px] py-3">{empty}</div>;
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 items-center" title={r.label}>
          <div className="flex items-center gap-1.5 min-w-0">
            {r.dot && <span className="h-2 w-2 rounded-full shrink-0" style={{ background: r.dot }} />}
            <span className="truncate text-[11px]" style={{ color: "var(--text2)" }}>{r.label}</span>
          </div>
          <span className="text-[11px] tabular-nums text-right t-dim">{r.right ?? r.value.toLocaleString()}</span>
          <div className="col-span-2 h-1.5 rounded-full overflow-hidden mt-0.5" style={{ background: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
            <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: "var(--primary)" }} />
          </div>
        </div>
      ))}
    </div>
  );
}


// Gentle per-widget drift so each glass panel feels alive, not gridded.
// Kept small so adjacent cards never drift close enough to touch.
const TILT = [-0.45, 0.4, -0.35, 0.45, -0.4, 0.35, -0.3];
const FLOAT_Y = [5, 6, 4, 6, 5, 6, 4];

/** A living glass widget. Three layers so nothing fights:
 *   1. entrance spring (framer, runs once)
 *   2. CSS keyframe float — compositor-only, never restarts on re-render
 *   3. hover lift (framer, a spring in BOTH directions → no snap-back)
 *  No per-widget backdrop-filter: the single overlay frosts the app once, so
 *  animating these translucent cards stays cheap. `full` spans all columns.
 */
function Widget({ title, i, full = false, children }: { title: string; i: number; full?: boolean; children: React.ReactNode }) {
  const rot = full ? 0 : TILT[i % TILT.length];
  const fy = full ? 3 : FLOAT_Y[i % FLOAT_Y.length];
  const floatVars = {
    "--tilt": `${rot}deg`,
    "--fy": `${fy}px`,
    "--dur": `${7 + (i % 4) * 1.3}s`,
    "--delay": `${(i % 5) * 0.7}s`,
  } as React.CSSProperties;
  return (
    <motion.div
      initial={{ opacity: 0, y: 18, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: Math.min(0.045 * i, 0.25), type: "spring", stiffness: 260, damping: 24 }}
      className="min-w-0"
    >
      <div className="agw-float" style={floatVars}>
        <motion.div
          whileHover={{ y: -7, scale: 1.02 }}
          transition={{ type: "spring", stiffness: 220, damping: 26, mass: 0.6 }}
          className="rounded-[20px] p-5 cursor-default"
          style={{
            background: "linear-gradient(135deg, rgba(255,255,255,.08), rgba(255,255,255,.015) 46%, transparent), color-mix(in srgb, var(--bg3) 80%, transparent)",
            border: "1px solid color-mix(in srgb, white 11%, transparent)",
            boxShadow: "0 24px 56px -30px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.08)",
          }}
        >
          <div className="panel-eyebrow mb-3">{title}</div>
          {children}
        </motion.div>
      </div>
    </motion.div>
  );
}

export function StatsModal({ open, onClose, stats, windowMs }: { open: boolean; onClose: () => void; stats: StatsSummary | null; windowMs: number }) {
  const skills = stats?.top_skills ?? [];
  const tools = [...(stats?.tool_latency ?? [])].sort((a, b) => b.calls - a.calls).slice(0, 10);
  const apps = (stats?.by_app ?? []).slice(0, 10);
  const types = (stats?.by_type ?? []).slice(0, 10);

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            {/* frost the whole dashboard — no modal box, just floating glass */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(6,3,14,0.64)", backdropFilter: "blur(14px) saturate(1.05)", WebkitBackdropFilter: "blur(14px) saturate(1.05)" }} onClick={onClose} />

            {/* the widgets float directly over the frosted app — no container.
                One coordinated fade/scale so closing is smooth, not chunky. */}
            <motion.div
              initial={{ opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.99 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="fixed inset-0 overflow-y-auto" style={{ zIndex: 10001 }} onClick={onClose}>
              <div className="min-h-full flex flex-col items-center px-4 py-6">
                <div className="w-[min(1040px,96vw)]" onClick={(e) => e.stopPropagation()}>
                  {/* floating header — text over the frost, not a panel */}
                  <motion.div
                    initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
                    className="flex items-center justify-between mb-4 px-1"
                  >
                    <div className="flex items-baseline gap-2.5">
                      <span className="text-[17px] font-semibold" style={{ color: "var(--text)" }}>Statistics</span>
                      <span className="chip" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 18%, transparent)", borderColor: "color-mix(in srgb, var(--primary) 45%, transparent)" }}>{windowLabel(windowMs)}</span>
                    </div>
                    <button onClick={onClose} className="h-8 w-8 grid place-items-center rounded-full text-[15px] t-dim2 hover:opacity-80" style={{ background: "color-mix(in srgb, white 8%, transparent)", backdropFilter: "blur(10px)", border: "1px solid color-mix(in srgb, white 12%, transparent)" }}>✕</button>
                  </motion.div>

                <div className="flex flex-col gap-6">
                {stats?.heatmap && stats.heatmap.some((n) => n > 0) && (
                  <Widget title="when the fleet works · day × hour" i={0} full>
                    <Heatmap data={stats.heatmap} />
                  </Widget>
                )}

                {/* Two independent flex columns = real masonry, but WITHOUT the
                    CSS multi-column overflow bug: a card taller than the balanced
                    column height used to spill out of its column box and collide
                    with the full-width block below. Flex columns reserve their
                    full height, so nothing can overlap. */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
                  <div className="flex flex-col gap-6 min-w-0">
                    <Widget title="most used skills — with attributed cost" i={1}>
                      <BarList
                        rows={skills.map((s) => ({
                          label: s.skill,
                          value: s.calls,
                          right: s.cost_usd > 0 ? `${s.calls}× · ${fmtUsd(s.cost_usd)}` : `${s.calls}×`,
                        }))}
                        empty="No skill runs in this window"
                      />
                    </Widget>

                    <Widget title="skill runs over time" i={4}>
                      {skills.length === 0 ? (
                        <div className="t-dim2 text-[11px] py-3">No skill runs in this window</div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {skills.slice(0, 6).map((s) => {
                            const max = Math.max(1, ...s.buckets);
                            return (
                              <div key={s.skill} className="grid grid-cols-[minmax(0,160px)_1fr_auto] gap-x-3 items-center">
                                <span className="truncate text-[11px]" style={{ color: "var(--text2)" }} title={s.skill}>{s.skill}</span>
                                <div className="flex gap-[3px]">
                                  {s.buckets.map((n, i) => (
                                    <div
                                      key={i}
                                      title={n ? `${n} run${n > 1 ? "s" : ""}` : ""}
                                      className="h-4 flex-1 rounded-[3px]"
                                      style={{
                                        // Sequential single hue: intensity carries magnitude.
                                        background: n
                                          ? `color-mix(in srgb, var(--primary) ${15 + (n / max) * 70}%, transparent)`
                                          : "color-mix(in srgb, var(--border) 18%, transparent)",
                                      }}
                                    />
                                  ))}
                                </div>
                                <span className="text-[10px] tabular-nums t-dim2">{s.calls}×</span>
                              </div>
                            );
                          })}
                          <div className="grid grid-cols-[minmax(0,160px)_1fr_auto] gap-x-3 mt-0.5">
                            <span />
                            <div className="flex justify-between text-[9px] t-dim2"><span>{windowLabel(windowMs).replace("last ", "-")}</span><span>now</span></div>
                            <span />
                          </div>
                        </div>
                      )}
                    </Widget>
                  </div>

                  <div className="flex flex-col gap-6 min-w-0">
                    <Widget title="most used tools" i={2}>
                      <BarList
                        rows={tools.map((t) => ({
                          label: t.tool_name,
                          value: t.calls,
                          right: `${t.calls}× · p50 ${t.p50_ms >= 1000 ? (t.p50_ms / 1000).toFixed(1) + "s" : Math.round(t.p50_ms) + "ms"}`,
                        }))}
                        empty="No tool calls in this window"
                      />
                    </Widget>

                    <Widget title="event mix" i={3}>
                      <BarList
                        rows={types.map((t) => ({ label: t.hook_event_type, value: t.count, dot: typeColor(t.hook_event_type) }))}
                        empty="No events in this window"
                      />
                    </Widget>
                  </div>
                </div>

                {/* full-width — a sibling below the columns, always clears them */}
                <Widget title="apps by spend" i={5} full>
                  {apps.length === 0 ? (
                    <div className="t-dim2 text-[11px] py-3">No activity in this window</div>
                  ) : (
                    <div className="flex flex-col">
                      <div className="grid grid-cols-[minmax(0,1fr)_repeat(3,auto)] gap-x-4 text-[9px] uppercase tracking-wider t-dim2 pb-1">
                        <span>app</span><span className="text-right">sessions</span><span className="text-right">tokens</span><span className="text-right">cost</span>
                      </div>
                      {apps.map((a) => (
                        <div key={a.source_app} className="grid grid-cols-[minmax(0,1fr)_repeat(3,auto)] gap-x-4 items-baseline py-1 border-t" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
                          <span className="truncate text-[11px]" style={{ color: "var(--text2)" }} title={a.source_app}>{a.source_app}</span>
                          <span className="text-[11px] tabular-nums text-right t-dim">{a.sessions}</span>
                          <span className="text-[11px] tabular-nums text-right t-dim">{fmtTokens(a.tokens)}</span>
                          <span className="text-[11px] tabular-nums text-right" style={{ color: "var(--success)" }}>{fmtUsd(a.cost_usd)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Widget>
                </div>{/* stack (gap-6 between heatmap, columns, apps) */}
                </div>{/* content w-1040 */}
              </div>{/* padding wrapper */}
            </motion.div>{/* scroll container */}
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
