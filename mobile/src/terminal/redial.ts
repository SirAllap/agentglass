/*
 * When a terminal socket that dropped under a screen somebody is looking at
 * should be dialled again, and after how long.
 *
 * Installing the desktop app restarts its server, which closes every phone's
 * socket without a close frame (code 1006) and takes the grouped tmux session
 * each one was attached to with it — deliberately: that session exists only
 * for its client. Measured against a server on its own tmux socket: SIGTERM and
 * SIGKILL both leave the phone's `agx-phone-…` session gone and every other
 * session standing, and a fresh attach to the same pane afterwards gets a new
 * grouped session on the same window with the whole scrollback. What was
 * missing was the phone asking: the screen sat on "Disconnected" until the app
 * was backgrounded and brought back, or another tab was tapped.
 *
 * What is NOT redialled, and why each one matters:
 *   - a refusal ("that pane is gone", "too many open terminals"): the server
 *     said no and said why; asking again is how a loop starts;
 *   - a close the server chose (shell exited, 1000): the pane ended, and
 *     re-attaching to a window somebody just left is not what they asked for;
 *   - anything while the app is away: every attach is a tmux client on the
 *     person's machine, and a phone in a pocket should not put one back.
 *
 * The ceiling: six tries over about a minute, then it waits for the person
 * (foreground, or a tap on the tab). A server that stays down for longer is
 * not one this screen should keep knocking on.
 */

/** Close codes that mean the other end went away rather than answered: no
 *  frame at all, going away, and service restart. */
const WENT_AWAY = new Set([1006, 1001, 1012]);

/** Seconds, not milliseconds, to read it at a glance: 1+2+4+8+15+30. */
export const REDIAL_MS: readonly number[] = [1, 2, 4, 8, 15, 30].map((s) => s * 1000);

/** A socket that stayed up this long was a working connection, so its drop
 *  starts the count again; one that dies sooner is the same outage. */
export const STABLE_MS = 10_000;

export interface Drop {
  /** The close code, when the platform gave one. */
  code: number | undefined;
  /** The server sent a `fatal` frame before closing. */
  refused: boolean;
  /** Whether the app is in the foreground right now. */
  active: boolean;
  /** Consecutive drops so far, this one not counted. */
  failures: number;
}

/** Milliseconds to wait before dialling again, or null for "do not". */
export function redialIn(d: Drop): number | null {
  if (d.refused || !d.active) return null;
  if (d.code === undefined || !WENT_AWAY.has(d.code)) return null;
  return REDIAL_MS[d.failures] ?? null;
}
