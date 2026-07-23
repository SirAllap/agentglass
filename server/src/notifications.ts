/**
 * Desktop notifications, mirrored onto the workspace notch.
 *
 * Why this exists: agentglass is a fullscreen daily driver. A Slack ping fires
 * a system notification you never see, because the thing covering your screen
 * is this app. The notch is the one strip that is always visible, so it is
 * where that ping should land.
 *
 * How: every desktop notification on Linux is a D-Bus method call. Apps call
 * `Notify` on org.freedesktop.Notifications (Slack, being Electron, does
 * exactly this) and GTK apps call `AddNotification` on org.gtk.Notifications.
 * We ask the session bus to make us a *monitor* for those two calls and read
 * them as they fly past. We never become the notification daemon and never
 * answer a call, so the user's normal pop-ups keep working exactly as they did
 * — this is a copy, not an interception.
 *
 * Nothing here runs unless a client is subscribed, and the UI only subscribes
 * when the user has turned the feature on. Nothing is ever written to disk.
 */

import { spawn, type Subprocess } from "bun";
import { existsSync } from "node:fs";

export type SystemNote = {
  /** Stable within a session; used to key the UI's queue and to name the note
   *  again when the UI asks to open its link. */
  id: string;
  app: string;
  summary: string;
  body: string;
  /** freedesktop urgency: 0 low, 1 normal, 2 critical. */
  urgency: 0 | 1 | 2;
  at: number;
  /**
   * The first http(s) link in the notification's own text, when it has one.
   *
   * This is the honest half of "take me there". The real click-through belongs
   * to the app that posted the notification -- the daemon signals it back and
   * the app opens the right conversation -- and a monitor cannot invoke that
   * without becoming the daemon. But a great many notifications simply carry
   * the link in their text, and opening that lands you in the same place.
   * When there is no link the UI offers nothing, rather than a button that
   * pretends.
   */
  url?: string;
};

export type NotifyCapability = { supported: boolean; reason?: string };

// ---------------------------------------------------------------------------
// Capability
//
// Probed once and answered as a plain { supported, reason }. Every caller
// treats an unsupported host as "the feature is absent", never as an error --
// there is deliberately no code path where a machine that cannot do this
// throws instead of simply going without.
// ---------------------------------------------------------------------------

let cached: NotifyCapability | null = null;

export function notifyCapability(): NotifyCapability {
  if (cached) return cached;
  cached = probe();
  return cached;
}

function probe(): NotifyCapability {
  if (process.platform !== "linux") {
    // macOS has no public API for reading other apps' notifications, and
    // Windows' UserNotificationListener needs a packaged app plus a consent
    // prompt. Both are a straight "not here" rather than a broken feature.
    return { supported: false, reason: `not available on ${process.platform} — this needs a D-Bus session bus` };
  }
  const addr = process.env.DBUS_SESSION_BUS_ADDRESS;
  const fallback = `/run/user/${process.getuid?.() ?? ""}/bus`;
  if (!addr && !existsSync(fallback)) {
    return { supported: false, reason: "no D-Bus session bus (headless, SSH or a container)" };
  }
  if (!Bun.which("dbus-monitor")) {
    return { supported: false, reason: "dbus-monitor not found — install your distro's dbus package" };
  }
  return { supported: true };
}

// ---------------------------------------------------------------------------
// Parsing dbus-monitor
//
// Its output is not a serialisation format and does not pretend to be one, so
// the parser is written against what it actually emits, verified against real
// notifications rather than the man page:
//
//   - Embedded quotes are NOT escaped:  string "He said "hi""
//   - Strings keep raw newlines, so a two-line Slack message spans two lines
//     of output with no continuation marker
//   - Nothing is truncated, and emoji/markup pass through untouched
//
// So: split on the block header, treat lines at exactly three spaces of indent
// as the top-level arguments, and let a string argument run until the next
// such line. Trailing quote is stripped at the end rather than matched, which
// is the only way to survive an unescaped quote inside the value.
// ---------------------------------------------------------------------------

