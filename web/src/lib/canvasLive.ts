import type { CanvasFrame, CanvasOp } from "../../../shared/pluginCanvas.ts";
import { IS_DEMO, canvasWsUrl } from "./api.ts";
import { EMPTY_CANVAS, reduceCanvas, type CanvasState } from "./canvasState.ts";

/**
 * ONE WebSocket for every live canvas the window shows.
 *
 * Not one stream per panel: over plain HTTP/1 the browser allows six
 * connections per host, streams count against them and sockets do not, so a
 * plugin with several open canvases could have starved every fetch the window
 * makes. The socket opens when the first canvas mounts, closes when the last
 * one leaves, and every live subscription is sent again each time it opens, so
 * a reconnect costs the person nothing but a fresh snapshot.
 *
 * What a frame means is decided by canvasState.ts; this file only moves them.
 */

export type CanvasListener = (state: CanvasState, applied: CanvasOp[] | null) => void;

/** The parts of a WebSocket the hub uses, so a test can hand it a fake. */
export interface CanvasSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface HubDeps {
  open: () => CanvasSocket;
  timer?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
  now?: () => number;
}

const OPEN = 1;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_LAST_MS = 15_000;
/** A frame that does not follow is answered with a fresh subscribe, at most
 *  this often per canvas: a scene the window refuses must cost one snapshot a
 *  second, not one per frame. */
export const RESUBSCRIBE_EVERY_MS = 1_000;

/** 1s, 2s, 4s, 8s, then 15s for as long as it takes. */
export const backoffMs = (attempt: number): number => Math.min(BACKOFF_LAST_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempt));

interface Entry { plugin: string; panel: string; state: CanvasState; listeners: Set<CanvasListener>; lastSub: number; resubTimer: unknown }

const keyOf = (plugin: string, panel: string) => `${plugin}\u0000${panel}`;

export function createCanvasHub(deps: HubDeps) {
  const timer = deps.timer ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const now = deps.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let socket: CanvasSocket | null = null;
  let retry = 0;
  let retryTimer: unknown = null;

  const say = (type: "subscribe" | "unsubscribe", e: { plugin: string; panel: string }) => {
    if (socket?.readyState !== OPEN) return;
    try { socket.send(JSON.stringify({ type, plugin: e.plugin, panel: e.panel })); } catch { /* closing: onclose reconnects */ }
  };

  const subscribeNow = (e: Entry) => { e.lastSub = now(); say("subscribe", e); };
  const resubscribe = (e: Entry) => {
    if (e.resubTimer !== null) return;
    const wait = e.lastSub + RESUBSCRIBE_EVERY_MS - now();
    if (wait <= 0) { subscribeNow(e); return; }
    e.resubTimer = timer.set(() => { e.resubTimer = null; if (entries.get(keyOf(e.plugin, e.panel)) === e) subscribeNow(e); }, wait);
  };

  const onFrame = (raw: unknown) => {
    let frame: CanvasFrame;
    try { frame = JSON.parse(String(raw)) as CanvasFrame; } catch { return; }
    if (!frame || typeof frame.plugin !== "string" || typeof frame.panel !== "string") return;
    const e = entries.get(keyOf(frame.plugin, frame.panel));
    if (!e) return;
    const r = reduceCanvas(e.state, frame);
    e.state = r.state;
    for (const l of [...e.listeners]) l(r.state, r.applied);
    if (r.resubscribe) resubscribe(e);
  };

  const connect = () => {
    if (socket || entries.size === 0) return;
    const ws = deps.open();
    socket = ws;
    ws.onopen = () => {
      retry = 0;
      for (const e of entries.values()) subscribeNow(e);
    };
    ws.onmessage = (ev) => onFrame(ev.data);
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (entries.size === 0) return;
      retryTimer = timer.set(() => { retryTimer = null; connect(); }, backoffMs(retry++));
    };
  };

  const shutdown = () => {
    if (retryTimer !== null) { timer.clear(retryTimer); retryTimer = null; }
    const ws = socket;
    socket = null;
    retry = 0;
    if (ws) { ws.onclose = null; ws.close(); }
  };

  /** Follow one canvas. Returns the way to stop. A second follower of the same
   *  canvas is handed what is already known and costs the server nothing. */
  function subscribe(plugin: string, panel: string, onState: CanvasListener): () => void {
    const k = keyOf(plugin, panel);
    let e = entries.get(k);
    if (!e) {
      e = { plugin, panel, state: EMPTY_CANVAS, listeners: new Set(), lastSub: 0, resubTimer: null };
      entries.set(k, e);
      if (socket) subscribeNow(e); else connect();
    }
    e.listeners.add(onState);
    if (e.state.loaded || e.state.gone) onState(e.state, null);
    return () => {
      const cur = entries.get(k);
      if (!cur || !cur.listeners.delete(onState) || cur.listeners.size > 0) return;
      entries.delete(k);
      if (cur.resubTimer !== null) { timer.clear(cur.resubTimer); cur.resubTimer = null; }
      say("unsubscribe", cur);
      if (entries.size === 0) shutdown();
    };
  }

  return { subscribe, size: () => entries.size };
}

let shared: ReturnType<typeof createCanvasHub> | null = null;

/** The window's one hub. In the demo there is no server to dial, so a
 *  subscription there never hears anything. */
export function subscribeCanvas(plugin: string, panel: string, onState: CanvasListener): () => void {
  if (IS_DEMO) return () => {};
  shared ??= createCanvasHub({ open: () => new WebSocket(canvasWsUrl()) as unknown as CanvasSocket });
  return shared.subscribe(plugin, panel, onState);
}
