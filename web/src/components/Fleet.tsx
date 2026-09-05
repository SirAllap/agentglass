import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { stuckBecause, type AgentCard, type AgentOutcome } from "../lib/derive.ts";
import { Panel } from "./Panel.tsx";
import { fmtUsd, fmtTokens, fmtEq, eqTitle, fmtAgo, modelLabelOf } from "../lib/format.ts";
import { RunLanes, legDirs } from "./RunLane.tsx";
import { runsOf, subscribeRuns, watchRuns } from "../lib/runStore.ts";

// "now ago" reads wrong — fmtAgo already returns "now" for the freshest events.
const ago = (ts: number) => {
  const s = fmtAgo(ts);
  return s === "now" ? "now" : `${s} ago`;
};

/**
 * How each state looks, and — the part that matters — what SHAPE it is.
 *
 * Colour alone cannot carry this. Green, amber and red are the three hues a
 * red-green colour-blind reader is least able to separate, which is roughly one
 * man in twelve, and even with perfect colour vision a wall of small tinted
 * dots is read by hue only after you have stopped to look. So every state gets
 * a silhouette of its own — a disc, a ring, two bars, a wedge, a cross — plus a
 * rail whose own form says whether work is still moving. Either channel alone
 * is enough to tell two rows apart at a glance.
 */
type StateLook = {
  color: string;
  label: string;
  /** The mark beside the title. Distinct in outline, not only in colour. */
  mark: "disc" | "ring" | "bars" | "wedge" | "cross" | "hollow";
  /** The stripe down the left edge. `solid` reads as continuous work, `broken`
   *  as a run that is still open and no longer moving, `faint` as over. */
  rail: "solid" | "broken" | "faint";
  /** The sentence under the row when there is nothing more specific to say. */
  hint: string;
};

const STATUS: Record<string, StateLook> = {
  working: { color: "var(--success)", label: "Working", mark: "disc", rail: "solid", hint: "Working" },
  waiting: { color: "var(--warning)", label: "Waiting", mark: "ring", rail: "solid", hint: "Waiting on you" },
  stalled: {
    color: "var(--warning)", label: "Stalled", mark: "bars", rail: "broken",
    hint: "Open, and nothing has moved since it started",
  },
  errored: { color: "var(--error)", label: "Errored", mark: "wedge", rail: "solid", hint: "Errored" },
  failed: { color: "var(--error)", label: "Failed", mark: "cross", rail: "faint", hint: "Ended badly" },
  idle: { color: "var(--text4)", label: "Idle", mark: "hollow", rail: "faint", hint: "Idle" },
};
// `waiting` above `errored`: an agent stopped on a question needs a person, and
// a person is the only thing that will move it. One that hit an error may well
// have recovered on its own by the time you look.
//
// `stalled` sits between them for the same reason. It is not urgent the way a
// question is — nothing is being held up on a keystroke — but it is the row you
// most want to find, because it is the one spending money on nothing. `failed`
// sits above `idle` and below everything live: it is over, so it can wait, but
// it is not the same as over and fine.
const RANK: Record<string, number> = { working: 0, waiting: 1, stalled: 2, errored: 3, failed: 4, idle: 5 };

/**
 * The state's silhouette, at a size a glance can actually resolve.
 *
 * Drawn rather than typed as a character: the glyphs that would do this job
 * (■ ▲ ✕ ●) come out at wildly different optical weights in whatever font the
 * row inherits, and one of them lands as an emoji on some systems.
 */
function StateMark({ look, size = 12 }: { look: StateLook; size?: number }) {
  const c = look.color;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className="shrink-0 block">
      {look.mark === "disc" && <circle cx="6" cy="6" r="4" fill={c} />}
      {look.mark === "ring" && <circle cx="6" cy="6" r="3.6" fill="none" stroke={c} strokeWidth="2" />}
      {look.mark === "bars" && (
        <>
          <rect x="2.3" y="2" width="2.4" height="8" rx="0.7" fill={c} />
          <rect x="7.3" y="2" width="2.4" height="8" rx="0.7" fill={c} />
        </>
      )}
      {look.mark === "wedge" && <path d="M6 1.3 11 10.5H1Z" fill={c} />}
      {look.mark === "cross" && (
        <path d="M2.6 2.6 9.4 9.4M9.4 2.6 2.6 9.4" stroke={c} strokeWidth="2" strokeLinecap="round" />
      )}
      {look.mark === "hollow" && <circle cx="6" cy="6" r="3" fill="none" stroke={c} strokeWidth="1.3" />}
    </svg>
  );
}

/** The rail's fill. A broken stripe is the same colour as a solid one and reads
 *  differently from across the room, which is the whole point of having it. */
function railFill(look: StateLook): { background: string; boxShadow: string; opacity: number } {
  if (look.rail === "broken") {
    return {
      background: `repeating-linear-gradient(to bottom, ${look.color} 0 3px, transparent 3px 6px)`,
      boxShadow: "none",
      opacity: 1,
    };
  }
  return {
    background: look.color,
    boxShadow: look.rail === "solid" ? `0 0 6px ${look.color}` : "none",
    opacity: look.rail === "solid" ? 1 : 0.55,
  };
}
/** The states that mean the run is over. Two of them, since `failed` was split
 *  off the grey pile — every "is this still going" test has to ask both. */
const OVER = new Set<string>(["idle", "failed"]);
// Within the idle pile, surface what still wants something from you.
const OUTCOME_RANK: Record<AgentOutcome, number> = { unanswered: 0, faulted: 1, unclear: 2, settled: 3 };