type Block = {
  member: string;
  /** Top-level arguments, in call order, as raw text ("Slack", "0", "-1"). */
  args: string[];
  /** Every `dict entry(key, value)` found anywhere in the block, flattened. */
  dict: Map<string, string>;
};

const HEADER = /^(?:method call|signal|method return|error)\s/;
const TOP_ARG = /^ {3}(string|uint32|int32|int64|uint64|boolean|byte|double|array|variant|object path|signature)\b/;

export function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!HEADER.test(lines[i]!)) { i++; continue; }
    const member = /member=(\S+)/.exec(lines[i]!)?.[1] ?? "";
    i++;
    const body: string[] = [];
    while (i < lines.length && !HEADER.test(lines[i]!)) { body.push(lines[i]!); i++; }
    out.push({ member, ...parseArgs(body) });
  }
  return out;
}

function parseArgs(lines: string[]): { args: string[]; dict: Map<string, string> } {
  const args: string[] = [];
  const dict = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // A dict entry can sit at any depth; the key is on one line and its value
    // on the next. This is how both the freedesktop hints (urgency, and the
    // x-shell-sender marker we dedup on) and the whole GTK payload arrive.
    if (/^\s*dict entry\(/.test(line)) {
      const k = strOf(lines[i + 1] ?? "");
      const v = lines[i + 2] ?? "";
      if (k !== null) dict.set(k, v.replace(/^\s*variant\s*/, "").trim());
      continue;
    }

    if (!TOP_ARG.test(line)) continue;

    const m = /^ {3}string "(.*)$/s.exec(line);
    if (!m) {
      // A non-string scalar, or the opening of an array we don't need to
      // flatten (its dict entries are picked up by the branch above).
      args.push(line.trim().replace(/^\S+\s*/, "").replace(/\s*\[$/, ""));
      continue;
    }
    // Run to the next top-level argument: the value may span raw newlines.
    let value = m[1]!;
    let j = i + 1;
    while (j < lines.length && !TOP_ARG.test(lines[j]!) && !/^\s*(array|dict entry)/.test(lines[j]!)) {
      value += "\n" + lines[j]!;
      j++;
    }
    i = j - 1;
    args.push(value.replace(/"\s*$/, ""));
  }
  return { args, dict };
}

const strOf = (line: string): string | null => /^\s*string "(.*)"\s*$/.exec(line)?.[1] ?? null;

/** Turn one parsed block into a note, or null if it isn't one we surface. */
export function noteFrom(b: Block): Omit<SystemNote, "id" | "at"> | null {
  // The daemon re-dispatches every notification to the shell, so each one
  // crosses the bus twice. The forwarded copy is identical except that it
  // carries these two hints — which makes them the cheapest possible dedup,
  // and an exact one rather than a heuristic.
  if (b.dict.has("x-shell-sender") || b.dict.has("x-shell-sender-pid")) return null;

  if (b.member === "Notify") {
    // Notify(app_name, replaces_id, app_icon, summary, body, actions, hints, timeout)
    const [app = "", , , summary = "", body = ""] = b.args;
    if (!summary && !body) return null;
    const u = Number(/(\d+)/.exec(b.dict.get("urgency") ?? "")?.[1] ?? 1);
    return { app, summary, body, urgency: (u === 0 || u === 2 ? u : 1) as 0 | 1 | 2 };
  }

  if (b.member === "AddNotification") {
    // GTK apps: AddNotification(app_id, id, a{sv}) with title/body in the dict.
    const app = b.args[0] ?? "";
    const summary = strOf(" " + (b.dict.get("title") ?? "")) ?? unquote(b.dict.get("title"));
    const body = strOf(" " + (b.dict.get("body") ?? "")) ?? unquote(b.dict.get("body"));
    if (!summary && !body) return null;
    return { app, summary, body, urgency: 1 };
  }

  return null;
}

/**
 * The first http(s) URL in the text, trimmed of the punctuation that sentences
 * put after a link. Deliberately conservative: a wrong link is worse than no
 * link, because the button silently takes you somewhere else.
 */
export function urlIn(text: string): string | undefined {
  const m = /https?:\/\/[^\s<>"'()]+/.exec(text);
  if (!m) return undefined;
  const raw = m[0].replace(/[.,;:!?]+$/, "");
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch { return undefined; }
}

const unquote = (v: string | undefined): string =>
  (v ?? "").replace(/^\s*string\s*/, "").replace(/^"/, "").replace(/"$/, "").trim();

// ---------------------------------------------------------------------------
// The watch itself
//
// Reference-counted: the monitor process starts when the first subscriber
// arrives and is killed when the last one leaves. With the feature off in the
// UI nobody ever subscribes, so nothing is ever spawned and nothing is read.
// ---------------------------------------------------------------------------

const MATCHES = [
  "type='method_call',interface='org.freedesktop.Notifications',member='Notify'",
  "type='method_call',interface='org.gtk.Notifications',member='AddNotification'",
];

/** Identical notifications this close together are the same one arriving by a
 *  second route — belt to x-shell-sender's braces, for desktops that forward
 *  without the marker. */
const DEDUP_MS = 1500;

/** How long a still-incomplete block may sit before the stream going quiet is
 *  taken to mean the block is complete and it is flushed. dbus delivers a
 *  message atomically enough that a short gap means it is done — long enough not
 *  to split one across reads, short enough that a single notification with
 *  nothing after it is not held hostage to the next one arriving. */
const IDLE_FLUSH_MS = 250;

/** Backoff for respawning the monitor after it dies on its own. */
const RESTART_MIN_MS = 500;
const RESTART_MAX_MS = 30_000;
const RESTART_HEALTHY_MS = 10_000; // ran at least this long → healthy, reset backoff

const subs = new Set<(n: SystemNote) => void>();
let proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
let seq = 0;
let restartDelay = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const recent = new Map<string, number>();
/** noteId -> url, for the notes we ourselves emitted. Bounded; insertion
 *  ordered, so the oldest falls off first. */
const openable = new Map<string, string>();

/**
 * Open a note's link in the user's normal browser.
 *
 * Keyed by note id rather than taking a URL, so the caller can only ever open
 * something this process already saw on the bus. The platform opener is the
 * portable part -- xdg-open, `open`, `start` -- and an unknown platform simply
 * declines instead of guessing.
 */
export function openNote(id: unknown): { ok: boolean; error?: string } {
  const url = typeof id === "string" ? openable.get(id) : undefined;
  if (!url) return { ok: false, error: "no such notification, or it has no link" };
  const cmd =
    process.platform === "darwin" ? ["open", url] :
    process.platform === "win32" ? ["cmd", "/c", "start", "", url] :
    ["xdg-open", url];
  try {
    spawn({ cmd, stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function subscribeNotifications(fn: (n: SystemNote) => void): () => void {
  subs.add(fn);
  start();
  return () => {
    subs.delete(fn);
    if (!subs.size) stop();
  };
}

/** Live only while someone is listening — surfaced by /health for debugging. */
export const notifyWatching = (): boolean => proc !== null;

function emit(n: SystemNote) {
  for (const fn of subs) {
    try { fn(n); } catch { /* one bad subscriber must not kill the feed */ }
  }
}

function start() {
  if (proc || !notifyCapability().supported) return;
  try {
    proc = spawn({
      cmd: ["dbus-monitor", "--session", ...MATCHES],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (e) {
    console.warn("notifications: could not start dbus-monitor —", e);
    proc = null;
    return;
  }
  void pump(proc);
}

function stop() {
  proc?.kill();
  proc = null;
  recent.clear();
  // A death we caused is not a death to back off from: cancel any pending
  // respawn so turning the feature off actually leaves it off.
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  restartDelay = 0;
}

/**
 * Bring the monitor back after it exited unexpectedly, with backoff.
 *
 * A dbus-monitor that dies the instant it spawns — no bus, a rejected match
 * rule — would otherwise be respawned in a tight loop that pins a core doing
 * nothing. Each quick death grows the delay; a monitor that ran long enough to
 * be healthy resets it, so a genuine one-off crash still comes back promptly.
 */
function scheduleRestart(startedAt: number): void {
  if (!subs.size) return; // nobody listening — leave it stopped
  const ranMs = Date.now() - startedAt;
  restartDelay = ranMs >= RESTART_HEALTHY_MS ? 0 : Math.min(RESTART_MAX_MS, Math.max(RESTART_MIN_MS, restartDelay * 2));
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => { restartTimer = null; if (subs.size && !proc) start(); }, restartDelay);
  restartTimer.unref?.();
}

/**
 * Read the monitor's stdout and turn it into notes.
 *
 * Buffered by block, not by chunk: a notification's text can span many lines
 * and arrive across several reads, so we hold everything up to the last
 * complete block and leave the tail for the next chunk.
 */
async function pump(p: Subprocess<"ignore", "pipe", "pipe">) {
  const startedAt = Date.now();
  const dec = new TextDecoder();
  let buf = "";
  let idle: ReturnType<typeof setTimeout> | null = null;
  const clearIdle = () => { if (idle) { clearTimeout(idle); idle = null; } };

  // Turn a run of completed block text into emitted notes. Factored out so the
  // per-chunk parse, the idle flush and the end-of-stream flush all share one
  // dedup/emit path.
  const drain = (text: string) => {
    for (const block of parseBlocks(text)) {
      const n = noteFrom(block);
      if (!n) continue;
      const key = `${n.app}\u0000${n.summary}\u0000${n.body}`;
      const now = Date.now();
      const prev = recent.get(key);
      if (prev && now - prev < DEDUP_MS) continue;
      recent.set(key, now);
      if (recent.size > 200) for (const [k, t] of recent) if (now - t > DEDUP_MS) recent.delete(k);
      const note: SystemNote = {
        ...n,
        id: `sys-${++seq}`,
        at: now,
        url: urlIn(`${n.summary}\n${n.body}`),
      };
      // Remembered so "open" can name a note instead of passing a URL: the
      // UI never gets to say *what* to open, only *which of ours*. A page
      // that got hold of the port still cannot turn this into a launcher.
      if (note.url) {
        openable.set(note.id, note.url);
        if (openable.size > 100) openable.delete(openable.keys().next().value!);
      }
      emit(note);
    }
  };

  try {
    for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
      clearIdle();
      buf += dec.decode(chunk, { stream: true });
      // Everything up to the last block header is complete and safe to parse now.
      const lastHeader = buf.lastIndexOf("\nmethod call ");
      if (lastHeader >= 0) {
        drain(buf.slice(0, lastHeader + 1));
        buf = buf.slice(lastHeader + 1);
      } else if (buf.length > 1_000_000) {
        buf = ""; // a header we never recognised — don't grow without bound
      }
      // Whatever remains is the last block, held because its text can span reads.
      // A single-dispatch notification is the whole one there is, so no next
      // header ever comes to push it out — it used to sit here forever. Flush it
      // once the stream goes quiet, which for a lone ping is immediately.
      if (buf) { idle = setTimeout(() => { idle = null; const t = buf; buf = ""; drain(t); }, IDLE_FLUSH_MS); idle.unref?.(); }
    }
  } catch { /* the process was killed, which is how we stop it */ }
  clearIdle();
  if (buf) drain(buf); // clean end of stream: flush the tail we were holding

  if (proc === p) { proc = null; scheduleRestart(startedAt); } // died on its own: retry, with backoff
}
