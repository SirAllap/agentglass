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
const listeners = new Set<(cmd: ControlCmd) => void>();

/** Called by the live socket when the server relays a control command. */
export function emitControl(cmd: ControlCmd): void {
  for (const fn of listeners) {
    try { fn(cmd); } catch { /* one bad listener must not stop the rest */ }
  }
}

export function subscribeControl(fn: (cmd: ControlCmd) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
