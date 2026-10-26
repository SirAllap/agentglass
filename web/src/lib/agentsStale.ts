/*
 * WHEN A CLAIM STOPS BEING A CLAIM, and what the Agents screen does with the
 * old material.
 *
 * Measured on the screen this replaces: three blockers 42 days old were still
 * in "Waiting on you". Nothing read an age anywhere: the tray shows the eight
 * newest reports, and on a quiet project the eight newest are the old ones.
 * A week is the one stale constant the server already keeps for tmux memory
 * (tmuxmemory.ts STALE_AFTER_MS); the same week is used here so the two never
 * disagree about what "old" means.
 *
 * Everything here is arithmetic on stamps, so the screen only draws it.
 */
export const STALE_AFTER_MS = 7 * 86_400_000;

/** Whether a claim made at `at` is past its week. A stamp in the future, or one
 *  that is not a number, is not stale: a skewed clock must not hide a blocker. */
export const isStale = (at: number, now = Date.now()): boolean =>
  Number.isFinite(at) && now - at >= STALE_AFTER_MS;

export interface StaleLine {
  /** How many claims are folded. */
  count: number;
  /** The oldest of them, whole days — "oldest 42 d". */
  oldestDays: number;
  /** Their owners are all gone from the field: "agents gone". */
  agentsGone: boolean;
  /** Report ids to dismiss; needs are settled by id through their own route. */
  reportIds: number[];
  needIds: string[];
}

/**
 * The one folded line for what went stale.
 *
 * `reachable` says whether a name is somebody you could still talk to; it is
 * passed in, not recomputed, because the screen already holds that answer for
 * the Working table and two answers for one name is the drift to avoid.
 */
export function staleLine(
  stale: { reports: { id: number; agent: string; at: number }[]; needs: { id: string; created: number }[] },
  reachable: (agent: string) => boolean,
  now = Date.now(),
): StaleLine | null {
  const count = stale.reports.length + stale.needs.length;
  if (!count) return null;
  const oldest = Math.min(...stale.reports.map((r) => r.at), ...stale.needs.map((n) => n.created));
  return {
    count,
    oldestDays: Math.max(0, Math.floor((now - oldest) / 86_400_000)),
    agentsGone: stale.reports.every((r) => !reachable(r.agent)),
    reportIds: stale.reports.map((r) => r.id),
    needIds: stale.needs.map((n) => n.id),
  };
}

/** "Hidden: 38 old reports, 120 routine checks" — null when there is nothing hidden. */
export function hiddenLine(quiet: { oldReports: number; routine: number } | undefined): { reports: number; routine: number } | null {
  const reports = Math.max(0, quiet?.oldReports ?? 0);
  const routine = Math.max(0, quiet?.routine ?? 0);
  return reports || routine ? { reports, routine } : null;
}

/** A routine round: the coordinator looked and nobody had to be woken (seatwake.ts writes these). */
export const isRoutineLine = (line: string): boolean => /^\(looked at .*so nobody was woken\)$/.test(line.trim());
