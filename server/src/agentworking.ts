/**
 * Whether an agent is doing something anywhere, right now.
 *
 * The one fact the desktop shell's "keep the machine awake while an agent
 * works" mode needs, built from the two things that already track it rather
 * than a third: a pane mid-turn (`activeTurns`, in-memory and cleared the
 * instant its stream ends — no staleness possible) or an understudy run still
 * `running`.
 *
 * A run's `state` can outlive the process that would ever flip it to `done`
 * or `failed` — see `abandonOrphanedRuns` — so it is staled out here rather
 * than trusted forever. Without this a shift killed mid-run keeps the machine
 * awake until somebody notices, which is the failure that gets the feature
 * turned off for good.
 */
import * as Work from "./understudy-work.ts";
import { activeTurns } from "./chat.ts";
import { recentPaneAgents } from "./panewt.ts";
import { FRESH_MS } from "./agentboard.ts";
import { reconcile as namedAlive } from "./agentops.ts";

const STALE_MS = 2 * 60 * 60 * 1000;

export interface AgentWorkingDeps {
  activeTurns: () => string[];
  runningRuns: () => { startedAt: number }[];
  /**
   * THE SESSIONS THIS APP DID NOT START, which were most of them.
   *
   * A pane mid-turn is a chat this app drives; a running run is the clone's.
   * The agents a person runs in their own terminals — the ones the Lantern
   * lists — were invisible here, so the lid closed on them. Their hooks fire
   * on every tool call; a hook in the last ten minutes (the board's own
   * freshness) is an agent at work, by the board's own rule. And a named
   * agent a script seated is alive while its pane is — no hook needed.
   */
  hookedWorking?: (now: number) => number;
  namedAlive?: () => Promise<number> | number;
}

const LIVE_DEPS: AgentWorkingDeps = {
  activeTurns,
  runningRuns: Work.runningRuns,
  hookedWorking: (now) => recentPaneAgents({ sinceMs: FRESH_MS, now }).length,
  namedAlive: () => namedAlive().then((a) => a.length).catch(() => 0),
};
let namedCount = 0;
let namedAskedAt = 0;

/** `deps` defaults to the real, process-wide trackers; a test passes its own
 *  so this reads as a pure function instead of a query against whatever every
 *  other test file happens to have left in the shared table. */
export function agentIsWorking(now = Date.now(), deps: AgentWorkingDeps = LIVE_DEPS): boolean {
  if (deps.activeTurns().length > 0) return true;
  const staleAt = now - STALE_MS;
  if (deps.runningRuns().some((r) => r.startedAt >= staleAt)) return true;
  if ((deps.hookedWorking?.(now) ?? 0) > 0) return true;
  /* The named agents are a tmux question, asked at most every ten seconds:
     this is polled by the shell every few seconds and must stay synchronous
     for its callers; the count from the last ask is the answer until then. */
  const named = deps.namedAlive?.();
  if (typeof named === "number") return named > 0;
  if (named && now - namedAskedAt > 10_000) {
    namedAskedAt = now;
    void named.then((n) => { namedCount = n; });
  }
  return namedCount > 0;
}
