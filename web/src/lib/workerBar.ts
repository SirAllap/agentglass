/*
 * Which pane belongs to a headless worker.
 *
 * `/agents/named` is the only list that knows a policy-started worker by the
 * pane it runs in: the board is built from hooked sessions, and a headless
 * OpenCode turn fires none. `startedBy` is the stamp a policy start leaves and
 * nothing else does, so a tab a person opened by hand — a named agent, an
 * enlisted tab — never gets the worker's stop button.
 *
 * The row outlives its turn on purpose: its tab is kept for reading, so the
 * bar has to say the turn ended rather than vanish and leave a read-only pane
 * looking like a broken one.
 */
export interface NamedAgentRow {
  name: string;
  kind: string;
  paneId: string;
  windowId: string;
  startedAt: number;
  endedAt: number | null;
  model?: string;
  startedBy?: unknown;
  exitCode?: number;
  exitLine?: string;
  /** The server's word that this turn ended cleanly with nothing to read. */
  resultMissing?: boolean;
}

/** Rows arrive newest first, so the pane's newest row is the one that decides:
 *  a stale worker row behind a tab somebody opened later is not that tab's. */
export function workerAt(rows: readonly NamedAgentRow[] | null, paneId: string | null): NamedAgentRow | null {
  if (!paneId || !rows) return null;
  const here = rows.find((r) => r.paneId === paneId);
  return here && here.startedBy !== undefined ? here : null;
}

/**
 * The last word on the bar: running, ended, or the status it exited with.
 * "Ended without a result" outranks the exit code because that is the part a
 * person has to act on — a role whose whole job was its answer left none.
 */
export function workerStatus(r: NamedAgentRow): string {
  if (r.endedAt === null) return "running";
  if (r.resultMissing) return "ended without a result";
  return r.exitCode === undefined ? "ended" : `exit ${r.exitCode}`;
}
