// Push alerts: fire on notable events (human-in-the-loop waits, errors).
// Delivery channels are opt-in via env:
//   AGENTGLASS_WEBHOOK   — POST {text} to this URL (Slack/Discord-compatible)
//   AGENTGLASS_NOTIFY=1  — run `notify-send` (Linux desktop) or `osascript` (macOS) if available
//
// A client attached to the live socket gets every alert regardless — that is
// the frame the desktop raises a native notification from, and the one the
// phone app turns into a local notification.
//
// Both of the env-gated ones leave the process, and neither is guaranteed to
// arrive. In particular `notify-send` hands the notification to the desktop's daemon,
// which is free to hold it: with Do Not Disturb on it is queued silently and
// the command still exits 0, so there is no failure for this file to see. That
// is fine for "an agent errored", and not fine for a gate hold, where an agent
// is stopped until a human answers. The durable route for those is in-app --
// web/src/lib/gateStore.ts raises every new hold onto the notch, which no
// desktop setting can suppress. Treat everything below as best-effort reach
// for when nobody is looking at agentglass at all.
import type { WatchEvent, AlertNote } from "../../shared/types.ts";
import { paneForSession, paneAgentNote } from "./panewt.ts";
import { listPanes } from "./tmuxctl.ts";

const WEBHOOK = process.env.AGENTGLASS_WEBHOOK;
const DESKTOP = process.env.AGENTGLASS_NOTIFY === "1";

