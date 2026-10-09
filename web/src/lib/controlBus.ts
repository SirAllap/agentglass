import type { ControlCmd } from "../../../shared/types.ts";

/**
 * "The UI was told to navigate" — one signal, one consumer.
 *
 * A control command (POST /control on the server) arrives on the live socket
 * like any other frame, but it is imperative — "open the git view", "cycle the
 * theme" — not data to render. `useLive` hands it here, and App subscribes and
 * runs it through the same setters the keyboard handler already owns, so an
 * external controller (a Stream Deck, a phone) and the keyboard drive the exact
 * same navigation with no second code path to keep in step.
 */
/** How the sender wants it shown, and the name it stamped itself with. Absent
 *  for a command that did not come off the server's socket (a window's own
 *  button), which is `now`. */
export interface ControlMeta { present?: "quiet" | "now"; as?: string; level?: 1 | 2 | 3 }
/** `rid` is set when the sender is waiting for an answer (POST /control/result). */
export type ControlListener = (cmd: ControlCmd, rid?: string, meta?: ControlMeta) => void;
const listeners = new Set<ControlListener>();

/** Called by the live socket when the server relays a control command. */
export function emitControl(cmd: ControlCmd, rid?: string, meta?: ControlMeta): void {
  for (const fn of listeners) {
    try { fn(cmd, rid, meta); } catch { /* one bad listener must not stop the rest */ }
  }
}

export function subscribeControl(fn: ControlListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
