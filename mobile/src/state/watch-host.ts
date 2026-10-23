/*
 * The socket kept for a computer that is not the one in front.
 *
 * The app exists to not miss an agent that is blocked, and a computer the
 * phone is not looking at is exactly where that goes unseen. So each of them
 * keeps one socket, and this is all it does with it:
 *
 *   - report whether the socket is up, for the dot in the switcher;
 *   - hand over its alerts, which the provider raises with the computer's name;
 *   - count the gates waiting on a person, for the badge — read once when the
 *     socket opens and again when a `gate` frame says the list moved.
 *
 * It has no timer. The fleet, the pull requests, the marks and the theme are
 * the computer in front's business and are not read here; every other frame is
 * ignored, so the cost of an idle computer is its socket and about one request
 * an hour plus one per time one of its agents blocks. A burst of gate frames
 * during one read costs one more read, not one each.
 *
 * `deps` is the seam the tests use; the default is the real thing.
 */
import type { AlertNote, PendingGate } from "../../../shared/types.ts";
import { ask, REVOKED } from "../lib/api.ts";
import type { HostEntry } from "../lib/hosts.ts";
import { openLive, type LiveState } from "../lib/live.ts";

export interface WatchEvents {
  onState: (state: LiveState) => void;
  onWaiting: (gates: number) => void;
  onAlert: (alert: AlertNote) => void;
  onRevoked: () => void;
}

export interface WatchDeps {
  openLive: typeof openLive;
  ask: typeof ask;
}

export function watchHost(
  host: HostEntry,
  events: WatchEvents,
  deps: WatchDeps = { openLive, ask },
): () => void {
  let closed = false;
  let reading = false;
  let again = false;

  const read = async (): Promise<void> => {
    if (closed) return;
    if (reading) { again = true; return; }
    reading = true;
    try {
      const answer = await deps.ask<{ gates: PendingGate[] }>(host, "/gate/pending");
      if (closed) return;
      if (!answer.ok) {
        if (answer.error === REVOKED) { closed = true; handle.close(); events.onRevoked(); }
        return; // a failed read keeps the last count; the socket's state says the rest
      }
      events.onWaiting(Array.isArray(answer.value.gates) ? answer.value.gates.length : 0);
    } finally {
      reading = false;
      if (again && !closed) { again = false; void read(); }
    }
  };

  const handle = deps.openLive(host, {
    onState: (state) => {
      events.onState(state);
      if (state === "open") void read();
    },
    onFrame: (frame) => {
      if (frame.type === "gate") void read();
      else if (frame.type === "alert" && frame.data) events.onAlert(frame.data as AlertNote);
    },
  });

  return () => { closed = true; handle.close(); };
}
