/*
 * What is running on the computer, and what each agent is doing about it.
 *
 * The list Home is built from. It is not the queue: the queue is "what wants
 * you", and this is "what is going on" — an agent working perfectly well and
 * needing nothing belongs here and must never appear there. The two screens
 * share their boundaries rather than each picking its own, which is why the two
 * constants below are imported from nowQueue instead of being typed again.
 *
 * Data, not JSX. What "still running" means is worth a test; what it looks like
 * is not.
 */
import type { PendingGate, SessionRollup } from "../../../shared/types.ts";
import { QUIET_MS, STALE_MS } from "./nowQueue.ts";

/**
 * How recently a session has to have spoken to count as live.
 *
 * Two minutes, and it came here from `chatList.ts`, which was deleted with the
 * conversation screen. It is not a new number and it is not a copy: it was that
 * module's own `LIVE_MS`, and this file was the only caller of the rule it
 * backed once the chat list was gone. The alternative was keeping a module for
 * one constant that one function reads.
 */
const LIVE_MS = 120_000;

/**
 * What an agent is up to, in the order of how much it wants a person.
 *
 * The four states are the three boundaries this app already had, named:
 *
 *   blocked — a gate is held on this session. The hook's request is open and
 *             nothing proceeds until somebody answers, which is the only state
 *             here where the agent is stopped BY us.
 *   working — it has spoken inside the live window, so something is happening.
 *   thinking — quiet, but not for long enough to mean anything. A turn takes
 *             time and an agent mid-thought is not a problem.
 *   stopped — quiet past the point where thinking explains it. This is the one
 *             that also produces a card in the queue.
 *
 * There is no "finished": a session with an `ended_at` is not running, and this
 * list is about what is.
 */
export type Doing = "blocked" | "working" | "thinking" | "stopped";

export interface RunningAgent {
  session: SessionRollup;
  doing: Doing;
  /** The gate holding it, when one is. Carried so a row can say WHAT is being
   *  asked rather than only that something is. */
  gate?: PendingGate;
  /** How long since it last said anything, in ms. */
  quiet: number;
}

const RANK: Record<Doing, number> = { blocked: 0, stopped: 1, working: 2, thinking: 3 };

/**
 * Everything that has not ended and has spoken inside the last twelve hours,
 * loudest first.
 *
 * Twelve hours is `STALE_MS`, the queue's own cutoff, and it is doing the same
 * job here: a session whose process died without writing `ended_at` looks
 * exactly like one that is idle, and after half a day the second reading stops
 * being credible. Without the cutoff this screen becomes an archive — which is
 * the Chats tab, and it already exists.
 *
 * `stopped` sorts above `working` on purpose. The order is how much each row
 * wants a person, not how alive it is: an agent that has been waiting six
 * minutes for direction is the reason to have picked the phone up, and one that
 * is happily working is the reason to put it down.
 */
export function runningAgents(
  sessions: readonly SessionRollup[],
  gates: readonly PendingGate[],
  now: number,
): RunningAgent[] {
  // One lookup rather than a scan per session: a machine with four agents has
  // four gates, but the sessions list is a hundred rows long.
  const held = new Map<string, PendingGate>();
  for (const gate of gates) {
    const seen = held.get(gate.session_id);
    // The oldest one, when an agent has stacked up more than one: it is the
    // one that has been blocking the longest and the one the age should read.
    if (!seen || gate.created < seen.created) held.set(gate.session_id, gate);
  }

  // The app's one definition of "live". Anything outside it is quiet, and how
  // quiet is what the states below turn on.
  const live = new Set(
    sessions.filter((s) => !s.ended_at && now - s.last_seen < LIVE_MS).map((s) => s.session_id),
  );

  const out: RunningAgent[] = [];
  for (const session of sessions) {
    if (session.ended_at) continue;
    const quiet = Math.max(0, now - session.last_seen);
    if (quiet > STALE_MS) continue;
    const gate = held.get(session.session_id);
    const doing: Doing = gate
      ? "blocked"
      : live.has(session.session_id)
        ? "working"
        : quiet >= QUIET_MS ? "stopped" : "thinking";
    out.push({ session, doing, gate, quiet });
  }

  return out.sort((a, b) => RANK[a.doing] - RANK[b.doing] || b.session.last_seen - a.session.last_seen);
}

/** How many are stopped or blocked — the number Home's heading says out loud.
 *  Not the queue's count: the queue also holds red builds and dead containers,
 *  which are not agents. */
export function needingSomebody(agents: readonly RunningAgent[]): number {
  return agents.filter((a) => a.doing === "blocked" || a.doing === "stopped").length;
}
