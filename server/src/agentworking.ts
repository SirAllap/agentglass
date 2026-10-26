/**
 * Whether an agent is doing something anywhere, right now.
 *
 * The one fact the desktop shell's "keep the machine awake while an agent
 * works" mode needs, built from what already tracks it: an agent that fired a
 * hook lately, or a named agent whose pane is alive.
 */
import { recentPaneAgents } from "./panewt.ts";
import { FRESH_MS } from "./agentboard.ts";
import { reconcile as namedAlive } from "./agentops.ts";

export interface AgentWorkingDeps {
  /**
   * THE SESSIONS THIS APP DID NOT START, which were most of them.
   *
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
  /* Sessions, not rows: one conversation has a row for every pane (and every
     tmux server) it has fired from. */
  hookedWorking: (now) => new Set(recentPaneAgents({ sinceMs: FRESH_MS, now }).map((r) => r.sessionId)).size,
  namedAlive: () => namedAlive().then((a) => a.length).catch(() => 0),
};

/** What is keeping the machine awake, counted by source. The desktop draws
 *  it beside the power button: "awake" alone does not say whether that is a
 *  an agent in somebody's own terminal — and
 *  which one it is decides whether closing the lid is safe. */
export interface WorkingWhy { hooked: number; named: number }

/** `deps` defaults to the real, process-wide trackers; a test passes its own
 *  so this reads as a pure function instead of a query against whatever every
 *  other test file happens to have left in the shared table. */
export function workingWhy(now = Date.now(), deps: AgentWorkingDeps = LIVE_DEPS): WorkingWhy {
  return {
    hooked: deps.hookedWorking?.(now) ?? 0,
    named: namedNow(now, deps),
  };
}

/* The named agents are a tmux question, asked at most every ten seconds:
   this is polled by the shell every few seconds and must stay synchronous
   for its callers; the count from the last ask is the answer until then.
   The time is checked BEFORE asking: checked after, the ask — a `list-panes`
   and the registry's writes — ran on every poll and only its answer was
   throttled. Kept per set of deps, so a test's own deps never read the live
   answer or each other's. */
const asked = new WeakMap<AgentWorkingDeps, { at: number; count: number }>();
function namedNow(now: number, deps: AgentWorkingDeps): number {
  if (!deps.namedAlive) return 0;
  const last = asked.get(deps);
  if (last && now - last.at <= 10_000) return last.count;
  const named = deps.namedAlive();
  if (typeof named === "number") return named;
  const entry = { at: now, count: last?.count ?? 0 };
  asked.set(deps, entry);
  void named.then((n) => { entry.count = n; }, () => { /* keep the last count */ });
  return entry.count;
}

export const anyWorking = (w: WorkingWhy): boolean => w.hooked + w.named > 0;

export function agentIsWorking(now = Date.now(), deps: AgentWorkingDeps = LIVE_DEPS): boolean {
  return anyWorking(workingWhy(now, deps));
}
