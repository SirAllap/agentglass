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
  /**
   * Somewhere in THIS app the note is about.
   *
   * A mirrored desktop notification can only offer the link it came with, which
   * leaves the app. Our own notes usually know an in-app destination and had no
   * way to say so, so seventeen rows about pull requests were seventeen rows
   * you could not click. Only kinds this app can actually reach belong here.
   */
  goto?: { kind: "pr"; repo: string; number: number };
};
export type NotifyCapability = {
  supported: boolean;
  reason?: string;
  /**
   * We never got an answer — the server was unreachable or declined to say.
   *
   * Different from `supported: false`, which is a verdict about this machine and
   * stands for the session. This one means "ask again": the desktop shell starts
   * its server a beat after the window, so the first probe of a cold start can
   * land before anything is listening.
   */
  transient?: boolean;
};

const KEY = "agentglass.sysNotify";
/** The detail level to come back to when the switch is turned on again, so
 *  "off for an hour" does not quietly cost you the choice between "who wrote"
 *  and "what they said". */
const DETAIL_KEY = "agentglass.sysNotify.detail";

/** Off unless asked for. Reading every notification you receive is not a
 *  default anyone should be opted into. */
export function sysNotifyMode(): SysNotifyMode {
  const v = localStorage.getItem(KEY);
  return v === "full" || v === "titles" ? v : "off";
}

export function setSysNotifyMode(m: SysNotifyMode) {
  localStorage.setItem(KEY, m);
  if (m !== "off") localStorage.setItem(DETAIL_KEY, m);
  for (const fn of modeListeners) fn(m);
  retune();
}

/**
 * The plain on/off half of the same preference.
 *
 * Three states is the right answer to "how much of the message do I want on my
 * screen" and the wrong answer to "do I get my machine's notifications in here
 * at all" — which is the question anyone actually arrives with, and the one the
 * tri-state made you answer by picking a word. So the switch is a switch, and
 * the detail is a second, smaller decision underneath it.
 */
export const sysNotifyOn = (): boolean => sysNotifyMode() !== "off";

export function setSysNotifyOn(on: boolean) {
  if (!on) return setSysNotifyMode("off");
  const back = localStorage.getItem(DETAIL_KEY);
  setSysNotifyMode(back === "titles" ? "titles" : "full");
}

