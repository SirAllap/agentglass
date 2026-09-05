/*
 * A run, drawn inside the wall of sessions.
 *
 * A run is one prompt asked in several checkouts at once — server/src/runs.ts
 * is where that is decided and where the reasoning lives. Everything the server
 * knows about one has been invisible until now: the routes answer, the client
 * calls them, and nothing put a run on a screen.
 *
 * It goes HERE, in Fleet, rather than behind an eleventh entry in the rail. The
 * rail has ten views and the code that numbers them warns about the eleventh;
 * more to the point, a run is a grouping of sessions, and the panel that draws
 * every session is the place a grouping of them belongs. So the legs are not a
 * second row renderer — Fleet hands its own `SessionCard` in, and a lane moves
 * those rows out of their project group and under a run heading instead. A row
 * that appeared in both places would be one agent looking like two.
 *
 * What the lane exists to show is the ADOPTED leg. Fan-out — cut N worktrees,
 * start N agents — is a race everybody has already run. A pane the USER opened
 * by hand, in a checkout this app never cut, possibly running another vendor's
 * CLI, sitting in the same run as the ones we started, is the thing a tool that
 * spawns its own terminals cannot show at all: it only ever holds handles it
 * was given at spawn time. So the adopted leg is drawn differently on purpose,
 * and differently in FORM — a dotted enclosure and a hollow diamond, not a
 * tinted version of the same row — for the reason Fleet gives its states
 * silhouettes rather than three hues: shape survives a glance, and colour-blind
 * readers get the same information as everybody else.
 */
import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { AgentCard } from "../lib/derive.ts";
import type { LegActivity, ProviderSpend, Run, RunLeg } from "../lib/api.ts";
import { activityOf, refreshActivity, subscribeRuns, watchActivity } from "../lib/runStore.ts";
import { fmtAgo, fmtUsd } from "../lib/format.ts";
import { ICON } from "../lib/iconSize.ts";

/** "unknown" is a real bucket — an event whose model never resolved — and it
 *  reads as a value rather than as a gap when it is spelled with a capital.
 *  The same rule the dashboard's provider filter follows. */
const providerLabel = (p: string) => (p === "unknown" ? "Unknown" : p);

/** "now ago" reads wrong, and `fmtAgo` already answers "now" for the freshest
 *  events. Written out again rather than imported from Fleet.tsx, which has the
 *  same three lines: Fleet imports this file, and an import back the other way
 *  is the circle that has already given this app a black window once. */
const ago = (ts: number) => {
  const s = fmtAgo(ts);
  return s === "now" ? "now" : `${s} ago`;
};

/** The leg's own colour, used only for the origin channel. Deliberately none of
 *  the four the status marks use: a leg's origin is not a state, and borrowing
 *  `--warning` for it would make an adopted leg look like a problem. */
const ADOPTED = "var(--info)";

/**
 * Every directory this machine's runs have a leg in.
 *
 * The join key, and it is a directory rather than a session id because that is
 * the only key an agent we started and an agent we did not could ever share —
 * runs.ts says so at length, and the database agrees with it: `cwd_path` is
 * what `runActivity` groups by.
 */
export function legDirs(runs: Run[]): Set<string> {
  const dirs = new Set<string>();
  for (const r of runs) for (const l of r.legs) dirs.add(l.worktree);
  return dirs;
}

/**
 * The sessions running in one leg's checkout, freshest first.
 *
 * Matched on the directory exactly, which is the same test the server's own
 * `cwd_path IN (…)` makes. A session in a subdirectory of the checkout is not
 * pulled in, and that is not an oversight: the leg's numbers come from that
 * query, so a card counted here that the bill does not count would put a row
 * and a total side by side that disagree.
 */
export function cardsIn(cards: AgentCard[], worktree: string): AgentCard[] {
  return cards.filter((a) => a.cwd === worktree).sort((x, y) => y.lastSeen - x.lastSeen);
}

/**
 * The run's bill, one line per vendor it actually paid.
 *
 * A correction to what this was asked to do: `runSpend` in server/src/runs.ts
 * is the same fold, and it cannot be imported. Nothing under web/src imports
 * from server/ — it is why api.ts mirrors the run types rather than sharing
 * them — and `/run/activity` answers with the per-leg split only, so the roll-up
 * has to happen on this side of the socket wherever it is written. It is
 * written to match that function line for line, sort included: the dearest
 * vendor is the line somebody is looking for, and two implementations that
 * disagreed about the order would be two answers to "which one cost more".
 */
