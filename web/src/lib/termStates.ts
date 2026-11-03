/*
 * Which of the Terminal's non-normal states is on screen, if any.
 *
 *   loading  waiting on tmux: the first frame has not come, or the socket is
 *            coming back (a reconnect in flight counts, so the card does not
 *            flash "can't reach" between two tries)
 *   error    the tries are over and tmux did not answer
 *   empty    tmux answered with no windows
 *   notmux   this machine has no tmux; the shell works, restarts lose it
 *   ready    the strip and the panes, as always
 *
 * Only a shell that is (or was) on tmux can be loading, empty or in error: a
 * plain shell with no tmux has its own Reconnect pill and says nothing here.
 */
export type TermState = "ready" | "loading" | "error" | "empty" | "notmux";

export interface TermStateInput {
  status: "idle" | "connecting" | "live" | "exited" | "error" | "unauthorized";
  /** The server reported tmux on this shell (now or before the socket dropped). */
  tmux: boolean;
  /** The server said a tmux frame is coming and it has not arrived. */
  due: boolean;
  /** The first draw is done; before that the launch cover is up. */
  settled: boolean;
  windows: number;
  /** The server found no tmux binary on this machine (not: tmux is switched off). */
  noTmux: boolean;
  /** A reconnect is scheduled. */
  retrying: boolean;
  /** The person put the no-tmux note away. */
  noteDismissed: boolean;
}

export function termState(i: TermStateInput): TermState {
  if (i.status === "unauthorized") return "ready";
  if (i.due) return "loading";
  if (i.tmux) {
    if (i.status === "connecting" || (i.status === "error" && i.retrying)) return "loading";
    if (i.status === "error") return "error";
    if (i.status === "live" && i.windows === 0) return "empty";
    return "ready";
  }
  if (i.noTmux && i.status === "live" && i.settled && !i.noteDismissed) return "notmux";
  return "ready";
}
