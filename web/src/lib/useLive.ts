import { useEffect, useRef, useState, useCallback } from "react";
import type { WatchEvent, WsFrame, OpenToolCall } from "../../../shared/types.ts";
import { WS_URL, IS_DEMO, hasToken, probeAuth } from "./api.ts";
import * as demo from "./demo.ts";
import { gitChanged } from "./gitBus.ts";
import { emitControl } from "./controlBus.ts";
import { emitBrowserAsk } from "./browserBus.ts";
import { recordNote, fireDesktopAlert } from "./sysNotify.ts";
import { ciShouldNotify } from "./ciNotifyPref.ts";
import { raiseAlarm } from "./alarm.ts";
import { nudgeReminders } from "./reminderStore.ts";

const MAX_EVENTS = 2000;
const FLUSH_MS = 220; // coalesce bursts into ~5 renders/sec
// Stop *hammering* a server that won't come back. ~2 minutes of failed
// reconnects (the backoff tops out at 8s) is long enough to ride out a restart.
const GIVE_UP_MS = 120_000;
/**
 * What the retry slows to after that, rather than stopping.
 *
 * It used to stop outright, and the only way back was `visibilitychange` — which
 * a tab sitting in the foreground never receives. So a tab left open and watched
 * through an outage longer than two minutes disconnected permanently: no events,
 * no chats, nothing, until somebody reloaded it or happened to switch tabs and
 * back. The comment here claimed "becoming visible again resets and retries",
 * which was true of every tab except the one being looked at.
 *
 * Slow enough that an unreachable server is not being hammered — one attempt a
 * minute against a socket that fails immediately is nothing — and quick enough
 * that a server coming back is noticed without the user doing anything.
 */
const IDLE_RETRY_MS = 60_000;

/**
 * How long to wait before the next reconnect attempt.
 *
 * Exported because the invariant worth pinning is not a number but the absence
 * of one: this always returns a delay. It never says "stop", which is what the
 * old code did once `failingForMs` passed the give-up window — leaving a
 * foreground tab, the only kind that receives no `visibilitychange`, dead until
 * it was reloaded.
 */
export function reconnectDelay(failingForMs: number, retry: number): number {
  if (failingForMs > GIVE_UP_MS) return IDLE_RETRY_MS;
  return Math.min(8000, 500 * 2 ** retry);
}

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
 * The buffer is unconditional. It used to be optional, behind a `keepEvents`
 * parameter written for the browser companion — a second, phone-shaped page
 * that opened this same socket and drew everything but the event stream, so it
 * paid for two thousand rows re-set every 220ms and looked at none of them.
 * That companion was deleted; this half of it was missed, and the parameter
 * defaulted to true, so every path that exists took the same branch. `grep -rn
 * "useLive(" web/src` is one call site, App.tsx's `useLive(anyPanelOpen)`, and
 * has been for as long as the companion has been gone.
 *
 * The React Native app is not that companion and never was: it opens /stream
 * through its own client (mobile/src/lib/live.ts) and reads `{type:"alert"}`
 * off it. It has never asked this hook for anything, openTools included.
 *
 * The `sessionBus` comment further down was rewritten when the companion went;
 * this was the piece left behind, and four comments here went on describing a
 * caller that no longer existed.
 */