export function laneSpend(legs: LegActivity[]): ProviderSpend[] {
  const total = new Map<string, ProviderSpend>();
  for (const leg of legs) {
    for (const p of leg.providers) {
      const held = total.get(p.provider) ?? { provider: p.provider, events: 0, costUsd: 0 };
      held.events += p.events;
      held.costUsd += p.costUsd;
      total.set(p.provider, held);
    }
  }
  return [...total.values()].sort((a, b) => b.costUsd - a.costUsd || b.events - a.events);
}

/** One leg with everything known about it in one place: what the run says it
 *  is, what the database says it produced, and the session cards Fleet would
 *  otherwise have drawn under its project. */
export type LaneRow = { leg: RunLeg; activity: LegActivity | null; cards: AgentCard[] };

/**
 * The run's legs, in the order the run records them.
 *
 * Not re-sorted by state or by spend. A run is a comparison, and a comparison
 * whose arms swap places whenever one of them gets ahead is one nobody can read
 * twice — the arm you were looking at is somewhere else now. The order legs
 * were started in is stable and means something.
 */
export function laneRows(run: Run, acts: LegActivity[], cards: AgentCard[]): LaneRow[] {
  const by = new Map(acts.map((a) => [a.worktree, a]));
  return run.legs.map((leg) => ({
    leg,
    activity: by.get(leg.worktree) ?? null,
    cards: cardsIn(cards, leg.worktree),
  }));
}

/** Whether anything in this run is still going. `won`, `lost` and `gone` are
 *  all over; only `running` is not. */
export const runIsLive = (run: Run): boolean => run.legs.some((l) => l.state === "running");

/**
 * Where a leg came from, as a silhouette.
 *
 * Drawn rather than typed for the reason `StateMark` is drawn: the characters
 * that would do this (■ ◇) land at different optical weights in whatever font
 * the row inherits, and one of them is an emoji on some machines. A filled
 * square for a leg we cut, a hollow diamond for one we did not — different in
 * outline, different in fill, and neither one is a shape any status already
 * uses, so an origin can never be misread as a state.
 */
export function OriginMark({ origin, size = ICON.sm }: { origin: RunLeg["origin"]; size?: number }) {
  const adopted = origin === "adopted";
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className="shrink-0 block">
      {adopted
        ? <path d="M6 1.6 10.4 6 6 10.4 1.6 6Z" fill="none" stroke={ADOPTED} strokeWidth="1.6" strokeLinejoin="round" />
        : <rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.4" fill="var(--text4)" />}
    </svg>
  );
}

/** What each leg state is called, and whether it is worth saying at all.
 *  `running` gets nothing: it is the ordinary case, and a chip on every row
 *  that says "yes, still" is a chip nobody reads. */
const LEG_STATE: Record<RunLeg["state"], { label: string; color: string; title: string } | null> = {
  running: null,
  won: { label: "won", color: "var(--success)", title: "The leg this run was called for" },
  lost: { label: "lost", color: "var(--text4)", title: "Not the winner — the checkout this app cut for it has been removed" },
  released: {
    label: "released", color: "var(--text3)",
    title: "Handed back. This checkout was never this app's to remove, so the run let go of it and left it exactly as it was",
  },
  gone: {
    label: "gone", color: "var(--warning)",
    title: "The checkout is not on disk any more — somebody removed it by hand. Kept so the run still reads as a run that had this many legs",
  },
};

