/*
 * The one mark a tab can carry, and the words that say the same thing.
 *
 * A strip full of dots is a strip nobody reads, so a tab draws a mark only when
 * something matters: it needs you (amber), it failed (red), it is working
 * (a breathing ring) or it came back from a restart with nothing running (a
 * clock). Idle, finished and a plain shell draw nothing. New output is a bold
 * name, not a mark, so it can sit beside one.
 *
 * `dead` and `restored` are not on `TmuxWindow` today: the server has to feed
 * them (a pane that exited and is kept by `remain-on-exit`, and a window that
 * was rebuilt by a restore since the app last looked).
 */
import type { WindowStatus } from "../../../shared/windowStatus.ts";

export type Mark = "needs-you" | "failed" | "working" | "restored";

export interface MarkInput {
  name: string;
  status?: WindowStatus | null;
  /** tmux's own flags; `!` is the bell. */
  flags?: string;
  /** The window's process exited and its pane is kept. */
  dead?: boolean;
  exitCode?: number;
  /** The window was rebuilt by a restore and nothing in it is running yet. */
  restored?: boolean;
  /** What was running before the restart ("Claude Code"), when known. */
  wasRunning?: string;
}

export interface WindowMark {
  mark: Mark | null;
  /** New output: draw the name bold. */
  unread: boolean;
  /** The state in words ("needs you"); empty when there is no mark. */
  title: string;
  /** "name, needs you, new output" */
  label: string;
}

export function windowMark(w: MarkInput): WindowMark {
  let mark: Mark | null = null;
  let title = "";
  // Dead and restored first: a stale status on a pane that is not running
  // would otherwise keep saying "working".
  if (w.dead) { mark = "failed"; title = w.exitCode === undefined ? "exited" : `exited (${w.exitCode})`; }
  else if (w.restored) { mark = "restored"; title = w.wasRunning ? `was running ${w.wasRunning}` : "restored"; }
  else if (w.status === "waiting") { mark = "needs-you"; title = "needs you"; }
  else if (w.status === "error") { mark = "failed"; title = "failed"; }
  else if (w.status === "working") { mark = "working"; title = "working"; }
  const unread = !!w.flags?.includes("!");
  const label = [w.name, title, unread && "new output"].filter(Boolean).join(", ");
  return { mark, unread, title, label };
}
