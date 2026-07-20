import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { AgentCard, AgentOutcome } from "../lib/derive.ts";
import { Panel } from "./Panel.tsx";
import { fmtUsd, fmtTokens, fmtAgo, modelLabelOf } from "../lib/format.ts";

// "now ago" reads wrong — fmtAgo already returns "now" for the freshest events.
const ago = (ts: number) => {
  const s = fmtAgo(ts);
  return s === "now" ? "now" : `${s} ago`;
};

const STATUS: Record<string, { color: string; label: string }> = {
  working: { color: "var(--success)", label: "working" },
  waiting: { color: "var(--warning)", label: "waiting" },
  errored: { color: "var(--error)", label: "errored" },
  idle: { color: "var(--text4)", label: "idle" },
};
// `waiting` above `errored`: an agent stopped on a question needs a person, and
// a person is the only thing that will move it. One that hit an error may well
// have recovered on its own by the time you look.
const RANK: Record<string, number> = { working: 0, waiting: 1, errored: 2, idle: 3 };
// Within the idle pile, surface what still wants something from you.
const OUTCOME_RANK: Record<AgentOutcome, number> = { unanswered: 0, faulted: 1, unclear: 2, settled: 3 };
/**
 * The outcome mark: a small glyph beside the metrics, never the status rail.
 *
 * The rail carries liveness. Painting a finished-clean card bright green there
 * would put it in direct competition with a card that is actually working, and
 * make the wall harder to scan rather than easier — so the two axes stay
 * visually separate.
 *
 * Distinct glyphs rather than three coloured dots, so the meaning survives
 * without colour.
 */
const OUTCOME: Record<AgentOutcome, { glyph: string; color: string; title: string } | null> = {
  settled: { glyph: "✓", color: "var(--success)", title: "finished with nothing left trailing" },
  faulted: { glyph: "✕", color: "var(--error)", title: "ended on an error, or stopped mid-tool" },
  unanswered: { glyph: "◷", color: "var(--warning)", title: "stopped on a question nobody answered" },
  // Nothing. No terminal event ever arrived, and the absence of a mark is the
  // accurate report — inventing a glyph here would be a guess wearing a badge.
  unclear: null,
};
// Compress the noisy subagent type names for the card chip.
const shortType = (t: string) =>
  t.replace(/^workflow-subagent$/, "workflow").replace(/^general-purpose$/, "general");

function Spark({ data, color }: { data: number[]; color: string }) {
  const max = Math.max(1, ...data);
  return (
    <div className="flex items-end gap-[1.5px] h-6">
      {data.map((v, i) => (
        <motion.div
          key={i}
          className="w-[3px] rounded-sm origin-bottom"
          initial={false}
          animate={{ height: `${Math.max(6, (v / max) * 100)}%` }}
          transition={{ type: "spring", stiffness: 260, damping: 22 }}
          style={{ background: v ? color : "color-mix(in srgb, var(--border) 50%, transparent)" }}
        />
      ))}
    </div>
  );
}

function SessionCard({ a, selected, onSelect }: { a: AgentCard; selected: boolean; onSelect?: (a: AgentCard) => void }) {
  const st = STATUS[a.status];
  const model = modelLabelOf(a.model_name);
  return (
    <motion.div
      onClick={() => onSelect?.(a)}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      // Tint + inset ring on hover instead of scale — scaling grew the card
      // past the scroll container and got clipped at the edges.
      whileHover={{
        backgroundColor: "color-mix(in srgb, var(--primary) 12%, transparent)",
        boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--primary) 45%, transparent)",
      }}
      transition={{ type: "spring", stiffness: 320, damping: 26 }}
      className="relative rounded-xl p-2.5 pl-4 cursor-pointer"
      style={{
        background: selected ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "color-mix(in srgb, var(--bg3) 40%, transparent)",
        border: `1px solid color-mix(in srgb, var(--primary) ${selected ? 55 : 10}%, transparent)`,
        boxShadow: selected ? "inset 0 0 0 1px color-mix(in srgb, var(--primary) 45%, transparent)" : "none",
      }}
    >
      {/* status rail — inset with rounded ends so the rounded corners never clip it */}
      <span className="absolute left-[3px] top-2.5 bottom-2.5 w-[3px] rounded-full" style={{ background: st.color, boxShadow: `0 0 6px ${st.color}` }} />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            {a.status === "working" && (
              <span className="absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: st.color, animation: "ping-ring 1.6s ease-out infinite" }} />
            )}
            <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: st.color }} />
          </span>
          {/* The uuid is the identity, not the label — five agents on one repo
              render as five near-identical hex strings otherwise. Keep it in the
              tooltip, since it's what you paste into a resume command. */}
          {/* Truncated on screen, whole in the tooltip — with the uuid under it,
              since that's what you paste into a resume. */}
          <span className="truncate text-[13px]" style={{ color: "var(--text)" }}
            title={a.title ? `${a.title}\n${a.key}` : a.key}>{a.title ?? a.key}</span>
          {/* Cards are grouped by project, so several agents on `orbit` sit side
              by side; this is the only thing that says which branch each one is
              actually working. */}
          {a.worktree && (
            <span className="chip shrink-0" title={`Working in the ${a.worktree} worktree`}
              style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}>
              ⑂ {a.worktree}
            </span>
          )}
        </div>
        {/* How it ended, once it has. Only for idle cards: a session still
            working hasn't got an outcome, and claiming one would be inventing
            information. */}
        {a.status === "idle" && OUTCOME[a.outcome] && (
          <span className="shrink-0 text-[11px] leading-none" aria-label={OUTCOME[a.outcome]!.title}
            title={OUTCOME[a.outcome]!.title}
            style={{ color: OUTCOME[a.outcome]!.color, opacity: a.outcome === "settled" ? 0.6 : 0.95 }}>
            {OUTCOME[a.outcome]!.glyph}
          </span>
        )}
        <span className="chip shrink-0" style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}>{model}</span>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-[11px] t-dim2 truncate">{a.lastAction || st.label}</span>
        <Spark data={a.spark} color={st.color} />
      </div>
      {/* subagents this session spawned — the real parent→child structure */}
      {a.subagents > 0 && (() => {
        const named = a.subagentTypes.filter(([t]) => t !== "subagent");
        return (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10px]" style={{ color: "var(--info)" }}>
            <span aria-hidden>⑃</span>
            <span className="tabular-nums font-medium">{a.subagents} subagent{a.subagents > 1 ? "s" : ""}</span>
            {named.length > 0 && (
              <span className="t-dim2 truncate">
                {named.slice(0, 3).map(([type, n]) => `${shortType(type)}${n > 1 ? ` ×${n}` : ""}`).join(" · ")}
              </span>
            )}
          </div>
        );
      })()}
      <div className="mt-1.5 flex items-center gap-3 text-[10px] t-dim2 tabular-nums">
        <span>{a.tools} tools</span>
        {a.errors > 0 && <span style={{ color: "var(--error)" }}>{a.errors} err</span>}
        <span className="t-dim">{fmtTokens(a.tokens)} tok</span>
        <span style={{ color: "var(--success)" }}>{fmtUsd(a.cost)}</span>
        <span className="ml-auto">{ago(a.lastSeen)}</span>
      </div>
    </motion.div>
  );
}

