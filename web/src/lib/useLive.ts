import { useEffect, useRef, useState, useCallback } from "react";
import type { WatchEvent, WsFrame, OpenToolCall } from "../../../shared/types.ts";
import { WS_URL, IS_DEMO, hasToken, probeAuth } from "./api.ts";
import * as demo from "./demo.ts";
import { gitChanged } from "./gitBus.ts";
import { sessionChanged } from "./sessionBus.ts";
import { emitControl } from "./controlBus.ts";
import { recordNote, fireDesktopAlert } from "./sysNotify.ts";

const MAX_EVENTS = 2000;
const FLUSH_MS = 220; // coalesce bursts into ~5 renders/sec
// Stop hammering a server that won't come back. ~2 minutes of failed reconnects
// (the backoff tops out at 8s) is long enough to ride out a restart but short
// enough not to loop forever; becoming visible again resets and retries.
const GIVE_UP_MS = 120_000;

export type ConnState = "connecting" | "open" | "closed" | "unauthorized";

export interface LiveData {
  events: WatchEvent[];
  conn: ConnState;
  lastEvent: WatchEvent | null;
  /** Server's authoritative list of tool calls still running — seeds the
   *  per-agent "running" state for Pres that have aged out of `events`. */
  openTools: OpenToolCall[];
}

/**
 * Single WebSocket with auto-reconnect. Incoming events are BUFFERED and
 * flushed on a timer (not per-message) so a busy fleet causes a few renders a
 * second instead of dozens. Rendering pauses entirely while the tab is hidden.
 *
 * `keepEvents` is what makes this usable on a phone. The event buffer is the
 * expensive part — up to two thousand rows, re-set every 220ms — and it exists
 * for the cockpit's event stream, which the companion does not draw. Everything
 * the phone *does* need rides the same socket: `openTools` (what each agent has
 * open right now), the connection state, and the git / control / alert frames
 * that arrive as side effects. Turning the buffer off is not a smaller feature
 * set, it is the same subscription without the one part nobody is looking at.
 *
 * A second socket for the phone was the alternative and would have been worse:
 * the reconnect, the backoff, the give-up window and the auth probe below are
 * subtle, and a copy of them would drift from this one the first time either
 * was touched.
 */
