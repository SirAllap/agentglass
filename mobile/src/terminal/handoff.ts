/*
 * "Open this in a tmux window", left for the terminal to pick up.
 *
 * One slot, no queue, no React. It exists because of where the socket lives:
 * the WebSocket to `/terminal/pty` is held inside `TerminalView`, which is
 * mounted by the terminal tab — and the screen pressing the button is a pull
 * request, which cannot reach it and may be running before that tab has ever
 * been opened.
 *
 * So the request is left here, the app navigates to the terminal, and the
 * terminal sends it the moment it has a socket to send it on. This is the same
 * shape as the desktop's `web/src/lib/termIssue.ts`, for the same reason.
 *
 * ── one slot, deliberately ────────────────────────────────────────────────
 * A queue would be worse than useless. Two of these in flight means two windows
 * opening on somebody's machine from one trip to the phone, and the second is
 * never the one that was wanted — a double tap on a button whose whole effect
 * happens on another computer is the likeliest way to get here. The last
 * request wins and the previous one is dropped, silently, because it was
 * superseded rather than lost.
 *
 * ── what may be in it ─────────────────────────────────────────────────────
 * A frame the server already knows how to interpret, and nothing else. Both
 * shapes carry an intent — a pull request number and a recipe ID, or a
 * directory and a prompt — and neither carries a command line. What actually
 * runs is decided in `server/src/terminal.ts`; this module is a letterbox.
 */
import type { PtyClientFrame } from "../../../shared/types.ts";

/** The frames this letterbox accepts: the two that open a window. Narrowed
 *  from `PtyClientFrame` so a caller cannot post a resize or a keystroke
 *  through a channel meant for "go and open something". */
export type Handoff =
  | Extract<PtyClientFrame, { cmd: "review" }>
  | Extract<PtyClientFrame, { cmd: "issue" }>;

let pending: Handoff | null = null;
const listeners = new Set<() => void>();

/** Leave a request. Whatever was there is dropped — see the note above. */
export function requestHandoff(frame: Handoff): void {
  pending = frame;
  for (const fn of [...listeners]) fn();
}

/** What is waiting, without consuming it. For a screen that wants to say so. */
export function pendingHandoff(): Handoff | null {
  return pending;
}

/**
 * Take the request, if there is one.
 *
 * Reading empties the slot, and that is the whole of the delivery guarantee:
 * the terminal calls this when it has an open socket, so a frame is taken out
 * exactly when there is somewhere to put it. A caller that takes one and then
 * fails to send it has dropped it — which is the right trade against the
 * alternative, a slot that redelivers the same window-opening request on every
 * reconnect.
 */
export function takeHandoff(): Handoff | null {
  const frame = pending;
  pending = null;
  return frame;
}

/** Told when something arrives. Returns the way to stop being told. */
export function onHandoff(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** For tests, which must not inherit a slot from the one before. */
export function clearHandoff(): void {
  pending = null;
  listeners.clear();
}
