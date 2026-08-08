/*
 * The live socket, and the one thing about it that is not obvious.
 *
 * `/stream` is what makes the companion a companion rather than a page you
 * refresh: gates, sessions, git and docker all arrive on it as they happen.
 * Connecting to it from a native app takes one deliberate header.
 *
 * ── why an Origin ─────────────────────────────────────────────────────────
 * `trustedCaller` in server/src/index.ts guards the four WebSocket routes, and
 * it reads:
 *
 *     const o = req.headers.get("origin")
 *     if (!o) return LOOPBACK_ONLY      // no origin is only safe when
 *                                       // nobody remote can connect
 *
 * A native fetch and a native WebSocket send no Origin at all, so with remote
 * access switched on — which is the entire situation this app exists for —
 * that returns false and the upgrade is refused. Not a bug in the server: the
 * rule is right for the attack it was written against, which is a page on
 * somebody else's site opening a socket to your laptop.
 *
 * So the app states its origin, and states the true one: the address it is
 * talking to. That is exactly the header a browser served from that address
 * sends, and `privateHost` accepts it for a LAN or tailnet address the same
 * way. Nothing on the server changes, and the guard keeps meaning what it
 * meant — a request from a *different* origin is still refused, because this
 * one is not from a different origin.
 *
 * The REST calls deliberately send no Origin: `localOrigin` treats "no origin"
 * as fine, so adding one there would be a header that can only ever start
 * being wrong.
 */
import type { WsFrame } from "../../../shared/types.ts";
import type { Host } from "./host.ts";

export type LiveState = "connecting" | "open" | "offline";

export interface LiveOptions {
  /**
   * Every frame, as the server's own union types it.
   *
   * This said `WatchEvent` and was wrong: `/stream` carries a `WsFrame`, of
   * which an event is one arm. The mistake cost nothing while the only caller
   * treated a frame as a doorbell and looked at no field — and it would have
   * cost the whole notification feature, because the alert the server
   * broadcasts is a different arm of that union and the type said it could not
   * arrive.
   */
  onFrame: (frame: WsFrame) => void;
  onState: (state: LiveState) => void;
}

/**
 * Backoff for a phone, which is not the same as backoff for a server.
 *
 * A phone goes offline because it went into a lift, and comes back because it
 * came out of one. So the first few retries are quick — that is the lift — and
 * then it settles, because past thirty seconds the thing that is wrong is not
 * going to fix itself and every attempt is radio time on a battery.
 */
const DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
const delayFor = (attempt: number): number =>
  DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)] ?? 30_000;

export interface LiveHandle {
  /** Reconnect now, whatever the backoff was about to do. Called when the app
   *  comes back to the foreground: the user is looking, so waiting out a
   *  thirty-second timer is the wrong answer even if it is nearly up. */
  wake: () => void;
  close: () => void;
}