export function Fleet({ agents, activeApp, onSelect }: { agents: AgentCard[]; activeApp?: string; onSelect?: (a: AgentCard) => void }) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  // Group sessions by project (source_app); order groups by most-recent activity.
  const groups = useMemo(() => {
    const by = new Map<string, AgentCard[]>();
    for (const a of agents) {
      const g = by.get(a.source_app) ?? [];
      g.push(a);
      by.set(a.source_app, g);
    }
    return [...by.entries()]
      .map(([app, list]) => {
        list.sort((x, y) =>
          (RANK[x.status] - RANK[y.status]) ||
          (OUTCOME_RANK[x.outcome] - OUTCOME_RANK[y.outcome]) ||
          y.lastSeen - x.lastSeen);
        const live = list.filter((a) => a.status !== "idle").length;
        const subs = list.reduce((s, a) => s + a.subagents, 0);
        return { app, list, live, subs, lastSeen: Math.max(...list.map((a) => a.lastSeen)) };
      })
      .sort((a, b) => b.live - a.live || b.lastSeen - a.lastSeen);
  }, [agents]);

  // A fully-idle group with several sessions collapses by default to cut clutter.
  const isCollapsed = (app: string, live: number, size: number) => overrides[app] ?? (live === 0 && size > 2);
  const toggle = (app: string, def: boolean) => setOverrides((o) => ({ ...o, [app]: !(o[app] ?? def) }));

  return (
    <Panel
      eyebrow="Sessions"
      title="Every agent session"
      right={
        activeApp ? (
          <span className="chip" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 20%, transparent)", borderColor: "color-mix(in srgb, var(--primary) 55%, transparent)" }}>
            filtering: {activeApp}
          </span>
        ) : (
          <span className="text-[10px] t-dim2">{agents.length} live · {groups.length} projects</span>
        )
      }
    >
      <div className="overflow-auto h-full space-y-2.5 pr-1">
        {agents.length === 0 && <div className="t-dim2 text-[12px] text-center py-8 shimmer rounded-lg">waiting for agents…</div>}
        {groups.map(({ app, list, live, subs }) => {
          const collapsed = isCollapsed(app, live, list.length);
          const def = live === 0 && list.length > 2;
          return (
            <div key={app} className="space-y-2">
              <button
                onClick={() => toggle(app, def)}
                className="w-full flex items-center gap-2 px-1.5 py-1 rounded-md text-left"
                style={{ color: activeApp === app ? "var(--primary-hover)" : "var(--text2)" }}
              >
                <span className="text-[10px] t-dim2 transition-transform" style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}>▾</span>
                <span className="text-[11px] font-semibold tracking-wide uppercase" style={{ letterSpacing: "0.06em" }}>{app}</span>
                {live > 0 && <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--success)", boxShadow: "0 0 6px var(--success)" }} />}
                <span className="ml-auto flex items-center gap-2 text-[9.5px] t-dim2 tabular-nums">
                  {subs > 0 && <span style={{ color: "var(--info)" }}>⑃{subs}</span>}
                  <span>{list.length} session{list.length > 1 ? "s" : ""}</span>
                </span>
              </button>
              <AnimatePresence initial={false}>
                {!collapsed && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="space-y-2 overflow-hidden">
                    {list.map((a) => (
                      <SessionCard key={a.key} a={a} selected={!!activeApp && a.source_app === activeApp} onSelect={onSelect} />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