export function useLive(paused = false, keepEvents = true): LiveData {
  const [events, setEvents] = useState<WatchEvent[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [lastEvent, setLastEvent] = useState<WatchEvent | null>(null);
  const [openTools, setOpenTools] = useState<OpenToolCall[]>([]);
  const connRef = useRef(conn);
  connRef.current = conn;
  const wsRef = useRef<WebSocket | null>(null);
  const retry = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposed = useRef(false);
  const opened = useRef(false);       // did the current socket ever reach open?
  const firstFailAt = useRef(0);      // when the current run of failures started

  // Buffered incoming events + a set of ids already in the buffer (dedupe).
  const pending = useRef<WatchEvent[]>([]);
  const seen = useRef(new Set<number>());
  const flushScheduled = useRef(false);
  // What is currently on screen. Read by the trim below, which used to close
  // over the first render's empty array and so rebuilt the dedupe set without
  // the ids it was meant to remember.
  const shown = useRef(events);
  shown.current = events;
  // "Something is covering the dashboard." Rendering behind it is work nobody
  // can see, and on the desktop app it is work charged to the same CPU that is
  // trying to scroll whatever opened on top. Held in a ref so the flush reads it
  // without the callback being rebuilt on each toggle.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const keepRef = useRef(keepEvents);
  keepRef.current = keepEvents;

  const flush = useCallback(() => {
    flushScheduled.current = false;
    // Don't touch React state while hidden or covered — just keep the buffer
    // bounded. Nothing is lost: uncovering flushes at once.
    if (pausedRef.current || (typeof document !== "undefined" && document.hidden)) {
      if (pending.current.length > MAX_EVENTS) {
        pending.current = pending.current.slice(-MAX_EVENTS);
        // Rebuild the dedup set too, or it grows one id per event for the whole
        // time the tab is backgrounded. Keep the ids already displayed (events)
        // as well as those buffered, so a re-delivery of a shown event is still
        // caught after the trim.
        seen.current = new Set([...shown.current.map((e) => e.id), ...pending.current.map((e) => e.id)]);
      }
      return;
    }
    const batch = pending.current;
    if (!batch.length) return;
    pending.current = [];
    setLastEvent(batch[batch.length - 1]);
    setEvents((prev) => {
      const next = prev.length ? prev.concat(batch) : batch;
      if (next.length > MAX_EVENTS) {
        const trimmed = next.slice(-MAX_EVENTS);
        seen.current = new Set(trimmed.map((e) => e.id));
        return trimmed;
      }
      return next;
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    timer.current = setTimeout(flush, FLUSH_MS);
  }, [flush]);

  const connect = useCallback(() => {
    if (disposed.current) return;
    setConn("connecting");
    opened.current = false;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      retry.current = 0;
      firstFailAt.current = 0;
      opened.current = true;
      setConn("open");
    };
    ws.onclose = async () => {
      if (disposed.current || wsRef.current !== ws) return;
      const everOpened = opened.current;
      opened.current = false;

      // A close before the socket ever opened, on a token-protected server, is
      // almost always the 401 that rejects the WS upgrade — which a browser can't
      // read off the socket. Probe an authenticated endpoint to be sure, and if
      // it's an auth wall, stop: retrying forever just spams and never recovers.
      if (!everOpened && hasToken()) {
        const state = await probeAuth();
        if (disposed.current || wsRef.current !== ws) return;
        if (state === "unauthorized") { setConn("unauthorized"); return; }
      }

      setConn("closed");
      if (!firstFailAt.current) firstFailAt.current = Date.now();
      if (Date.now() - firstFailAt.current > GIVE_UP_MS) return; // gave up — see visibility reset
      reconnectTimer.current = setTimeout(connect, Math.min(8000, 500 * 2 ** retry.current++));
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (msg) => {
      let frame: WsFrame;
      try {
        frame = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (frame.type === "git") {
        // Not our data — a nudge for whoever is showing git state.
        gitChanged();
        return;
      }
      if (frame.type === "control") {
        // An external controller (Stream Deck, phone) drove the UI. Imperative,
        // not data — hand it to App, which runs it through the same setters the
        // keyboard does.
        emitControl(frame.data);
        return;
      }
      if (frame.type === "alert") {
        // agentglass's own push alert (gate hold, permission wait, tool error),
        // opted into on the server. Raise it as a native OS notification — the
        // cross-platform replacement for notify-send. The notch already has the
        // in-app copy through its own paths (gateStore et al.), so this does not
        // also recordNote, which would double it there.
        fireDesktopAlert(frame.data);
        return;
      }
      if (frame.type === "ci") {
        // The server holds the latch, so this arrives once per verdict for a
        // whole suite. Naming the failures is the point: "1 failing" without a
        // name is what sends you to the browser.
        const v = frame.data;
        recordNote({
          app: "agentglass",
          summary: `${v.repo}#${v.number} — checks ${v.verdict}`,
          body: v.verdict === "red" && v.failing.length
            ? `${v.failing.slice(0, 3).join(", ")}${v.failing.length > 3 ? ` +${v.failing.length - 3} more` : ""}\n${v.title}`
            : v.title,
          urgency: v.verdict === "red" ? 2 : 1,
        });
        return;
      }
      if (frame.type === "initial") {
        // openTools is taken either way: it is the whole reason a phone opens
        // this socket, and it rides on the same first frame.
        setOpenTools(frame.openTools ?? []);
        if (!keepRef.current) return;
        const initial = frame.data.slice(-MAX_EVENTS);
        seen.current = new Set(initial.map((e) => e.id));
        pending.current = [];
        setEvents(initial);
        setLastEvent(initial[initial.length - 1] ?? null);
      } else if (frame.type === "openTools") {
        // The whole list, re-read with fresh evidence. Replaces rather than
        // merges: the server's answer is authoritative about what is open, and
        // a call missing from it has closed.
        setOpenTools(frame.data);
      } else if (frame.type === "event") {
        if (seen.current.has(frame.data.id)) return; // duplicate delivery
        seen.current.add(frame.data.id);
        if (keepRef.current) {
          pending.current.push(frame.data);
          scheduleFlush();
        } else if (seen.current.size > MAX_EVENTS) {
          // Without the buffer nothing else ever trims this, so it would grow one
          // id per event for as long as the phone is open. Ids arrive ascending,
          // so keeping the newest half still catches every re-delivery that is
          // close enough in time to matter.
          seen.current = new Set([...seen.current].slice(-MAX_EVENTS / 2));
        }
        // A Post closes its tool: drop the matching seed so it can't keep a
        // finished tool marked "running" after its Post later evicts the buffer.
        // This runs whether or not the buffer is kept — a phone that draws only
        // the open call needs the close more than the cockpit does, because it
        // has no event list underneath to contradict a stale one.
        const ev = frame.data;
        if (ev.hook_event_type === "PostToolUse" || ev.hook_event_type === "PostToolUseFailure") {
          setOpenTools((cur) =>
            cur.length && cur.some((s) => s.session_id === ev.session_id && (!ev.tool_name || s.tool_name === ev.tool_name) && ev.timestamp >= s.since)
              ? cur.filter((s) => !(s.session_id === ev.session_id && (!ev.tool_name || s.tool_name === ev.tool_name) && ev.timestamp >= s.since))
              : cur
          );
        }
      } else if (frame.type === "session") {
        // The cockpit's Sessions panel fetches its own roll-ups on its own
        // clock and does not need this. The companion does: a phone poll costs
        // a radio wake, so its interval was tuned for battery rather than for
        // truth. Announced rather than handled, so each surface decides how
        // much of a several-a-second frame it actually wants.
        sessionChanged(frame.data.session_id);
      }
    };
  }, [scheduleFlush]);

  // Pause all ambient CSS animations while nobody is looking at the window —
  // the stylesheet reads :root[data-idle="1"] and freezes the
  // sweep/pulse/float/shimmer.
  //
  // `document.hidden` alone was the whole test, and in the desktop app it is
  // never true: a desktop window has no tab to background, so the flag sat at
  // "0" for the entire life of the process and none of these rules ever
  // applied. The saving was real but only a browser ever collected it — every
  // frame of every ambient loop keeps the radar sweep and a ping-ring per live
  // session running forever, and the dashboard idles hot for no one watching.
  //
  // Focus is the signal that survives both environments: the dashboard's normal
  // place is a second monitor or behind the terminal the agent is running in,
  // so "not focused" is most of its life. Deliberately NOT an inactivity timer
  // on top — this is a monitoring surface people leave on-screen and watch, and
  // freezing the sweep under a still-visible, still-focused window would read as
  // a hung app rather than a saving.
  // Catch up the moment the dashboard is uncovered — one render for everything
  // that arrived while it was hidden, instead of five a second into the dark.
  useEffect(() => {
    if (!paused) flush();
  }, [paused, flush]);

  useEffect(() => {
    const sync = () => {
      const looking = !document.hidden && document.hasFocus();
      document.documentElement.dataset.idle = looking ? "0" : "1";
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);

  useEffect(() => {
    disposed.current = false;

    // Demo mode: no WebSocket — seed from the fake dataset and feed a
    // simulated live stream through the same buffer/flush pipeline.
    if (IS_DEMO) {
      const initial = demo.recent();
      seen.current = new Set(initial.map((e) => e.id));
      setEvents(initial);
      setLastEvent(initial[initial.length - 1] ?? null);
      setConn("open");
      const stop = demo.startStream((e) => {
        if (seen.current.has(e.id)) return;
        seen.current.add(e.id);
        pending.current.push(e);
        scheduleFlush();
      });
      return () => { disposed.current = true; stop(); if (timer.current) clearTimeout(timer.current); };
    }

    connect();
    // Catch up the moment the tab becomes visible again — and, if the stream
    // died or gave up while we were away, reconnect right now instead of waiting
    // out a backoff. An auth wall is left alone: the token is still wrong until
    // the user re-enters it, so we don't spin on it.
    const onVis = () => {
      if (document.hidden) return;
      flush();
      if (connRef.current === "unauthorized") return;
      const ws = wsRef.current;
      const dead = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
      if (dead && connRef.current !== "open") {
        if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
        retry.current = 0;
        firstFailAt.current = 0;
        connect();
      }
    };
    /**
     * The shell moved the server under us: a new port, a new token, or both,
     * after remote access was toggled or a link revoked.
     *
     * The old socket is already dead — its server is gone — but the backoff
     * would keep the app disconnected for seconds over a change the user just
     * made and is watching. Reconnect at once, against the URL the api module
     * has just rebuilt. `unauthorized` is cleared deliberately: a rotated token
     * is exactly the case where the previous refusal no longer applies.
     */
    const onServerChanged = () => {
      if (disposed.current) return;
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
      retry.current = 0;
      firstFailAt.current = 0;
      try { wsRef.current?.close(); } catch { /* already gone */ }
      wsRef.current = null;
      connect();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("agentglass:server-changed", onServerChanged);
    return () => {
      disposed.current = true;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("agentglass:server-changed", onServerChanged);
      if (timer.current) clearTimeout(timer.current);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect, flush]);

  return { events, conn, lastEvent, openTools };
}
