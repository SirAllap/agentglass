/*
 * Output for a terminal nobody is looking at waits until somebody is.
 *
 * The terminal view stays mounted while another view is on screen, on purpose:
 * unmounting it would detach a live terminal (see the mount effect in
 * TerminalPanel). Its box is hidden with `visibility`, which still counts as
 * on screen to xterm, so every byte an agent prints was parsed AND drawn,
 * frame after frame, into pixels nobody saw. With agents working that is the
 * largest cost the window pays for a view that is not shown.
 *
 * So while the view is hidden the bytes are kept here, in order, and written
 * in one go when the view comes back. Nothing is dropped, ever: past
 * HIDDEN_HOLD_MAX_BYTES everything kept so far is handed back to be written
 * at once and keeping starts again from empty, so memory is bounded and the
 * terminal is at most that far behind.
 *
 * Ceilings, chosen:
 *  - Only a shell with tmux in it is held (`mayHoldWrites`). tmux answers the
 *    questions programs ask their terminal; without it xterm does, and a
 *    program whose question sat here unanswered would hang.
 *  - What tmux itself asks the terminal while hidden (rare after attach), and
 *    a clipboard write a program makes through it, are answered when the view
 *    returns, not before.
 *  - A reader of the terminal's buffer while the view is hidden sees it up to
 *    HIDDEN_HOLD_MAX_BYTES behind.
 *  - A shell that connects while the view is hidden is not held until the
 *    view has been shown and hidden again: its first exchange goes straight
 *    through.
 *
 * The same wait applies to a shell that is off screen INSIDE the shown view:
 * another checkout's shell, or a pane that was closed. Its holder is in no
 * pane, so nothing draws it, yet it kept parsing every byte into its
 * scrollback. It waits like a hidden view's shell and is released the moment
 * a pane takes it (`shouldHoldWrites`).
 *
 * And the same wait applies to every shell while the window itself is hidden
 * (minimized: `document.hidden`). Its frames stop, so xterm draws nothing, but
 * it still parsed every byte of the shells in view. Measured with
 * web/scripts/hiddenterm-bench.ts (3 busy shells, 8 s, 4.2 MB): written as they
 * come, 1123-1163 ms CPU and ~61 buffer changes a second per shell (one render
 * each in a page); held, 61-97 ms CPU, none, and 57-78 ms to write it all on
 * show, with the same text in the end.
 *
 * Ceiling: the bytes still cross the socket and are kept here in memory.
 * Stopping them at the source needs a server protocol change (stop sending,
 * resync from tmux on reveal); that is not done here.
 */

/** The most output kept for one hidden terminal before it is written anyway. */
export const HIDDEN_HOLD_MAX_BYTES = 2 * 1024 * 1024;

export interface WriteHold {
  holding: boolean;
  chunks: Uint8Array[];
  bytes: number;
}

export const newWriteHold = (): WriteHold => ({ holding: false, chunks: [], bytes: 0 });

function drain(h: WriteHold): Uint8Array[] {
  const out = h.chunks;
  h.chunks = [];
  h.bytes = 0;
  return out;
}

/** A chunk arrived: what must be written to the terminal now, in order. */
export function holdTake(h: WriteHold, chunk: Uint8Array): Uint8Array[] {
  if (!h.holding) return [chunk];
  h.chunks.push(chunk);
  h.bytes += chunk.length;
  return h.bytes > HIDDEN_HOLD_MAX_BYTES ? drain(h) : [];
}

/** The view went away: keep what arrives from now on. */
export function holdStart(h: WriteHold): void {
  h.holding = true;
}

/** The view is back, or the shell needs its terminal now: everything kept, in order, and no more keeping. */
export function holdRelease(h: WriteHold): Uint8Array[] {
  h.holding = false;
  return drain(h);
}

/** Whether a shell's output may wait at all. See the ceilings above. */
export function mayHoldWrites(s: { tmux: boolean; drawn?: boolean; status: string }): boolean {
  return s.tmux && s.drawn === true && s.status === "live";
}

/**
 * Whether a shell's output waits right now. `canHold` is `mayHoldWrites`.
 * - View hidden: wait if the shell sits in this view's own pane.
 * - View shown: wait if the shell is in no pane and its holder is attached nowhere
 *   (a holder lent to the console strip, or anywhere else that shows it, is on screen).
 * - Window hidden (minimized): wait, wherever the shell is. Nothing of the window is on screen.
 */
export function shouldHoldWrites(o: {
  open: boolean;
  viewActive: boolean;
  canHold: boolean;
  inOwnPane: boolean;
  inShownPane: boolean;
  holderAttached: boolean;
  windowHidden?: boolean;
}): boolean {
  if (!o.open || !o.canHold) return false;
  if (o.windowHidden) return true;
  if (!o.viewActive) return o.inOwnPane;
  return !o.inShownPane && !o.holderAttached;
}