const modeListeners = new Set<(m: SysNotifyMode) => void>();
export function subscribeSysNotifyMode(fn: (m: SysNotifyMode) => void): () => void {
  modeListeners.add(fn);
  return () => modeListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// agentglass's own notifications.
//
// The other half of the same switchboard. Everything above is about other
// people's apps; this is about ours — a chat that finished, a branch that fell
// behind, a build that went red. They share one surface on purpose, so they
// need to be silenceable separately or "stop interrupting me" means giving up
// the thing you installed this for.
//
// Two deliberate limits, both of which the hint in Settings says out loud:
//
//   - Off stops them INTERRUPTING, not being collected. The bell keeps the full
//     list either way, exactly as `quiet` does for the mirrored ones.
//   - A held tool call is not covered. It cannot be caught up on later — the
//     hold expires on its own while an agent sits there waiting — so it is the
//     one thing that still speaks with this off. Anything else can wait for you
//     to look.
// ---------------------------------------------------------------------------

const APP_KEY = "agentglass.appNotify";

/** On unless turned off: these are the app's own events, and someone running a
 *  fleet cockpit installed it to be told about them. */
export function appNotify(): boolean {
  return localStorage.getItem(APP_KEY) !== "0";
}

export function setAppNotify(on: boolean) {
  localStorage.setItem(APP_KEY, on ? "1" : "0");
  for (const fn of appListeners) fn(on);
}

const appListeners = new Set<(on: boolean) => void>();
export function subscribeAppNotify(fn: (on: boolean) => void): () => void {
  appListeners.add(fn);
  return () => appListeners.delete(fn);
}

/**
 * May one of agentglass's own events interrupt right now?
 *
 * The rule lives here, in one line, rather than inside the component that draws
 * the toast — because it is a rule about the product and not about a strip of
 * bar, and because the exception is the kind that gets quietly refactored away
 * by someone tidying a condition they do not have the context for.
 *
 * `urgent` means something is STOPPED until you act: a tool call held at the
 * gate, a chat that cannot continue. Those speak with the switch off. Everything
 * else — a turn that finished, commits to pull, checks that went green — waits
 * for you in the bell.
 */
export const shouldInterrupt = (urgent: boolean): boolean => urgent || appNotify();

// ---------------------------------------------------------------------------
// Quiet.
//
// agentglass reads notifications off the bus instead of being the daemon, so
// the desktop's own Do Not Disturb has no effect on what lands here. That is
// deliberate and it is what makes gate alerts reliable -- but it also means
// the feature ignores the one instruction you gave your machine about being
// interrupted. Verified: with DND on, WhatsApp messages the desktop silently
// queued were still put on the notch, body and all.
//
// So agentglass gets its own switch rather than trying to read the system's.
// There is no portable way to read that state (GetServerInformation returns a
// name, not a state; `Inhibited` is a KDE convention absent elsewhere), and
// six per-daemon adapters to infer something you can simply say directly is a
// bad trade.
//
// Quiet stops mirrored notes from *interrupting*. It does not stop them being
// collected: they keep landing in the history behind the notch, so nothing is
// lost and you can look when you choose to. And it deliberately cannot reach
// agentglass's own alerts -- a gate hold does not travel this path at all (see
// gateStore.ts), so "quiet" can never mean "an agent blocked and nobody said".
// That separation is the whole point of having the switch here rather than one
// level up.
// ---------------------------------------------------------------------------

const QUIET_KEY = "agentglass.sysNotify.quiet";

export function notifyQuiet(): boolean {
  return localStorage.getItem(QUIET_KEY) === "1";
}

export function setNotifyQuiet(q: boolean) {
  localStorage.setItem(QUIET_KEY, q ? "1" : "0");
  for (const fn of quietListeners) fn(q);
}

const quietListeners = new Set<(q: boolean) => void>();
export function subscribeNotifyQuiet(fn: (q: boolean) => void): () => void {
  quietListeners.add(fn);
  return () => quietListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Capability.
//
// Asked once and never allowed to reject: a host that cannot do this is a host
// where the feature is absent, not one where something failed.
//
// The distinction that matters, and that this did not use to make: "this
// machine has no notification bus" is an ANSWER, and worth remembering for the
// session. "I could not reach the server to ask" is not an answer at all, and
// caching it is how the feature died on a cold start.
//
// Measured on the desktop app: the window comes up at 15:50:17 and the server
// sidecar is listening at 15:51:21. The renderer's first probe lands in that
// gap, gets a network error, and the cached "unavailable — server unreachable"
// then outlived the server that had since started. The switch read as ON,
// Settings read as unavailable, and nothing was watching the bus — the exact
// shape of the original complaint, one layer down.
// ---------------------------------------------------------------------------

let capPromise: Promise<NotifyCapability> | null = null;

export function notifyCapability(): Promise<NotifyCapability> {
  capPromise ??= probeCapability();
  return capPromise;
}

async function probeCapability(): Promise<NotifyCapability> {
  try {
    const r = await fetch(SERVER + "/notifications/capability", { headers: authHeaders() });
    // A non-2xx here is the server declining to say — an auth token that is not
    // configured yet, a route from an older build. Also not an answer about
    // this machine.
    if (!r.ok) return unanswered(`the server replied ${r.status}`);
    return (await r.json()) as NotifyCapability;
  } catch {
    return unanswered("the server was not reachable when we asked");
  }
}

/** Not a verdict: drop the cache so the next caller asks again. */
function unanswered(reason: string): NotifyCapability {
  capPromise = null;
  return { supported: false, transient: true, reason };
}

/** Tests only — the probe is a module singleton and each case needs a fresh one. */
export function __resetNotifyCapability() {
  capPromise = null;
  // Tear down the socket machinery too, not just the cached probe. A test that
  // armed the backoff (retune → fail → scheduleReopen) left `retryTimer` live;
  // it fired in a later test, drove a probe through the shared `fetch` mock, and
  // made an unrelated assertion about the ask count flake. Reset every piece of
  // async state so nothing outlives the test that created it.
  retry = 0;
  opening = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  ws = null;
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
/**
 * Raise one of agentglass's OWN alerts as a native OS notification.
 *
 * The cross-platform half of #192: `notify-send` only exists on Linux, but the
 * Notification API is routed to the OS by Electron on macOS and Windows too (and
 * works in a browser tab that has been granted permission). The server owns the
 * opt-in (AGENTGLASS_NOTIFY) and only broadcasts these while a client is
 * attached, so this just surfaces what it is handed. Fires only when permission
 * is already granted — which Electron does by default for the app — so it never
 * pops a permission prompt off the back of an incoming socket frame.
 */
export function fireDesktopAlert(a: { title: string; body: string }) {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted") new Notification(a.title, { body: a.body });
  } catch {
    /* a host without Notification support — the notch still has it */
  }
}

export function recordNote(n: { app: string; summary: string; body: string; urgency?: 0 | 1 | 2; goto?: SystemNote["goto"] }) {
  const note: SystemNote = {
    id: `app-${++localSeq}`,
    app: n.app,
    summary: n.summary,
    body: n.body,
    urgency: n.urgency ?? 1,
    at: Date.now(),
    ...(n.goto ? { goto: n.goto } : {}),
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

/**
 * Claimed before the capability probe is awaited, not after.
 *
 * `ws` alone could not guard this: opening is asynchronous, so two callers
 * arriving while the probe was in flight both saw `ws === null`, both passed,
 * and both opened a socket. The server then delivered every notification twice
 * — two toasts for one Slack message, and two rows in the bell — which read as
 * the desktop sending duplicates rather than as this racing itself. It happens
 * on every cold start: the module retunes on load and the first subscriber
 * retunes on mount, and those two are milliseconds apart.
 */
let opening = false;

async function open() {
  if (ws || retryTimer || opening) return;
  opening = true;
  try {
    const cap = await notifyCapability();
    if (!cap.supported) {
      // Giving up here is right for a machine with no notification bus and
      // wrong for a server that had not finished starting — and the second one
      // leaves the switch reading ON with nothing watching, silently, until the
      // app is restarted. So: a verdict stops, a non-answer comes back.
      if (cap.transient) scheduleReopen();
      return;
    }
    // Re-read everything the await could have changed: the feature may have been
    // switched off while the probe was in flight, and a socket may have been
    // opened by the caller that lost this race.
    if (!wanted() || ws) return;
    attach();
  } finally {
    opening = false;
  }
}

/**
 * Come back and try again, with the same backoff a dropped socket uses.
 *
 * Shared deliberately: "the server is not up yet" and "the server went away"
 * are the same situation from here, and they were drifting apart as two copies
 * of the same delay calculation.
 */
function scheduleReopen() {
  if (retryTimer || !wanted()) return;
  const delay = Math.min(30_000, 1000 * 2 ** retry++);
  retryTimer = setTimeout(() => { retryTimer = null; retune(); }, delay);
}

function attach() {
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
    // Collected either way; only the interruption is optional. Quiet means the
    // notch does not morph open for someone else's message, not that agentglass
    // stopped listening -- the list behind the notch is still complete.
    if (!notifyQuiet()) for (const fn of noteListeners) fn(n);
  };
  sock.onopen = () => { retry = 0; };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    // Backing off rather than hammering: the common reason for a close is that
    // the server went away, and it is not coming back any faster for being
    // asked every second.
    scheduleReopen();
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
