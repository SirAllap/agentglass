// The fleet, beside the work instead of instead of it.
//
// The dashboard's session list is the one panel anybody actually looked at, and
// looking at it meant leaving whatever you were doing. So it moved: 190px that
// are always there, in every view, answering the only question you ask all day
// — who is running, and what are they doing right now.
//
// "Right now" is the part the dashboard never gave you. A card there said
// "1286 tools · $75.81", which is a summary; this says `Bash · pytest 42/58`,
// which is a sentence about this second. It comes free — the running tool is
// already derived for the fleet cards, it had just never been the headline.
//
// Hovering widens it rather than opening a panel: the answer to "what did it
// just say?" should cost a mouse move, not a click and a click back.
import { useState } from "react";
import type { AgentCard } from "../../lib/derive.ts";
import { fmtUsd } from "../../lib/format.ts";

/** Collapsed. Wide enough for a name and a verb, and no wider — every pixel
 *  here is taken from the thing you actually came to look at. */
export const SPINE_W = 190;
/** On hover. Enough for the last line the agent produced, which is the whole
 *  reason to look. */
export const SPINE_W_WIDE = 330;

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

const TINT: Record<string, string> = {
  working: "var(--success)",
  waiting: "var(--warning)",
  errored: "var(--error)",
  idle: "var(--text4)",
};

/** What this agent is doing, in one line, preferring the most immediate fact
 *  available. A running tool beats the last completed action, which beats the
 *  event type — "nothing has happened yet" is the only case with no answer. */
function doing(a: AgentCard): string {
  if (a.runningTool) return a.lastAction ? `${a.runningTool} · ${a.lastAction}` : a.runningTool;
  if (a.lastAction) return a.lastAction;
  return a.lastType || "";
}

export function FleetSpine({ agents, activeSession, onSelect, onOpenDash }: {
  agents: AgentCard[];
  /** The session the views are scoped to, if any — so the spine and the work
   *  agree about who you are looking at. */
  activeSession?: string | null;
  onSelect: (a: AgentCard) => void;
  /** The whole dashboard is one click away from here, which is what makes
   *  putting it in the rail rather than in your face defensible. */
  onOpenDash: () => void;
}) {
  const [wide, setWide] = useState(false);
  const live = agents.filter((a) => a.status !== "idle");
  const needs = agents.filter((a) => a.status === "waiting" || a.status === "errored");
  const spend = agents.reduce((n, a) => n + a.cost, 0);

  return (
    <aside
      onMouseEnter={() => setWide(true)}
      onMouseLeave={() => setWide(false)}
      className="shrink-0 flex flex-col min-h-0 relative"
      style={{
        width: wide ? SPINE_W_WIDE : SPINE_W,
        transition: "width .16s ease",
        background: "color-mix(in srgb, var(--text) 3%, transparent)",
        borderRight: edge(11),
        // Over the view rather than pushing it: a column that shoves the diff
        // sideways every time the mouse passes is a column you learn to avoid.
        zIndex: 6,
        boxShadow: wide ? "14px 0 30px -18px var(--shadow)" : undefined,
      }}
    >
      <div className="flex items-center gap-2 px-2.5 shrink-0" style={{ height: 28, borderBottom: edge(11) }}>
        <span className="text-[9px] uppercase tracking-widest" style={{ color: "var(--text3)" }}>Fleet</span>
        <span className="ml-auto text-[9.5px] tabular-nums" style={{ color: needs.length ? "var(--warning)" : "var(--text3)" }}>
          {needs.length ? `${needs.length} needs you` : `${live.length} live`}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto agx-scroll">
        {agents.length === 0 && (
          <div className="px-2.5 py-3 text-[10px]" style={{ color: "var(--text4)" }}>Nothing running.</div>
        )}
        {agents.map((a) => {
          const on = activeSession === a.session_id;
          const wants = a.status === "waiting" || a.status === "errored";
          const tint = TINT[a.status] ?? "var(--text4)";
          return (
            <button key={a.key} onClick={() => onSelect(a)}
              className="w-full text-left px-2.5 py-1.5 hover:bg-white/5"
              title={`${a.title ?? a.session_id}\n${a.source_app}`}
              style={{
                borderBottom: edge(6),
                background: wants ? "color-mix(in srgb, var(--warning) 11%, transparent)"
                  : on ? "color-mix(in srgb, var(--primary) 12%, transparent)" : undefined,
                boxShadow: wants ? "inset 2px 0 0 0 var(--warning)" : on ? "inset 2px 0 0 0 var(--primary)" : undefined,
              }}>
              <div className="flex items-center gap-1.5">
                <span className="rounded-full shrink-0" style={{ width: 6, height: 6, background: tint }} />
                <span className="flex-1 min-w-0 truncate text-[10.5px]" style={{ color: a.status === "idle" ? "var(--text3)" : "var(--text)" }}>
                  {a.title || a.source_app}
                </span>
                {/* The pulse. Ten buckets of recent events — it is the one thing
                    that tells a thinking agent from a hung one at a glance. */}
                {a.status !== "idle" && <Spark values={a.spark} tint={tint} />}
              </div>
              {a.status !== "idle" && (
                <div className="truncate text-[9px] mt-[1px]" style={{ color: wants ? "var(--warning)" : "var(--text3)" }}>
                  {wants ? "waiting for you" : doing(a)}
                </div>
              )}
              {/* Only when there is room for it. Cost and tool count are the
                  summary the dashboard gives; here they are the second answer,
                  after "what is it doing". */}
              {wide && a.status !== "idle" && (
                <div className="flex items-center gap-2 mt-1 text-[9px]" style={{ color: "var(--text4)" }}>
                  <span className="tabular-nums">{a.tools} tools</span>
                  {a.subagents > 0 && <span className="tabular-nums">{a.subagents} sub</span>}
                  <span className="ml-auto tabular-nums" style={{ color: "var(--success)" }}>{fmtUsd(a.cost)}</span>
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div className="shrink-0 px-2.5 py-1.5" style={{ borderTop: edge(11) }}>
        <button onClick={onOpenDash} className="w-full flex items-center gap-2 text-[9.5px] rounded px-1 py-0.5 hover:bg-white/5"
          title="The whole dashboard — every panel, unchanged">
          <span style={{ color: "var(--text3)" }}>today</span>
          <span className="ml-auto tabular-nums" style={{ color: "var(--success)" }}>{fmtUsd(spend)}</span>
          <span style={{ color: "var(--primary)" }}>→</span>
        </button>
      </div>
    </aside>
  );
}

/** Ten bars, scaled to their own maximum. Against a fixed ceiling an agent
 *  ticking along at two events a bucket is a flat line, and flat is what a
 *  stuck one looks like. */
function Spark({ values, tint }: { values: number[]; tint: string }) {
  const max = Math.max(1, ...values);
  const bars = values.slice(-7);
  return (
    <span className="flex items-end gap-[1.5px] shrink-0" style={{ height: 9 }} aria-hidden>
      {bars.map((v, i) => (
        <span key={i} className="block rounded-[1px]"
          style={{ width: 2, height: `${Math.max(12, (v / max) * 100)}%`, background: `color-mix(in srgb, ${tint} 65%, transparent)` }} />
      ))}
    </span>
  );
}