function LegRow({ row, renderCard }: { row: LaneRow; renderCard: (a: AgentCard) => ReactNode }) {
  const { leg, activity, cards } = row;
  const adopted = leg.origin === "adopted";
  const st = LEG_STATE[leg.state];
  // Zero is the honest reading for a leg that has produced nothing, and it is
  // not the same as a leg we have not asked about yet — hence the sentence
  // below rather than a row of dashes.
  const events = activity?.events ?? 0;
  return (
    <div
      className="relative"
      style={adopted
        ? {
          // The form difference, and it is the whole point of the feature: a
          // dotted enclosure around the one thing in this panel the app does
          // not own. It reads from across the room, it is not a hue, and the
          // sentence that explains it is directly above — see the legend in
          // `RunLane`, which appears exactly when one of these does.
          border: `1px dashed color-mix(in srgb, ${ADOPTED} 50%, transparent)`,
          borderRadius: 12,
          padding: "6px 8px",
          background: `color-mix(in srgb, ${ADOPTED} 5%, transparent)`,
        }
        : { paddingLeft: 10 }}
    >
      {/* The spine, for the legs that hang off this run because we hung them
          there. The adopted one is not attached to it — it was already
          running, in somebody else's checkout, and the drawing says so. */}
      {!adopted && (
        <span className="absolute left-[2px] top-[10px] bottom-1 w-px" aria-hidden
          style={{ background: "color-mix(in srgb, var(--text) 16%, transparent)" }} />
      )}
      <div className="flex items-center gap-1.5 min-w-0">
        <OriginMark origin={leg.origin} />
        {/* The branch, because a run's legs differ by branch and by nothing
            else you can see. Detached checkouts say `(detached)`, which is
            what git says and what an adopted pane is entitled to be. */}
        <span className="truncate text-[11.5px]" style={{ color: "var(--text2)" }} title={leg.worktree}>
          {leg.branch || "(detached)"}
        </span>
        {/* The vendor. The one fact a run exists to compare, so it is on every
            leg — and "unknown" is printed rather than guessed at when nothing
            on this machine could tell. */}
        <span className="chip shrink-0" title={leg.agent ? `Running ${leg.agent}` : "Nothing on this machine could say which agent is in there"}
          style={leg.agent
            ? { color: "var(--text2)", background: "color-mix(in srgb, var(--text) 8%, transparent)" }
            : { color: "var(--text4)" }}>
          {leg.agent || "unknown agent"}
        </span>
        {adopted && (
          <span className="chip shrink-0" style={{ color: ADOPTED, background: `color-mix(in srgb, ${ADOPTED} 14%, transparent)`, borderColor: `color-mix(in srgb, ${ADOPTED} 45%, transparent)` }}>
            adopted
          </span>
        )}
        {st && (
          <span className="chip shrink-0" title={st.title} style={{ color: st.color }}>{st.label}</span>
        )}
        <span className="ml-auto shrink-0 flex items-center gap-2 text-[10px] t-dim2 tabular-nums">
          <span style={{ color: "var(--success)" }}>{fmtUsd(activity?.costUsd ?? 0)}</span>
          <span>{events} events</span>
          {!!activity?.errors && <span style={{ color: "var(--error)" }}>{activity.errors} err</span>}
          {!!activity?.lastSeen && <span title="When this checkout last produced an event">{ago(activity.lastSeen)}</span>}
        </span>
      </div>
      {cards.length > 0
        ? <div className="mt-1.5 space-y-2">{cards.map((a) => renderCard(a))}</div>
        : (
          /* No card at all is the ORDINARY state of an adopted leg, not a
             fault: this app collects what its own hooks and the OTel endpoints
             send it, and a vendor that sends neither leaves a pane that is
             plainly working and has produced no row anywhere. Saying which of
             the two it is beats a blank space that looks like a bug. */
          <div className="mt-1 text-[10.5px] t-dim2">
            {events > 0
              ? "no session on this wall for this checkout — nothing has arrived from it inside the window the dashboard is showing"
              : "nothing recorded here yet — the agent has not finished a turn, or its events are not collected on this machine"}
          </div>
        )}
    </div>
  );
}