export function openLive(host: Host, options: LiveOptions): LiveHandle {
  const url =
    host.origin.replace(/^http/, "ws") + "/stream?token=" + encodeURIComponent(host.token);

  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const clearTimer = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  const schedule = (): void => {
    if (closed || timer) return;
    const wait = delayFor(attempt++);
    timer = setTimeout(() => { timer = null; connect(); }, wait);
  };

  function connect(): void {
    if (closed) return;
    options.onState("connecting");

    // React Native's WebSocket takes a third argument the DOM one does not:
    // request options, including headers. This is the only way to put an
    // Origin on the upgrade, and without it the server refuses (see above).
    const Ctor = WebSocket as unknown as new (
      url: string,
      protocols?: string | string[],
      options?: { headers?: Record<string, string> },
    ) => WebSocket;
    const ws = new Ctor(url, undefined, { headers: { Origin: host.origin } });
    socket = ws;

    ws.onopen = (): void => {
      if (closed) { ws.close(); return; }
      attempt = 0;
      options.onState("open");
    };

    ws.onmessage = (message: { data?: unknown }): void => {
      if (typeof message.data !== "string") return;
      let parsed: unknown;
      try { parsed = JSON.parse(message.data); } catch { return; }
      if (!parsed || typeof parsed !== "object") return;
      /*
       * The HANDLER is inside the try as well, and that is the point.
       *
       * This guarded only the parse, with a comment saying an exception here
       * kills the connection for the rest of the session — and then let one
       * straight through from the callback. Which duly happened: a hot reload
       * swapped this file while the caller's closure was still the previous
       * one, so `onFrame` was undefined, every incoming frame threw, and the
       * app went blank rather than losing one message.
       *
       * A socket callback is the wrong place to be strict. Whatever is wrong
       * with one frame, the connection is still worth having.
       */
      try {
        options.onFrame(parsed as WsFrame);
      } catch (e) {
        console.warn("live: a frame handler threw", e);
      }
    };

    const down = (): void => {
      /*
       * A socket that is no longer the current one has no opinion.
       *
       * `wake()` below replaces the socket without waiting for the old one to
       * finish dying, and `close()` drops it outright — in both cases this
       * callback still runs, one turn later, for a connection nobody is using.
       * Reporting it as `offline` painted the screen offline while a fresh
       * socket was already opening, and `schedule()` then queued a SECOND
       * connect on top of the one in flight: two sockets, and the one held in
       * `socket` not the one the server was talking to.
       */
      if (socket !== ws) return;
      socket = null;
      if (closed) return;
      options.onState("offline");
      schedule();
    };
    ws.onerror = down;
    ws.onclose = down;
  }

  connect();

  return {
    wake: (): void => {
      if (closed) return;
      /*
       * An open socket that is actually dead is the normal state after a phone
       * has been asleep — the OS froze it, the peer went away, and nothing
       * told this end. Closing it forces the question rather than trusting
       * readyState, which lies in exactly this case.
       *
       * That is what the comment said while the next line was
       * `if (socket && socket.readyState === 1) return;` — the check it exists
       * to warn about, guarding the reconnect it exists to force.
       *
       * Measured on emulator-5554, the same scripted cycle each side of this
       * edit and nothing else changed. The peer was a stand-in server that stops being
       * a peer without closing the TCP — no FIN, no close frame, which is a
       * phone whose radio was off when the machine went away, and the only
       * shape in which readyState stays 1. Screen off → SIGSTOP the process
       * (what Android's freezer does) → peer goes silent → SIGCONT → wake the
       * screen:
       *
       *   with the early return — five seconds after the unlock the server's
       *   census still read `live: 0, deaf: 1`: no new socket, ever. The next
       *   alert was broadcast to 0 sockets, and the phone drew its green
       *   "connected" dot over a queue still showing the alert from BEFORE it
       *   went to sleep. The 20s poll kept everything else moving, which is
       *   why this looks like a working app that has simply gone quiet.
       *
       *   without it — over three runs the old socket closed 41-72ms after the
       *   screen came on and a new one was open by 62-76ms, before the `adb
       *   shell` that pressed the button had returned. The alert after that
       *   reached 1 socket and the queue redrew 436ms later.
       *
       * Not gated on a `lastFrameAt` instead: the only evidence of liveness
       * this end has is a frame, an idle machine sends none, and any window
       * long enough to count as evidence is longer than the sleep that breaks
       * the socket — so it would reconnect in every case that matters and cost
       * a timestamp that can itself go stale. The reconnect is what is cheap
       * here: 62ms of amber dot, once, when the app comes to the front.
       */
      clearTimer();
      attempt = 0;
      // Cleared BEFORE the close so `down()` above recognises this socket as
      // superseded when its onclose lands after the new one is up.
      if (socket) { const dead = socket; socket = null; try { dead.close(); } catch { /* already gone */ } }
      connect();
    },
    close: (): void => {
      closed = true;
      clearTimer();
      if (socket) { try { socket.close(); } catch { /* already gone */ } socket = null; }
    },
  };
}