export function useLive(paused = false): LiveData {
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
      // Past the give-up window the backoff stops growing and simply goes
      // quiet — it never stops. A foreground tab has no other way back.
      const wait = reconnectDelay(Date.now() - firstFailAt.current, retry.current++);
      reconnectTimer.current = setTimeout(connect, wait);
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
      if (frame.type === "browser") {
        // An agent is driving the built-in browser. Imperative and addressed to
        // one panel, so it goes to its own bus rather than through the control
        // one — and it is answered even when no panel is listening, or the
        // agent's request hangs until the server gives up on it.
        emitBrowserAsk(frame.data);
        return;
      }
      if (frame.type === "control") {
        // An external controller (Stream Deck, phone) drove the UI. Imperative,
        // not data — hand it to App, which runs it through the same setters the
        // keyboard does.
        emitControl(frame.data);
        return;
      }
      if (frame.type === "alert" && frame.data?.kind === "reminder" && frame.data.id) {
        /* An alarm the user set. It does NOT go through fireDesktopAlert's list:
           a reminder that arrives as another grey row has failed at the only job
           it had. The card takes the screen and rings; the OS notification is
           still sent, at critical urgency, so it survives the window being
           behind something else. */
        raiseAlarm({ id: frame.data.id, title: frame.data.title.replace(/^⏰\s*/, ""), when: frame.data.body, at: Date.now() });
        fireDesktopAlert(frame.data);
        void nudgeReminders();
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
      if (frame.type === "card") {
        /* A ClickUp card of yours moved. Recorded in the bell rather than fired
           as an OS pop-up: this is news, not a blockage, and the one thing it
           needs is somewhere to go — which it has, because the note carries the
           card and the bell knows how to open one. */
        const c = frame.data;
        // Four sentences, and each says only what the API actually answered.
        // A comment carries its author, so it names one; an assignment does
        // not, so it never does.
        const summary =
          c.kind === "assigned" ? `${c.label} assigned to you`
          : c.kind === "status" ? `${c.label} → ${c.status}`
          : c.kind === "mention" ? `${c.who ?? "Somebody"} mentioned you on ${c.label}`
          : `${c.who ?? "Somebody"} commented on ${c.label}`;
        const body =
          c.kind === "assigned" ? `${c.title}${c.status ? ` · ${c.status}` : ""}`
          : c.kind === "status" ? `${c.title}${c.was ? ` · was ${c.was}` : ""}`
          : c.said || c.title;
        recordNote({
          app: "ClickUp",
          summary,
          body,
          // A mention is somebody asking you something; the rest is news.
          urgency: c.kind === "mention" ? 2 : 1,
          goto: { kind: "card", id: c.id, label: c.label },
        });
        return;
      }
      if (frame.type === "ci") {
        /*
         * Only the pull requests that are about to merge, unless told
         * otherwise. A suite finishing is news whose weight depends entirely on
         * where the pull request is — on something half-written it is a status
         * line, on something approved it is the last thing between you and
         * merging. See ciNotifyPref.ts; the switch is in Settings.
         */
        if (!ciShouldNotify(frame.data)) return;
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
          // Clickable. The verdict has always known which pull request it is
          // about; the note simply had nowhere to put it, so a list of PR
          // results was a list of dead ends.
          goto: { kind: "pr", repo: v.repo, number: v.number },
        });
        return;
      }
      if (frame.type === "initial") {
        // openTools seeds the per-agent "running" state for sessions whose
        // calls have already aged out of the buffer, and it rides on the same
        // first frame — so it is read before the events, not instead of them.
        setOpenTools(frame.openTools ?? []);
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
      // `session` frames fall through on purpose. They were announced on a
      // `sessionBus` for the browser companion, whose polls were tuned for
      // battery rather than for truth; the cockpit's Sessions panel fetches its
      // own roll-ups on its own clock and never subscribed. With the companion
      // deleted the bus had one publisher and no listeners — several fan-outs a
      // second into an empty Set on this socket's hot path — so both went.
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
    /**
     * The network came back. Don't sit out a slow retry over it.
     *
     * Distinct from the visibility path, which covers a tab returning from the
     * background: this covers a tab nobody has touched — laptop resumed, wifi
     * reconnected, VPN back — where nothing about the tab has changed and the
     * only news is that the machine can reach things again.
     */
    const onOnline = () => {
      if (disposed.current || connRef.current === "open" || connRef.current === "unauthorized") return;
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
      retry.current = 0;
      firstFailAt.current = 0;
      connect();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onOnline);
    window.addEventListener("agentglass:server-changed", onServerChanged);
    return () => {
      disposed.current = true;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("agentglass:server-changed", onServerChanged);
      if (timer.current) clearTimeout(timer.current);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect, flush]);

  return { events, conn, lastEvent, openTools };
}
