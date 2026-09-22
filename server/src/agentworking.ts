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
  /* Sessions, not rows: one conversation has a row for every pane (and every
     tmux server) it has fired from. */
  hookedWorking: (now) => new Set(recentPaneAgents({ sinceMs: FRESH_MS, now }).map((r) => r.sessionId)).size,
  namedAlive: () => namedAlive().then((a) => a.length).catch(() => 0),
};
let namedCount = 0;
let namedAskedAt = 0;

/** What is keeping the machine awake, counted by source. The desktop draws
 *  it beside the power button: "awake" alone does not say whether that is a
 *  chat mid-turn, a clone's run, or an agent in somebody's own terminal — and
 *  which one it is decides whether closing the lid is safe. */
export interface WorkingWhy { chats: number; runs: number; hooked: number; named: number }

/** `deps` defaults to the real, process-wide trackers; a test passes its own
 *  so this reads as a pure function instead of a query against whatever every
 *  other test file happens to have left in the shared table. */
export function workingWhy(now = Date.now(), deps: AgentWorkingDeps = LIVE_DEPS): WorkingWhy {
  const staleAt = now - STALE_MS;
  return {
    chats: deps.activeTurns().length,
    runs: deps.runningRuns().filter((r) => r.startedAt >= staleAt).length,
    hooked: deps.hookedWorking?.(now) ?? 0,
    named: namedNow(now, deps),
  };
}

/* The named agents are a tmux question, asked at most every ten seconds:
   this is polled by the shell every few seconds and must stay synchronous
   for its callers; the count from the last ask is the answer until then. */
function namedNow(now: number, deps: AgentWorkingDeps): number {
  const named = deps.namedAlive?.();
  if (typeof named === "number") return named;
  if (named && now - namedAskedAt > 10_000) {
    namedAskedAt = now;
    void named.then((n) => { namedCount = n; });
  }
  return namedCount;
}

export const anyWorking = (w: WorkingWhy): boolean => w.chats + w.runs + w.hooked + w.named > 0;

export function agentIsWorking(now = Date.now(), deps: AgentWorkingDeps = LIVE_DEPS): boolean {
  return anyWorking(workingWhy(now, deps));
}
