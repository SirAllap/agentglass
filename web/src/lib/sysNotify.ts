import { SERVER, withToken, authHeaders } from "./api.ts";

/**
 * Desktop notifications, mirrored onto the notch.
 *
 * The server does the reading (it monitors the D-Bus session bus); this is the
 * client half: a preference, a capability probe, and a socket that only exists
 * while the preference says it should.
 *
 * Three states rather than a toggle, because "show me that Slack pinged me"
 * and "show me what they said on my screen while I share it" are different
 * answers. Nothing here is ever persisted beyond the preference itself — the
 * notes live in memory for the few seconds the notch shows them.
 */

export type SysNotifyMode = "off" | "titles" | "full";
export type SystemNote = {
  id: string;
  app: string;
  summary: string;
  body: string;
  urgency: 0 | 1 | 2;
  at: number;
  /** Present when the notification's own text carried a link. */
  url?: string;
};
export type NotifyCapability = { supported: boolean; reason?: string };

const KEY = "agentglass.sysNotify";

/** Off unless asked for. Reading every notification you receive is not a
 *  default anyone should be opted into. */
export function sysNotifyMode(): SysNotifyMode {
  const v = localStorage.getItem(KEY);
  return v === "full" || v === "titles" ? v : "off";
}

export function setSysNotifyMode(m: SysNotifyMode) {
  localStorage.setItem(KEY, m);
  for (const fn of modeListeners) fn(m);
  retune();
}

const modeListeners = new Set<(m: SysNotifyMode) => void>();
export function subscribeSysNotifyMode(fn: (m: SysNotifyMode) => void): () => void {
  modeListeners.add(fn);
  return () => modeListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Capability. Asked once, cached, and never allowed to reject: a host that
// cannot do this is a host where the feature is absent, not one where
// something failed.
// ---------------------------------------------------------------------------

let capPromise: Promise<NotifyCapability> | null = null;

export function notifyCapability(): Promise<NotifyCapability> {
  capPromise ??= fetch(SERVER + "/notifications/capability", { headers: authHeaders() })
    .then((r) => (r.ok ? (r.json() as Promise<NotifyCapability>) : { supported: false, reason: "server does not support it" }))
    .catch(() => ({ supported: false, reason: "server unreachable" }));
  return capPromise;
}

// ---------------------------------------------------------------------------
// The socket. Opening it is what starts the server's monitor, so it stays shut
// while the mode is "off" — the feature being off means nothing is watching,
// not that something is watching quietly.
// ---------------------------------------------------------------------------

const noteListeners = new Set<(n: SystemNote) => void>();
let ws: WebSocket | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// History.
//
// A toast is gone in five seconds, which is fine for "something happened" and
// useless for "what was it again". This is the list behind the notch: the last
// few dozen, newest first, in memory only.
//
// Deliberately not persisted. The whole feature reads every notification you
// receive; writing those bodies to disk would turn an ambient mirror into a
// log of your messages that outlives the session. It dies with the page.
// ---------------------------------------------------------------------------

const HISTORY_MAX = 60;
let history: SystemNote[] = [];
let unread = 0;
const historyListeners = new Set<() => void>();

export const notifyHistory = (): SystemNote[] => history;
export const notifyUnread = (): number => unread;

export function subscribeNotifyHistory(fn: () => void): () => void {
  historyListeners.add(fn);
  return () => historyListeners.delete(fn);
}

function historyChanged() {
  for (const fn of historyListeners) fn();
}

/**
 * Record something agentglass itself raised — a chat that finished, a branch
 * that fell behind — into the same history the mirrored ones land in.
 *
 * They share the notch's toast lane already, so they should share its memory:
 * a toast holds "3755 commits to pull" for five seconds and is then gone, and
 * the number was the whole message. One inbox, whatever raised it.
 */
export function recordNote(n: { app: string; summary: string; body: string; urgency?: 0 | 1 | 2 }) {
  const note: SystemNote = {
    id: `app-${++localSeq}`,
    app: n.app,
    summary: n.summary,
    body: n.body,
    urgency: n.urgency ?? 1,
    at: Date.now(),
  };
  history = [note, ...history].slice(0, HISTORY_MAX);
  unread++;
  historyChanged();
}
let localSeq = 0;

export function markNotifyRead() {
  if (!unread) return;
  unread = 0;
  historyChanged();
}

export function dismissNote(id: string) {
  history = history.filter((n) => n.id !== id);
  historyChanged();
}

export function clearNotes() {
  history = [];
  unread = 0;
  historyChanged();
}

/** Ask the server to open a note's link. It resolves the URL from the note it
 *  saw itself, so this can never be pointed at an arbitrary address. */
export async function openNote(id: string): Promise<boolean> {
  try {
    const r = await fetch(SERVER + "/notifications/open", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ id }),
    });
    return r.ok;
  } catch { return false; }
}

export function subscribeSystemNotes(fn: (n: SystemNote) => void): () => void {
  noteListeners.add(fn);
  retune();
  return () => {
    noteListeners.delete(fn);
    retune();
  };
}

/**
 * Whether the socket should be open.
 *
 * The mode alone decides it -- deliberately not "and something is listening".
 * The notch only exists while the workspace overlay is open, so tying the
 * socket to it meant agentglass stopped watching the moment you looked at the
 * dashboard, and a Slack ping in that window was lost with nothing to show it
 * had ever happened. On means on, for as long as the app is running; the notch
 * is just the thing that displays what the store already collected.
 */
function wanted(): boolean {
  return sysNotifyMode() !== "off";
}

function retune() {
  if (wanted()) void open();
  else close();
}

async function open() {
  if (ws || retryTimer) return;
  const cap = await notifyCapability();
  if (!cap.supported || !wanted()) return;

  const sock = new WebSocket(withToken(SERVER.replace(/^http/, "ws") + "/notifications"));
  ws = sock;
  sock.onmessage = (ev) => {
    let n: SystemNote;
    try { n = JSON.parse(String(ev.data)) as SystemNote; } catch { return; }
    // Applied here rather than on the server so the choice is the viewer's and
    // takes effect the instant it is changed, without a reconnect.
    if (sysNotifyMode() === "titles") n = { ...n, body: "" };
    history = [n, ...history].slice(0, HISTORY_MAX);
    unread++;
    historyChanged();
    for (const fn of noteListeners) fn(n);
  };
  sock.onopen = () => { retry = 0; };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (!wanted()) return;
    // Backing off rather than hammering: the common reason for a close is that
    // the server went away, and it is not coming back any faster for being
    // asked every second.
    const delay = Math.min(30_000, 1000 * 2 ** retry++);
    retryTimer = setTimeout(() => { retryTimer = null; retune(); }, delay);
  };
  sock.onerror = () => { /* onclose does the recovery */ };
}

function close() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const sock = ws;
  ws = null;
  sock?.close();
}

// Connect as soon as this module is loaded, if the preference says so, rather
// than waiting for something to subscribe. Off still means off: retune() opens
// nothing unless the mode allows it, so the D-Bus monitor stays unspawned.
retune();
