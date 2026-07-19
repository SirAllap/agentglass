import { useEffect, useRef, useState, useCallback } from "react";
import type { WatchEvent, WsFrame, OpenToolCall } from "../../../shared/types.ts";
import { WS_URL, IS_DEMO, hasToken, probeAuth } from "./api.ts";
import * as demo from "./demo.ts";

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
 */
export function useLive(): LiveData {
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

  const flush = useCallback(() => {
    flushScheduled.current = false;
    // Don't touch React state while hidden — just keep the buffer bounded.
    if (typeof document !== "undefined" && document.hidden) {
      if (pending.current.length > MAX_EVENTS) {
        pending.current = pending.current.slice(-MAX_EVENTS);
        // Rebuild the dedup set too, or it grows one id per event for the whole
        // time the tab is backgrounded. Keep the ids already displayed (events)
        // as well as those buffered, so a re-delivery of a shown event is still
        // caught after the trim.
        seen.current = new Set([...events.map((e) => e.id), ...pending.current.map((e) => e.id)]);
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
      if (frame.type === "initial") {
        const initial = frame.data.slice(-MAX_EVENTS);
        seen.current = new Set(initial.map((e) => e.id));
        pending.current = [];
        setEvents(initial);
        setLastEvent(initial[initial.length - 1] ?? null);
        setOpenTools(frame.openTools ?? []);
      } else if (frame.type === "event") {
        if (seen.current.has(frame.data.id)) return; // duplicate delivery
        seen.current.add(frame.data.id);
        pending.current.push(frame.data);
        scheduleFlush();
        // A Post closes its tool: drop the matching seed so it can't keep a
        // finished tool marked "running" after its Post later evicts the buffer.
        const ev = frame.data;
        if (ev.hook_event_type === "PostToolUse" || ev.hook_event_type === "PostToolUseFailure") {
          setOpenTools((cur) =>
            cur.length && cur.some((s) => s.session_id === ev.session_id && (!ev.tool_name || s.tool_name === ev.tool_name) && ev.timestamp >= s.since)
              ? cur.filter((s) => !(s.session_id === ev.session_id && (!ev.tool_name || s.tool_name === ev.tool_name) && ev.timestamp >= s.since))
              : cur
          );
        }
      }
      // "session" frames are ignored — the Sessions panel fetches its own roll-ups.
    };
  }, [scheduleFlush]);

  // Pause all ambient CSS animations while the tab is hidden — the stylesheet
  // reads :root[data-idle="1"] and freezes the sweep/pulse/float/shimmer, so a
  // backgrounded dashboard costs ~nothing on top of the browser's throttling.
  useEffect(() => {
    const sync = () => { document.documentElement.dataset.idle = document.hidden ? "1" : "0"; };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
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
    document.addEventListener("visibilitychange", onVis);
    return () => {
      disposed.current = true;
      document.removeEventListener("visibilitychange", onVis);
      if (timer.current) clearTimeout(timer.current);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect, flush]);

  return { events, conn, lastEvent, openTools };
}
