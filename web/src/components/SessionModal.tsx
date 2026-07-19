import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { SessionDetail, TimelineEntry } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { ChangesModal } from "./ChangesModal.tsx";
import { api } from "../lib/api.ts";
import { usePoll } from "../lib/usePoll.ts";
import { Markdown } from "../lib/markdown.tsx";
import { fmtUsd, fmtTokens, fmtAgo, fmtTime, modelLabelOf, modelColor } from "../lib/format.ts";

const TOOL_RAMP = ["#a78bfa", "#f472b6", "#34d399", "#60a5fa", "#fbbf24", "#22d3ee", "#a3e635", "#fb923c"];
const shortType = (t: string) => t.replace(/^workflow-subagent$/, "workflow").replace(/^general-purpose$/, "general");

// A tool run in the thread. Deliberately one dense line rather than a bubble:
// a session runs hundreds of these, and giving each the weight of a message
// would bury the conversation it is supposed to sit alongside.
function ToolRow({ e }: { e: TimelineEntry }) {
  const [open, setOpen] = useState(false);
  const target = e.target ?? "";
  // A command can be a whole script; show its first line and let the rest be
  // opened, rather than either truncating it away or pasting 40 lines inline.
  const firstLine = target.split("\n")[0];
  const hasMore = target.length > firstLine.length || firstLine.length > 110;
  const tint = e.is_error ? "var(--error)" : "var(--info)";
  return (
    <div className="flex items-start gap-2 text-[10.5px] leading-relaxed pl-1">
      <span className="shrink-0 tabular-nums t-dim2 pt-px" style={{ minWidth: 52 }}>{fmtTime(e.ts)}</span>
      <span className="shrink-0 px-1.5 rounded font-medium"
        style={{ color: tint, background: `color-mix(in srgb, ${tint} 13%, transparent)` }}>
        {e.is_error ? "✕" : "⚙"} {e.tool}
      </span>
      <span className="min-w-0 flex-1">
        <span
          onClick={hasMore ? () => setOpen((o) => !o) : undefined}
          className={`block break-all ${hasMore ? "cursor-pointer" : ""} ${open ? "whitespace-pre-wrap" : "truncate"}`}
          style={{ color: "var(--text3)", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}
          title={hasMore && !open ? "click to expand" : undefined}>
          {open ? target : firstLine}
        </span>
        {e.note && <span className="block t-dim2 truncate">{e.note}</span>}
      </span>
      {e.duration_ms != null && e.duration_ms >= 1000 && (
        <span className="shrink-0 tabular-nums t-dim2">{(e.duration_ms / 1000).toFixed(1)}s</span>
      )}
    </div>
  );
}

function Stat({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="flex flex-col">
      <span className="panel-eyebrow">{k}</span>
      <span className="text-[18px] font-semibold leading-none tabular-nums mt-1" style={{ color: color ?? "var(--text)" }}>{v}</span>
    </div>
  );
}

export function SessionModal({ sessionId, sourceApp, onClose, onFilter, onResume }: { sessionId: string | null; sourceApp?: string; onClose: () => void; onFilter?: (app: string) => void; onResume?: (s: SessionDetail) => void }) {
  const [d, setD] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffPath, setDiffPath] = useState<string | undefined>(undefined);
  const [showTools, setShowTools] = useState(true);

  useEffect(() => {
    if (!sessionId) { setD(null); setDiffOpen(false); return; }
    setLoading(true);
    api.session(sessionId).then((s) => { setD(s); setLoading(false); }).catch(() => { setD(null); setLoading(false); });
  }, [sessionId]);

  // A session you are reading is very often one that is still working, so this
  // is the last place that should be a snapshot: the conversation, the cost and
  // the file list all keep moving while the modal sits open. Refreshed in place
  // — no `loading` flag, no clearing `d` — so a running session updates under
  // you instead of flickering through an empty state every few seconds.
  usePoll(!!sessionId, () => {
    if (!sessionId) return;
    api.session(sessionId).then((s) => {
      // last_seen advances on every new event, so it is the cheap way to tell a
      // genuinely changed session from an idle poll and skip the re-render.
      setD((prev) => (prev && s && prev.last_seen === s.last_seen && prev.events === s.events ? prev : s));
    }).catch(() => { /* keep showing what we have */ });
  }, 3000);

  const open = !!sessionId;
  const key = d ? `${d.source_app}:${d.session_id.slice(0, 8)}` : sourceApp ? `${sourceApp}:${sessionId?.slice(0, 8)}` : sessionId?.slice(0, 8) ?? "";
  const dur = d ? Math.max(0, d.last_seen - d.started_at) : 0;
  const durLabel = dur > 3_600_000 ? `${(dur / 3_600_000).toFixed(1)}h` : dur > 60_000 ? `${Math.round(dur / 60_000)}m` : `${Math.round(dur / 1000)}s`;
  const toolMax = Math.max(1, ...(d?.tool_mix.map((t) => t.n) ?? [1]));
  // Still owned by a running claude: no end recorded and it spoke recently.
  // Erring towards "live" is the safe side — refusing to resume a dead session
  // is an annoyance, resuming a live one forks its transcript.
  const live = !!d && !d.ended_at && Date.now() - d.last_seen < 120_000;

  // Oldest-first, so it reads as a story rather than in reverse. Falls back to
  // the plain conversation for a server that predates the timeline field.
  const entries: TimelineEntry[] = d?.timeline?.length
    ? d.timeline
    : (d?.conversation ?? []).map((c) => ({ kind: "message" as const, ts: c.ts, role: c.role, text: c.text }));
  const toolCount = entries.reduce((n, e) => n + (e.kind === "tool" ? 1 : 0), 0);
  const timeline = [...entries].reverse().filter((e) => showTools || e.kind !== "tool");

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 14 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ type: "spring", stiffness: 330, damping: 30 }}
                className="w-[min(1180px,95vw)] h-[min(900px,92vh)] rounded-2xl flex flex-col pointer-events-auto overflow-hidden"
                style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}
              >
                {/* header */}
                <div className="flex items-center gap-3 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <div className="flex items-baseline gap-2.5 min-w-0">
                    <span className="text-[15px] font-semibold truncate" style={{ color: "var(--text)" }}>{key}</span>
                    {d?.model_name && <span className="chip" style={{ color: modelColor(modelLabelOf(d.model_name)), background: `color-mix(in srgb, ${modelColor(modelLabelOf(d.model_name))} 15%, transparent)` }}>{modelLabelOf(d.model_name)}</span>}
                    {d && <span className="text-[10px] t-dim2">{durLabel} · last {fmtAgo(d.last_seen)} ago</span>}
                  </div>
                  <div className="ml-auto flex items-center gap-2 shrink-0">
                    {d && onResume && (
                      live ? (
                        // A claude session has one owner. Resuming one that's
                        // still running would put a second writer on the same
                        // transcript, so say why rather than offer a button
                        // that corrupts the history.
                        <span className="chip t-dim2" title="This session is still running — resume it once it stops, or watch it live below.">
                          ● running
                        </span>
                      ) : d.project_path ? (
                        <button onClick={() => { onResume(d); onClose(); }} className="chip cursor-pointer"
                          title={`Continue this conversation in ${d.project_path} — claude keeps the full context`}
                          style={{ color: "var(--ok, #34d399)", background: "color-mix(in srgb, #34d399 15%, transparent)", borderColor: "color-mix(in srgb, #34d399 45%, transparent)" }}>
                          ↩ resume in chat
                        </button>
                      ) : (
                        <span className="chip t-dim2" title="No directory recorded for this session, so there's nowhere to resume it.">
                          ↩ resume unavailable
                        </span>
                      )
                    )}
                    {d && onFilter && (
                      <button onClick={() => { onFilter(d.source_app); onClose(); }} className="chip cursor-pointer" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", borderColor: "color-mix(in srgb, var(--primary) 45%, transparent)" }}>
                        ⧉ watch in live feed
                      </button>
                    )}
                    <button onClick={onClose} className="text-[18px] leading-none px-2 t-dim2 hover:opacity-70">✕</button>
                  </div>
                </div>

                {loading && <div className="flex-1 grid place-items-center t-dim2 text-[12px]">loading session…</div>}
                {!loading && !d && <div className="flex-1 grid place-items-center t-dim2 text-[12px]">session not found</div>}

                {d && (
                  <div className="flex-1 min-h-0 flex flex-col">
                    {/* summary + stats (fixed header) */}
                    <div className="shrink-0 px-5 py-4 border-b" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
                      <div className="panel-eyebrow mb-1.5">What it did</div>
                      {/* Capped: this is the header above the stats, not the
                          conversation — the full text is in the thread below.
                          Scrolls rather than truncating, so nothing is lost. */}
                      <div className="text-[12.5px] leading-relaxed max-h-[150px] overflow-y-auto agx-scroll" style={{ color: "var(--text2)" }}>
                        {d.summary ? <Markdown text={d.summary} /> : <span className="t-dim2 italic">no assistant summary captured for this session</span>}
                      </div>
                      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mt-4">
                        <Stat k="Events" v={d.events.toLocaleString()} />
                        <Stat k="Tools" v={d.tools.toLocaleString()} />
                        <Stat k="Errors" v={String(d.errors)} color={d.errors ? "var(--error)" : "var(--text3)"} />
                        <Stat k="Subagents" v={String(d.subagents.length)} color="var(--info)" />
                        <Stat k="Tokens" v={fmtTokens(d.input_tokens + d.output_tokens)} />
                        <Stat k="Cost" v={fmtUsd(d.cost_usd)} color="var(--success)" />
                      </div>
                    </div>

                    <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[340px_1fr]">
                      {/* left: tool mix + subagents — scrolls independently */}
                      <div className="agx-scroll min-h-0 overflow-y-auto px-5 py-4 border-b lg:border-b-0 lg:border-r space-y-5" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
                        <div>
                          <div className="panel-eyebrow mb-2">Tools used</div>
                          <div className="space-y-1.5">
                            {d.tool_mix.map((t, i) => (
                              <div key={t.tool} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 items-center">
                                <span className="truncate text-[11px]" style={{ color: "var(--text2)" }}>{t.tool}</span>
                                <span className="text-[10.5px] tabular-nums t-dim">{t.n}</span>
                                <div className="col-span-2 h-1.5 rounded-full overflow-hidden mt-0.5" style={{ background: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
                                  <div className="h-full rounded-full" style={{ width: `${(t.n / toolMax) * 100}%`, background: TOOL_RAMP[i % TOOL_RAMP.length] }} />
                                </div>
                              </div>
                            ))}
                            {d.tool_mix.length === 0 && <div className="t-dim2 text-[11px]">no tool calls</div>}
                          </div>
                        </div>
                        <div>
                          <div className="panel-eyebrow mb-2">Subagents · {d.subagents.length}</div>
                          <div className="flex flex-wrap gap-1.5">
                            {d.subagents.map((s) => (
                              <span key={s.agent_id} className="chip" style={{ color: "var(--info)", background: "color-mix(in srgb, var(--info) 12%, transparent)" }} title={s.agent_id}>
                                {shortType(s.agent_type)} · {s.events}
                              </span>
                            ))}
                            {d.subagents.length === 0 && <div className="t-dim2 text-[11px]">none</div>}
                          </div>
                        </div>
                        <div>
                          <div className="panel-eyebrow mb-2 flex items-center gap-2">
                            <span>Files changed · {d.changes.length}</span>
                            {d.changes.length > 0 && (
                              <button onClick={() => { setDiffPath(undefined); setDiffOpen(true); }} className="ml-auto normal-case tracking-normal text-[10px] px-1.5 py-0.5 rounded transition-colors" style={{ color: "var(--text)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)" }}>view diffs →</button>
                            )}
                          </div>
                          <div className="space-y-1">
                            {d.changes.slice(0, 14).map((c) => (
                              <button key={c.id} onClick={() => { setDiffPath(c.file_path); setDiffOpen(true); }} title={`Open diff · ${c.file_path}`} className="w-full text-left flex items-center gap-2 text-[10.5px] rounded px-1 -mx-1 py-0.5 transition-colors hover:bg-[color-mix(in_srgb,var(--primary)_12%,transparent)]">
                                <span className="truncate" style={{ color: "var(--text3)" }}>{c.file_path.split("/").pop()}</span>
                                <span className="ml-auto shrink-0 tabular-nums">
                                  {c.additions > 0 && <span style={{ color: "var(--success)" }}>+{c.additions} </span>}
                                  {c.deletions > 0 && <span style={{ color: "var(--error)" }}>−{c.deletions}</span>}
                                </span>
                              </button>
                            ))}
                            {d.changes.length === 0 && <div className="t-dim2 text-[11px]">no file changes</div>}
                          </div>
                        </div>
                      </div>

                      {/* right: conversation — scrolls independently */}
                      <div className="agx-scroll min-h-0 overflow-y-auto px-5 py-4">
                        <div className="flex items-center gap-2 mb-2.5">
                          <span className="panel-eyebrow">Conversation</span>
                          {/* Tool runs are most of what a session does, but they
                              are also the bulk of the rows — so they can be
                              hidden when you want to read the thread alone. */}
                          <button onClick={() => setShowTools((s) => !s)}
                            className="ml-auto text-[9.5px] px-1.5 py-0.5 rounded-full"
                            title={showTools ? "Hide tool runs" : "Show tool runs"}
                            style={{
                              color: showTools ? "var(--primary-hover)" : "var(--text3)",
                              background: `color-mix(in srgb, var(--primary) ${showTools ? 15 : 6}%, transparent)`,
                              border: `1px solid color-mix(in srgb, var(--primary) ${showTools ? 40 : 18}%, transparent)`,
                            }}>
                            ⚙ tools {toolCount > 0 && <span className="tabular-nums">{toolCount}</span>}
                          </button>
                        </div>
                        <div className="space-y-2.5">
                          {timeline.length === 0 && <div className="t-dim2 text-[11px]">no prompts or messages captured</div>}
                          {timeline.map((c, i) => c.kind === "tool" ? (
                            <ToolRow key={i} e={c} />
                          ) : (
                            <div key={i} className={`flex ${c.role === "user" ? "justify-end" : "justify-start"}`}>
                              <div
                                className="max-w-[85%] min-w-0 rounded-xl px-3 py-2 text-[11.5px] leading-relaxed break-words"
                                style={
                                  c.role === "user"
                                    ? { background: "color-mix(in srgb, var(--primary) 16%, transparent)", color: "var(--text)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }
                                    : { background: "color-mix(in srgb, var(--bg3) 40%, transparent)", color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }
                                }
                              >
                                <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: c.role === "user" ? "var(--primary-hover)" : "var(--text4)" }}>{c.role} · {fmtTime(c.ts)}</div>
                                <Markdown text={c.text ?? ""} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
      {d && <ChangesModal open={diffOpen} onClose={() => { setDiffOpen(false); onClose(); }} onBack={() => setDiffOpen(false)} backLabel="Conversation" presetChanges={d.changes} presetTitle={key} presetPath={diffPath} />}
    </Portal>
  );
}