// A connected client can raise a NATIVE OS notification, which Electron routes
// to macOS and Windows too — the cross-platform replacement for notify-send,
// which only exists on Linux. The server still owns the opt-in (AGENTGLASS_
// NOTIFY) and the triggers; the client just surfaces what it is handed.
// notify-send stays as the fallback for a server with nothing LISTENING —
// which is not the same as nothing attached, and used to be treated as if it
// were. See AlertSink.census.
export interface AlertSink {
  broadcast: (a: AlertNote) => void;
  /**
   * How many sockets are attached, and how many of those have PROVED in the
   * last few seconds that the process on the other end is still running.
   *
   * One snapshot rather than two predicates, because the two are read a line
   * apart and a socket can close in between; a caller that broadcast on the
   * first answer and suppressed the fallback on the second would be deciding
   * from two different moments.
   *
   * This replaced `hasClients(): boolean`, which meant `clients.size > 0` over
   * a Set pruned only when a socket says goodbye. A phone that Android freezes
   * says nothing at all — measured (Bun 1.3.9, `Bun.serve` shaped exactly like
   * index.ts): with the peer SIGSTOPped, `clients.size` stayed 1, `ws.send()`
   * returned 68 bytes written and never threw, `getBufferedAmount()` stayed 0,
   * and the socket was not closed until 120.1s. Two minutes of every alert
   * going into a frozen socket while the notify-send fallback below was
   * skipped because "a client is attached".
   */
  census: () => { attached: number; live: number };
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

/*
 * There was a fourth channel here: Web Push, a fan-out to every browser that
 * had subscribed, and the only one that reached a device with its screen off.
 * It is gone, along with `reach` — the second scale that said whether an alert
 * was worth waking a radio for, and the gate id that put Allow and Deny on the
 * notification.
 *
 * It went because nothing could subscribe to it any more. A service worker and
 * `PushManager` need a *secure context*, so a phone opening the QR link at
 * `http://192.168.x.x` has neither — the same measurement that killed the
 * browser companion (`crypto.subtle` is secure-context only, so the pairing
 * handshake could not start either), one layer down. The subscribe switch lived
 * in that companion, so after 86b07f7 there was no caller for the routes and no
 * registrar for the worker. The phone app that replaced it raises LOCAL
 * notifications from the `{type:"alert"}` frame on its own socket — the same
 * frame `sink.broadcast` hands the desk — with no push service in the path at
 * all. See mobile/src/notifications/notify.ts, which is honest about the cost:
 * Android freezes the process a while after the screen goes off, so that route
 * reaches a pocket for a while and not for ever.
 */
async function deliver(
  title: string, body: string, urgency: 0 | 1 | 2 = 2,
  /** Where the agent is, when it is in tmux. Only reaches an attached client:
   *  a phone cannot select a pane on this machine, and `notify-send` has
   *  nowhere to put it. */
  pane?: string,
  /** What kind of thing this is, when it is not ordinary news. Travels on the
   *  frame so the app can raise an alarm rather than another row. */
  extra?: { kind: "reminder"; id: string } | { kind: "understudy" },
) {
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
  // An attached client is not an operating-system side effect.
  //
  // `AGENTGLASS_NOTIFY` exists to gate `notify-send` — spawning a binary that
  // paints on somebody's desktop, which is a thing to opt into. Handing the
  // frame to a client that is already connected and already looking is not the
  // same act, and gating it behind the same flag meant a running app stayed
  // silent about the very things it was open to show. The user chose to have
  // this window, and the client asks the browser's own permission from a click
  // in Settings before anything native happens (`sysNotify.ts` →
  // `askNotifyPermission`). That sentence used to point at `sysNotify.ts:178`,
  // which is `shouldInterrupt` — a product rule about urgency with no
  // permission in it. Nothing asked, anywhere, until this was settled.
  //
  // ── attached is not listening ────────────────────────────────────────────
  // Two numbers, and they answer two different questions.
  //
  // ATTACHED decides who gets the frame. A frozen phone still gets it: the
  // bytes sit in its socket buffer and arrive when the process thaws —
  // measured, 4 frames queued during a 60s SIGSTOP were all delivered 570ms
  // after SIGCONT. Withholding them would lose a backlog that costs nothing.
  //
  // LIVE decides whether anybody was TOLD, and only that suppresses
  // notify-send. This is the failure the old `hasClients()` allowed: phone in
  // a pocket, Android freezes it, socket half-open, desktop closed — the gate
  // held, `clients.size === 1`, the frame went into a frozen socket and the
  // desk was never touched. Nobody was told and every surface said fine.
  //
  // No double-fire when both really are alive: a desk client that is answering
  // pings keeps `live > 0`, so this returns before `notify-send` exactly as it
  // always did.
  const { attached, live } = sink?.census() ?? { attached: 0, live: 0 };
  if (sink && attached > 0) sink.broadcast({ title, body, urgency, ...(pane ? { pane } : {}), ...(extra ?? {}) });
  if (live > 0) return;
  if (DESKTOP) {
    // Urgency 0 is a row in a list, not a thing to put on somebody's screen.
    // With no window open there is no list to put it in either, so it waits
    // there until one opens rather than being drawn over his work.
    //
    // ABOVE the seam on purpose. Behind it is the real `notify-send` in the
    // app and an injected recorder in the suite, and a guard that only covered
    // the real one would have left the suite unable to see this rule at all.
    if (urgency === 0) return;
    if (notifier) { notifier({ title, body, urgency }); return; }
    // No seam installed and this is a test run: say nothing. A suite must never
    // put an approval prompt on somebody's desktop for a hold that never
    // happened, and a test that wants to check this path installs a notifier.
    if (IS_TEST) return;
    const argv = desktopNotifyArgv(title, body, urgency);
    try {
      Bun.spawn(argv, { stdout: "ignore" });
    } catch (e) {
      // Said once, not on every alert: the cause is a missing binary, so it
      // will be just as true the next thousand times and the log is the only
      // place anyone would find out. Silence here used to make "notify-send is
      // not installed" look exactly like "your ping was delivered".
      if (!warnedNoNotifySend) {
        warnedNoNotifySend = true;
        console.warn(`[alerts] AGENTGLASS_NOTIFY=1 but ${argv[0]} could not be run:`, e);
      }
    }
  }
}

let warnedNoNotifySend = false;

/**
 * Text as an AppleScript string literal.
 *
 * AppleScript strings are double-quoted and know two escapes, `\\` and `\"`,
 * so those are the two characters that could end the literal early — and a
 * notification's text is agent output: a tool's stderr, a file path, a
 * commit subject, anything. Escaped here and never interpolated raw; the
 * script is one line built from two of these.
 */
export function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The command that puts an alert on the desktop when no window is open to
 * show it — per platform, as an argv.
 *
 * Linux: `notify-send`, exactly as before. `-u critical` used to be hardcoded,
 * so every alert reached the desktop as the freedesktop urgency that never
 * expires on its own — a tool error and an agent blocked on a permission,
 * drawn identically and both dismissed by hand. `--` because a title can start
 * with a dash.
 *
 * macOS: `osascript -e 'display notification <body> with title <title>'`.
 * There is no `notify-send` on a Mac, so the spawn threw ENOENT and the
 * warning below fired — once, and the alert was gone; the person in the
 * other room was not told. The text goes in as AppleScript string literals
 * (`appleScriptString`), never spliced in raw: `osascript -e` runs whatever it
 * is handed, and the text is not ours. No urgency: Notification Center has no
 * such knob, and no `--`: `osascript` takes the script after `-e`, not a list
 * of positional strings. When neither binary exists the spawn fails as it
 * always did and the same one-line warning says so.
 *
 * `platform` is a parameter for the suite, which runs on Linux.
 */
export function desktopNotifyArgv(title: string, body: string, urgency: number, platform: string = process.platform): string[] {
  if (platform === "darwin") {
    return ["osascript", "-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`];
  }
  const level = urgency === 2 ? "critical" : "normal";
  return ["notify-send", "-a", "agentglass", "-u", level, "--", title, body];
}

/**
 * A tool call is being held at the control-plane gate — ping the human.
 *
 * The gate's id used to travel with it, so the two buttons on a pushed
 * notification knew what they were answering. Nothing carries buttons now, so
 * the id is gone with the push that needed it, and the sentence names what is
 * stopped rather than telling anybody a uuid.
 *
 * The PANE stays, and is a different thing: not something to answer with, but
 * somewhere to go. It only ever reaches an attached client, which is the one
 * surface that can act on it.
 */
export function pushGate(agent: string, tool: string, summary: string, pane?: string) {
  if (shouldSend(`gate:${agent}:${summary}`))
    deliver(
      "✋ Approval needed",
      `${agent} wants to run ${tool}${summary ? `: ${summary.slice(0, 200)}` : ""}`,
      2,
      // So the one alert that stops an agent dead also says where to go and
      // takes you there. It is the notification with the most reason to.
      pane,
    );
}

/**
 * A reminder came due — say so, once.
 *
 * One call rather than a delivery path of its own, and that is deliberate: this
 * buys the webhook, the native OS notification when a client is attached and
 * `notify-send` when none is, all through the code that already gets each of
 * those right. A parallel path is the bug this file fixed once already.
 *
 * Urgency 1, never 2. A reminder is news; 2 is for an agent that is stopped
 * until a person answers, and a phone shows the two differently.
 */
/**
 * An alarm the user set, delivered as one.
 *
 * Urgency 2 rather than 1, and marked as a reminder. Both matter and for
 * different reasons: freedesktop keeps a CRITICAL notification on screen until
 * it is dismissed instead of expiring it after a few seconds, which is the
 * behaviour anybody setting an alarm is asking for — and the mark is what lets
 * the app raise its own alarm rather than adding a seventeenth grey row to the
 * list behind the bell. Reported exactly that way: "it is an alarm I set
 * myself, it has to be more intrusive".
 */
/**
 * The understudy cannot go on, and needs a person.
 *
 * Urgency 2, and the reason is the same one written above `pushReminder`:
 * freedesktop keeps a CRITICAL notification on screen until it is dismissed
 * instead of expiring it in a few seconds. This is not news — it is a machine
 * that has STOPPED and will stay stopped until somebody looks, which is the
 * exact shape `pushGate` uses for an approval. Anything quieter and the clone
 * spends the night idle while its report sits behind a bell nobody opened:
 * "we cannot let this happen, otherwise nobody will want to use the clone".
 *
 * One call rather than a delivery path of its own, so it inherits the webhook,
 * the native notification while a window is open, and `notify-send` when none
 * is. A parallel path is the bug this file already fixed once.
 */
export function pushUnderstudyStuck(what: string, question: string, tried: string) {
  if (shouldSend(`understudy:${what}`)) {
    deliver(
      "🙋 The deputy is stuck",
      `${question} Tried: ${tried}.`.slice(0, 300),
      2,
      /* Where to go, so the alert that says a machine is waiting also takes
         you to the screen where you can answer it. */
      "understudy",
      { kind: "understudy" },
    );
  }
}

/** The Lantern's watch: one loud line per look while something needs a
 *  person. Critical, so the desktop keeps it on screen; the first waiting
 *  pane rides along so a click lands where the answer is typed. */
export function pushLantern(title: string, body: string, pane?: string) {
  if (shouldSend("lantern:watch")) deliver(title, body, 2, pane);
}

export function pushReminder(id: string, title: string, when: string) {
  if (shouldSend(`remind:${id}`)) deliver(`⏰ ${title}`, when, 2, undefined, { kind: "reminder", id });
}

/**
 * How to name the agent an alert is about.
 *
 * It used to be `${source_app}:${session_id.slice(0, 8)}` — a project name and
 * eight characters of a UUID. Reported, fairly, as telling the reader nothing:
 * "agentglass:e4f85ee9" does not say WHICH of a dozen checkouts, does not say
 * where it is running, and is not a thing anybody can act on. A notification
 * that names something you cannot find is a notification you learn to dismiss.
 *
 * Two facts replace it, and both were already on hand:
 *
 *   · the CHECKOUT, from the hook's own `cwd`. On a machine with thirty
 *     worktrees of the same repository this is the only part that identifies
 *     anything — "agentglass-anc" answers "which one" outright.
 *   · the PANE, when the agent is in tmux. The hook reports it (`tmux_pane`)
 *     and panewt records it, so this is a lookup rather than a guess. It is
 *     what turns "something needs you" into somewhere to go.
 *
 * The session prefix stays at the end, because two agents can be running in the
 * same checkout and it is the only thing that tells them apart. It is a
 * disambiguator now rather than the headline.
 */
export function describeAgent(e: WatchEvent): string {
  const cwd = typeof (e.payload as { cwd?: unknown } | null)?.cwd === "string"
    ? String((e.payload as { cwd: string }).cwd) : "";
  return describeSession(e.source_app, e.session_id, cwd);
}

/**
 * The same name, for the callers that have a session and no event.
 *
 * The gate is the one that matters: it is the notification that wakes a phone,
 * and it was composing `${source_app}:${session_id.slice(0, 8)}` by hand — the
 * exact string this replaced everywhere else, in the one alert somebody is
 * woken up by and expected to decide on.
 *
 * A cwd is optional because the gate has none. It does not need one: the pane
 * note recorded by the hook holds the directory the agent is running in, so the
 * checkout can be recovered from the session alone.
 */
export function describeSession(sourceApp: string, sessionId: string, cwdIn = ""): string {
  const pane = paneForSession(sessionId);
  const cwd = cwdIn || (pane ? paneAgentNote(pane)?.cwd ?? "" : "");
  // Trailing slashes come from a shell that had one; `filter(Boolean)` so the
  // basename of "/home/u/repo/" is "repo" rather than "".
  const checkout = cwd.split("/").filter(Boolean).pop() ?? "";
  const where = checkout || sourceApp;
  const at = pane ? paneLabel(pane) : null;
  // The session prefix ONLY when there is no pane. It is a disambiguator, and a
  // pane already disambiguates — carrying both left six characters of a UUID on
  // a line that had just been made readable.
  return at ? `${where} · ${at}` : `${where} (${sessionId.slice(0, 6)})`;
}

/**
 * A pane id, as somebody would say it out loud.
 *
 * `%8` is tmux's own handle and means nothing to a person: it was reported as
 * being no better than the UUID it replaced. What a person navigates by is the
 * window — `main:3 «claude»` is a thing you can find, and it is what their
 * status bar is already showing them.
 *
 * Falls back to the raw id rather than to nothing. A pane tmux will not
 * describe is still a pane, and `%8` beats silence for somebody who does know
 * how to select one.
 */
function paneLabel(pane: string): string {
  const now = Date.now();
  if (now - paneCacheAt > PANE_CACHE_MS) { paneCache = null; paneCacheAt = now; }
  try {
    // Cached for a few seconds because this spawns tmux, and a burst of alerts
    // from one stopped agent would otherwise spawn one per alert.
    paneCache ??= listPanes();
    const row = paneCache.find((r) => r.paneId === pane);
    if (!row) return pane;
    const name = row.windowName ? ` «${row.windowName}»` : "";
    return `${row.session}:${row.windowIndex}${name}`;
  } catch {
    return pane;
  }
}
let paneCache: ReturnType<typeof listPanes> | null = null;
let paneCacheAt = 0;
/** Long enough to absorb a burst, short enough that a renamed window is right
 *  by the time anybody looks. */
const PANE_CACHE_MS = 5_000;

/** Inspect an event and fire an alert if it warrants one. */
export function maybeAlert(e: WatchEvent) {
  const agent = describeAgent(e);
  const pane = paneForSession(e.session_id) ?? undefined;

  // Kept, and it has never once run. `PermissionRequest` is not in the hook
  // vocabulary this database has ever seen: zero rows over its whole life,
  // against nine event types that do appear. The real article arrives as a
  // `Notification` whose message is "Claude needs your permission", and is
  // handled one branch below — which is why the promotion there exists.
  if (e.hook_event_type === "PermissionRequest") {
    if (shouldSend(`perm:${e.session_id}`))
      deliver(
        "⏳ Approval needed",
        `${agent} is waiting on a permission request${e.tool_name ? ` (${e.tool_name})` : ""}.`,
        2, pane,
      );
    return;
  }
  if (e.hook_event_type === "Notification") {
    const msg = String((e.payload as any)?.message ?? "Agent notification");
    // The message leads and the agent follows. It was the other way round —
    // the title was the opaque identifier and the message was the body — so a
    // stack of these read as a column of hashes with the actual news underneath.
    //
    // The one place a string test earns its keep. Everything here is already
    // true when he looks — an agent that said it is waiting is still waiting —
    // so the question is only which of them is a BLOCKAGE. Measured over 7
    // days: 279 "waiting for your input", 6 "needs your permission", 3 "needs
    // your approval", 2 "usage limit reset". The middle nine are the only ones
    // he cannot ignore, and they were shipping at the same urgency as the rest.
    //
    // Safe in a way the stdout marker scan was not: an unrecognised message
    // falls through to 1 and still lands in the list with its pane. A stale
    // string here loses a promotion; a stale string there INVENTED an urgent
    // interrupt out of a command that had worked.
    const urgency = /needs your (permission|approval)/i.test(msg) ? 2
      : /usage limit reset/i.test(msg) ? 0
        : 1;
    if (shouldSend(`notify:${e.session_id}:${msg}`)) deliver(`🔔 ${msg}`, agent, urgency, pane);
    return;
  }
  if (e.is_error) {
    // Urgency 0: it goes in the list, with its pane, and interrupts nothing.
    //
    // A failed tool call does not earn a human, and the measurement is not
    // close. Over 8 days, 465 error events: 464 were followed by another event
    // from the same session within 60 seconds and all 465 within five minutes.
    // ZERO were the last thing a session ever did. The agent had already
    // recovered before the popup finished animating — which is his report,
    // exactly: "when I open the conversation I don't see that anything failed".
    //
    // At 2 this was `requireInteraction` on the desk, `max` on the phone and
    // `-u critical` on notify-send: a popup that stays until dismissed by hand,
    // 140 times a day, for a grep that matched nothing. The notification he
    // actually needs — an agent waiting on him — was three lines above at 1,
    // expiring quietly while he cleared the sixty that were not.
    //
    // No list of benign error strings, and that is deliberate. Classification
    // is the trap the marker scan fell into; demotion needs no vocabulary and
    // cannot go stale.
    if (shouldSend(`err:${e.session_id}:${e.tool_name}`))
      deliver("❌ Tool error", `${agent} — ${e.tool_name ?? "tool"} failed${e.error_text ? `: ${e.error_text.slice(0, 200)}` : ""}.`, 0, pane);
  }
}
