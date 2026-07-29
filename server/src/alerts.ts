// Push alerts: fire on notable events (human-in-the-loop waits, errors).
// Delivery channels are opt-in via env:
//   AGENTGLASS_WEBHOOK   — POST {text} to this URL (Slack/Discord-compatible)
//   AGENTGLASS_NOTIFY=1  — run `notify-send` (Linux desktop) if available
//
// Both of these leave the process, and neither is guaranteed to arrive. In
// particular `notify-send` hands the notification to the desktop's daemon,
// which is free to hold it: with Do Not Disturb on it is queued silently and
// the command still exits 0, so there is no failure for this file to see. That
// is fine for "an agent errored", and not fine for a gate hold, where an agent
// is stopped until a human answers. The durable route for those is in-app --
// web/src/lib/gateStore.ts raises every new hold onto the notch, which no
// desktop setting can suppress. Treat everything below as best-effort reach
// for when nobody is looking at agentglass at all.
import type { WatchEvent, AlertNote } from "../../shared/types.ts";
import { sendPush } from "./push.ts";
import { vapidKeys, subscriptions, removeSubscription, markDelivered } from "./pushstore.ts";

const WEBHOOK = process.env.AGENTGLASS_WEBHOOK;
const DESKTOP = process.env.AGENTGLASS_NOTIFY === "1";

// A connected client can raise a NATIVE OS notification, which Electron routes
// to macOS and Windows too — the cross-platform replacement for notify-send,
// which only exists on Linux. The server still owns the opt-in (AGENTGLASS_
// NOTIFY) and the triggers; the client just surfaces what it is handed.
// notify-send stays as the fallback for a headless server with no client.
export interface AlertSink {
  broadcast: (a: AlertNote) => void;
  hasClients: () => boolean;
}
let sink: AlertSink | null = null;
export function setAlertSink(s: AlertSink | null) { sink = s; }

// Both outbound channels leave the machine, so neither may fire from a test
// run. The gate test used to reach the real `notify-send`: `bun test` popped
// "✋ Approval needed — app:sess2 wants to run Bash: rm -rf something-unique-2"
// onto the desktop of whoever ran the suite, indistinguishable from a live
// agent asking to delete something. A webhook set in the environment would
// have been posted to Slack the same way. `bun test` sets NODE_ENV=test.
const IS_TEST = process.env.NODE_ENV === "test";

/**
 * The notify-send half of delivery, as a seam.
 *
 * Tests install one of these and assert on what the fallback WOULD have shown,
 * which is both safe and a stronger check than the absence of a broadcast.
 * Left unset in the app: `null` means the built-in `notify-send` below.
 */
export type DesktopNotifier = (a: AlertNote) => void;
let notifier: DesktopNotifier | null = null;
export function setDesktopNotifier(n: DesktopNotifier | null) { notifier = n; }

// Debounce identical alerts so a burst doesn't spam channels.
const lastSent = new Map<string, number>();
const DEBOUNCE_MS = 30_000;

function shouldSend(key: string): boolean {
  const now = Date.now();
  const prev = lastSent.get(key) ?? 0;
  if (now - prev < DEBOUNCE_MS) return false;
  lastSent.set(key, now);
  return true;
}

/**
 * Every phone that asked to be told, in parallel, best effort.
 *
 * This is the only channel that reaches a device with its screen off. The
 * others cannot: a webhook goes to a chat app, notify-send goes to a desktop
 * that may not exist, and the socket closes with the phone's screen on purpose.
 *
 * A push service answering 404 or 410 means that subscription is dead — the
 * user cleared site data, or the browser rotated it — so it is forgotten. Any
 * other failure is the service having a bad minute and the device is kept: an
 * over-eager prune would silently unsubscribe a working phone, and nobody would
 * find out until a gate went unanswered.
 */
export interface PushFanout {
  /** How many devices the push service accepted it for. */
  sent: number;
  /** How many refused for a reason that is not "this device is gone". */
  failed: number;
  /** How many were forgotten because the service said they no longer exist. */
  pruned: number;
}

