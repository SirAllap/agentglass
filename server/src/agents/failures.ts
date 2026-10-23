/*
 * What a worker's failed turn looked like, from the two files the wrapper
 * leaves (headless.ts): stdout and stderr.
 *
 * A retry on the next engine is allowed only when the turn never got to work.
 * Re-running a half-done task on another engine in the same worktree edits on
 * top of what the first one left, so "work started" decides first and the
 * words only second. The check errs toward "started": a frame this file does
 * not know counts as work, so a new engine frame costs a missed retry and
 * never a doubled edit.
 *
 * The patterns are the shapes measured by hand (S0): Claude prints
 * "Not logged in · Please run /login" on stdout, Codex prints 401 error
 * frames. A real rate-limit line was never produced (it cannot be forced
 * without spending the plan), so that pattern is the common wording, and a
 * line it misses costs a retry, not a wrong one.
 */

export type FirstTurnFailure = "rate-limit" | "signed-out";

const RATE_LIMIT = /rate.?limit|usage limit|limit reached|too many requests|\b429\b|quota (exceeded|exhausted)|overloaded/i;
const SIGNED_OUT = /not logged in|please run \/login|\b401\b|unauthori[sz]ed|not signed in|invalid api key|sign in required|authentication (failed|required)/i;

/** Frames an engine prints before it has done anything. */
const HANDSHAKE = new Set(["system", "init", "thread.started", "turn.started", "error", "step_start"]);

/** Whether the turn got past the handshake. Lines that are not JSON frames
 *  (Claude's signed-out sentence) are not work. */
export function workStarted(out: string): boolean {
  for (const l of out.split("\n")) {
    if (!l.startsWith("{")) continue;
    let f: { type?: unknown; is_error?: unknown };
    try { f = JSON.parse(l); } catch { continue; }
    if (f.type === "result" && f.is_error === true) continue;
    if (typeof f.type === "string" && HANDSHAKE.has(f.type)) continue;
    return true;
  }
  return false;
}

/** The kind of failure a turn that never started ended in, or null when it
 *  had started or the words match neither pattern. */
export function firstTurnFailure(out: string, err: string): FirstTurnFailure | null {
  if (workStarted(out)) return null;
  const said = `${out.slice(-4000)}\n${err.slice(-4000)}`;
  if (SIGNED_OUT.test(said)) return "signed-out";
  if (RATE_LIMIT.test(said)) return "rate-limit";
  return null;
}