/** One run: a heading, its bills, and its legs. */
export function RunLane({ run, cards, renderCard }: {
  run: Run;
  cards: AgentCard[];
  renderCard: (a: AgentCard) => ReactNode;
}) {
  // The store is a module, not a hook, so a lane hears about a new reading the
  // way the PR board hears about its own — one bump, batched with every other
  // listener React notifies in the same tick.
  const [, bump] = useState(0);
  useEffect(() => subscribeRuns(() => bump((n) => n + 1)), []);

  const live = runIsLive(run);
  // A run whose legs are all over collapses: it is a record, not a race.
  const [open, setOpen] = useState(live);
  /*
   * The activity poll runs only while a lane is open AND something in it is
   * still running.
   *
   * Both halves earn their place. Closed, nobody is reading the numbers. Over,
   * the numbers cannot change — every leg is `won`, `lost` or `gone` — so a
   * five-second poll of a finished run would be a clock that never moves and
   * the panel would keep it ticking for as long as the dashboard stays mounted,
   * which is for as long as the app runs.
   */
  useEffect(() => {
    /*
     * Read once whatever the lane's state, because the HEADER carries the
     * total and the header is visible while the lane is shut.
     *
     * Gating the read on `open` is what an earlier version did, and it did not
     * hide the number — it printed the wrong one. With nothing fetched, the
     * bills are empty, the reduce is zero, and a finished run rendered a
     * confident $0.00. A lane that says nothing is a lane you go and open; a
     * lane that says zero is one you believe.
     */
    void refreshActivity(run.id);
    // The clock is the part worth gating. Closed, nobody is reading the
    // numbers; over, they cannot change — every leg is `won`, `lost` or `gone`
    // — so polling a finished run would tick for as long as the app runs.
    if (open && live) return watchActivity(run.id);
  }, [open, live, run.id]);

  const act = activityOf(run.id);
  const acts = act.legs;
  /* Never asked and asked-and-empty are different answers and must not print
     the same. `loading` is the store's "no reply yet" — see activityOf. */
  const totalKnown = !act.loading;
  const rows = laneRows(run, acts, cards);
  const bills = laneSpend(acts);
  const total = bills.reduce((s, p) => s + p.costUsd, 0);
  const adopted = run.legs.filter((l) => l.origin === "adopted").length;
  const sessions = rows.reduce((n, r) => n + r.cards.length, 0);

  return (
    <div className="space-y-1.5 rounded-xl p-1.5"
      style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: "1px solid color-mix(in srgb, var(--text) 8%, transparent)" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-1 py-0.5 rounded-md text-left min-w-0"
        style={{ color: "var(--text2)" }}
      >
        <span className="text-[10px] t-dim2 transition-transform" style={{ transform: open ? "none" : "rotate(-90deg)" }}>▾</span>
        <span className="text-[10px] font-semibold tracking-wide uppercase shrink-0" style={{ letterSpacing: "0.06em", color: "var(--text4)" }}>Run</span>
        {/* The prompt is the run's name. Nothing else identifies it to the
            person who asked it — the id is what you paste into a command, so
            it rides in the tooltip the way a session's uuid does. */}
        <span className="truncate text-[12px]" style={{ color: "var(--text)" }} title={`${run.prompt}\n${run.id}`}>{run.prompt}</span>
        <span className="ml-auto shrink-0 flex items-center gap-2 text-[9.5px] t-dim2 tabular-nums">
          {live && <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--success)", boxShadow: "0 0 6px var(--success)" }} />}
          <span>{run.legs.length} leg{run.legs.length === 1 ? "" : "s"}</span>
          {adopted > 0 && <span style={{ color: ADOPTED }}>{adopted} adopted</span>}
          {sessions > 0 && <span>{sessions} session{sessions === 1 ? "" : "s"}</span>}
          <span style={{ color: totalKnown ? "var(--success)" : "var(--text4)" }} title={totalKnown ? undefined : "waiting for this run's numbers"}>
            {totalKnown ? fmtUsd(total) : "—"}
          </span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="space-y-2 overflow-hidden">
            {/*
             * The two vendors, split. Only when there are two: one line saying
             * Anthropic spent everything is the same fact the total already
             * carries, and a run with one vendor in it is not a vendor
             * comparison. The split comes from the events' own models rather
             * than from what anybody said they were running, which is why it
             * can disagree with the agent chip on a leg — a session that
             * changed model mid-way really did pay two bills.
             */}
            {bills.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 px-1">
                {bills.map((p) => (
                  <span key={p.provider} className="chip tabular-nums" title={`${p.events} events charged to ${providerLabel(p.provider)}`}
                    style={{ color: "var(--text2)" }}>
                    {providerLabel(p.provider)} <span style={{ color: "var(--success)" }}>{fmtUsd(p.costUsd)}</span> · {p.events} ev
                  </span>
                ))}
              </div>
            )}
            {/* The answer to "why is that one dotted", where somebody who just
                asked it is already looking. Only when the lane has one, so it
                is a caption on a thing on screen rather than documentation. */}
            {adopted > 0 && (
              <div className="flex items-start gap-1.5 px-1 text-[10.5px]" style={{ color: "var(--text4)" }}>
                <OriginMark origin="adopted" size={ICON.xs} />
                <span>
                  <b style={{ color: ADOPTED, fontWeight: 600 }}>Adopted</b> — a pane you started yourself, in a checkout this app never
                  cut. Tracked and counted with the rest of the run, and never torn down when it ends.
                </span>
              </div>
            )}
            {rows.map((row) => <LegRow key={row.leg.worktree} row={row} renderCard={renderCard} />)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Every run, above the projects.
 *
 * And NOTHING at all when there are none, which is day one for everybody. The
 * choice was between an empty box with a heading, a sentence explaining what a
 * run is and how to start one, and silence. The middle one is the one worth
 * having and it cannot be written honestly yet: no control in this app starts a
 * run — `/run/start` answers, and the only thing that calls it is a test — so
 * the sentence would have to end "…and there is no way to do that from here",
 * which teaches a person about a feature and then wastes the space forever. The
 * empty box is the worst of the three by everyone's reckoning. So: silence, and
 * when a start control lands, the sentence belongs right here, beside it.
 */
export function RunLanes({ runs, cards, renderCard }: {
  runs: Run[];
  cards: AgentCard[];
  renderCard: (a: AgentCard) => ReactNode;
}) {
  if (!runs.length) return null;
  // Live runs first, then the most recent — the same shape Fleet orders its
  // project groups by, so the two stacks read as one list.
  const ordered = [...runs].sort((a, b) =>
    Number(runIsLive(b)) - Number(runIsLive(a)) || b.startedAt - a.startedAt);
  return (
    <div className="space-y-2">
      {ordered.map((run) => <RunLane key={run.id} run={run} cards={cards} renderCard={renderCard} />)}
    </div>
  );
}