/**
 * What the server last saw this session actually do, for a card whose tool call
 * is still open.
 *
 * A tooltip and nothing more, on purpose. "Running Bash · 8m" cannot tell a
 * long build from a hang, and neither can any threshold on that number — but
 * "the transcript grew 3s ago" and "nothing readable in 8m" are different
 * situations, and this is the cheapest way to find out how well the signal
 * holds before any status depends on it.
 */
function evidenceNote(a: AgentCard): string | undefined {
  if (!a.runningTool || !a.evidenceKind) return undefined;
  if (a.evidenceKind === "none" || !a.evidenceAt) {
    return `${a.runningTool} open ${fmtAgo(a.runningSince)} · no evidence source readable (not the same as nothing happening)`;
  }
  const what = a.evidenceKind === "transcript" ? "transcript last grew" : "the file it named last changed";
  return `${a.runningTool} open ${fmtAgo(a.runningSince)} · ${what} ${fmtAgo(a.evidenceAt)}`;
}
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
  settled: { glyph: "✓", color: "var(--success)", title: "Finished with nothing left trailing" },
  faulted: { glyph: "✕", color: "var(--error)", title: "Ended on an error, or stopped mid-tool" },
  unanswered: { glyph: "◷", color: "var(--warning)", title: "Stopped on a question nobody answered" },
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
      <span className="absolute left-[3px] top-2.5 bottom-2.5 w-[3px] rounded-full" style={railFill(st)} />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* The state, in shape as well as colour. The title carries the same
              thing in words, because a shape has to be learned once and a
              tooltip never does. */}
          <span className="relative flex h-3 w-3 shrink-0 items-center justify-center"
            title={a.status === "stalled" ? `Stalled — ${stuckBecause(a)}` : st.hint}>
            {a.status === "working" && (
              <span className="absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: st.color, animation: "ping-ring 1.6s ease-out infinite" }} />
            )}
            <span className="relative inline-flex"><StateMark look={st} /></span>
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
            information — and a failed one already says so on the status mark,
            so repeating the ✕ here would be the same fact twice in one row. */}
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
        <span className="text-[11px] t-dim2 truncate" title={evidenceNote(a)}>{a.lastAction || st.hint}</span>
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
        <span className="t-dim" title={eqTitle(a.tokens)}>{fmtEq(a.tokens)}</span>
        <span style={{ color: "var(--success)" }}>{fmtUsd(a.cost)}</span>
        <span className="ml-auto">{ago(a.lastSeen)}</span>
      </div>
    </motion.div>
  );
}

export function Fleet({ agents, activeApp, onSelect }: { agents: AgentCard[]; activeApp?: string; onSelect?: (a: AgentCard) => void }) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  /*
   * The runs on this machine, and the sessions they have claimed.
   *
   * Every run rather than this project's: Fleet is the machine-wide wall — its
   * own heading is "Every agent session" — and asking `/runs` for one root
   * would need a root this component is never given. The route takes an empty
   * root to mean all of them.
   *
   * The store is a module and not a hook, for the reason it says so itself: no
   * suite in this project has a DOM. So it is subscribed to the way the PR
   * board subscribes to its own stores, with one bump.
   */
  const [, bumpRuns] = useState(0);
  useEffect(() => subscribeRuns(() => bumpRuns((n) => n + 1)), []);
  useEffect(() => watchRuns(""), []);
  // The store's `error` is read and not shown, deliberately. A read that fails
  // after one has succeeded keeps the lanes on screen with stale numbers, which
  // is right; a read that fails FIRST is indistinguishable from having no runs,
  // and the likeliest cause of it is a server too old to have the route — which
  // would put "could not read the runs" on the dashboard of somebody who has
  // never started one, forever.
  const runs = runsOf("").runs;
  const claimed = useMemo(() => legDirs(runs), [runs]);

  // Group sessions by project (source_app); order groups by most-recent activity.
  const groups = useMemo(() => {
    const by = new Map<string, AgentCard[]>();
    for (const a of agents) {
      // A session that is a leg of a run is drawn in that run's lane instead.
      // The same card in both places would be one agent that looks like two,
      // moving in step, and a person counting the wall would count it twice.
      if (a.cwd && claimed.has(a.cwd)) continue;
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
        // "Live" means the run is still going. `failed` is not idle and is not
        // live either: counting it here would put a green dot on a project
        // whose every session died, and keep the group expanded forever.
        const live = list.filter((a) => !OVER.has(a.status)).length;
        const subs = list.reduce((s, a) => s + a.subagents, 0);
        return { app, list, live, subs, lastSeen: Math.max(...list.map((a) => a.lastSeen)) };
      })
      .sort((a, b) => b.live - a.live || b.lastSeen - a.lastSeen);
  }, [agents, claimed]);

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
            Filtering: {activeApp}
          </span>
        ) : (
          // The run count is here because a lane takes rows OUT of the project
          // groups: without it, three sessions in one run read as "3 live · 0
          // projects", which is true and looks broken.
          <span className="text-[10px] t-dim2">
            {agents.length} live · {groups.length} projects
            {runs.length > 0 && ` · ${runs.length} run${runs.length === 1 ? "" : "s"}`}
          </span>
        )
      }
    >
      <div className="overflow-auto h-full space-y-2.5 pr-1">
        {/* Runs first. A run is the thing somebody came here to watch, and its
            legs are the rows the groups below no longer hold. */}
        <RunLanes
          runs={runs}
          cards={agents}
          renderCard={(a) => (
            <SessionCard key={a.key} a={a} selected={!!activeApp && a.source_app === activeApp} onSelect={onSelect} />
          )}
        />
        {/* An adopted leg can have no session card at all — that is the normal
            state of a vendor whose events this machine does not collect — so a
            lane on screen is enough for this panel not to be empty. */}
        {agents.length === 0 && runs.length === 0 && <div className="t-dim2 text-[12px] text-center py-8 shimmer rounded-lg">Waiting for agents…</div>}
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