export async function pushEveryone(
  title: string, body: string, urgency: 0 | 1 | 2,
): Promise<PushFanout> {
  const subs = subscriptions();
  const out: PushFanout = { sent: 0, failed: 0, pruned: 0 };
  if (!subs.length) return out;
  const keys = await vapidKeys();
  // `urgency` travels inside the encrypted payload as well as in the header.
  // The header is for the push service, which decides whether to wake the
  // radio; the field is for the service worker, which decides whether the
  // notification stays on screen until it is dealt with. Only one of the two
  // can read the body, and only one of the two can wake the device.
  const payload = new TextEncoder().encode(JSON.stringify({ title, body, at: Date.now(), urgency }));
  await Promise.all(subs.map(async (s) => {
    const r = await sendPush(s, payload, keys, {
      // A gate is worth waking the device for; a tool error is not.
      urgency: urgency === 2 ? "high" : "normal",
    });
    if (r.gone) { removeSubscription(s.endpoint); out.pruned++; }
    else if (r.ok) { markDelivered(s.endpoint); out.sent++; }
    else out.failed++;
  }));
  return out;
}

async function deliver(title: string, body: string, urgency: 0 | 1 | 2 = 2) {
  if (WEBHOOK && !IS_TEST) {
    try {
      await fetch(WEBHOOK, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `*${title}*\n${body}` }),
      });
    } catch (e) {
      console.warn("[alerts] webhook failed:", e);
    }
  }
  // Before the desktop branch and outside it: a phone is subscribed whether or
  // not AGENTGLASS_NOTIFY is on, and the desktop path returns early when a
  // client is attached — which would have skipped the phone entirely in the
  // one case where somebody is at the desk and the phone still wants to know.
  if (!IS_TEST) {
    // Never awaited: an unreachable push service must not hold up the
    // notification that is also going to the desktop.
    pushEveryone(title, body, urgency).catch((e) => console.warn("[alerts] push failed:", e));
  }

  if (DESKTOP) {
    // A connected client shows a native OS notification (cross-platform).
    // notify-send is the fallback only when nothing is attached to show it.
    if (sink?.hasClients()) {
      sink.broadcast({ title, body, urgency });
      return;
    }
    if (notifier) { notifier({ title, body, urgency }); return; }
    // No seam installed and this is a test run: say nothing. A suite must never
    // put an approval prompt on somebody's desktop for a hold that never
    // happened, and a test that wants to check this path installs a notifier.
    if (IS_TEST) return;
    try {
      Bun.spawn(["notify-send", "-a", "agentglass", "-u", "critical", "--", title, body], { stdout: "ignore" });
    } catch (e) {
      // Said once, not on every alert: the cause is a missing binary, so it
      // will be just as true the next thousand times and the log is the only
      // place anyone would find out. Silence here used to make "notify-send is
      // not installed" look exactly like "your ping was delivered".
      if (!warnedNoNotifySend) {
        warnedNoNotifySend = true;
        console.warn("[alerts] AGENTGLASS_NOTIFY=1 but notify-send could not be run:", e);
      }
    }
  }
}

let warnedNoNotifySend = false;

/** A tool call is being held at the control-plane gate — ping the human. */
export function pushGate(agent: string, tool: string, summary: string) {
  if (shouldSend(`gate:${agent}:${summary}`))
    deliver("✋ Approval needed", `${agent} wants to run ${tool}${summary ? `: ${summary.slice(0, 200)}` : ""} — approve or deny in agentglass.`);
}

/** Inspect an event and fire an alert if it warrants one. */
export function maybeAlert(e: WatchEvent) {
  const agent = `${e.source_app}:${e.session_id.slice(0, 8)}`;

  if (e.hook_event_type === "PermissionRequest") {
    if (shouldSend(`perm:${e.session_id}`))
      deliver("⏳ Approval needed", `${agent} is waiting on a permission request${e.tool_name ? ` (${e.tool_name})` : ""}.`);
    return;
  }
  if (e.hook_event_type === "Notification") {
    const msg = String((e.payload as any)?.message ?? "Agent notification");
    if (shouldSend(`notify:${e.session_id}:${msg}`)) deliver("🔔 " + agent, msg, 1);
    return;
  }
  if (e.is_error) {
    if (shouldSend(`err:${e.session_id}:${e.tool_name}`))
      deliver("❌ Tool error", `${agent} — ${e.tool_name ?? "tool"} failed${e.error_text ? `: ${e.error_text.slice(0, 200)}` : ""}.`);
  }
}
