/*
 * Turning push on, from the phone's side.
 *
 * Three separate things have to line up before an alert can reach a locked
 * screen, and each fails differently: the browser has to support push at all,
 * the user has to grant notification permission, and a subscription has to be
 * registered with both the push service and this machine's server. This module
 * is about telling those three apart, because a single "it didn't work" is
 * useless — one is "your browser can't", one is "you said no and only you can
 * undo it", and one is "the server is unreachable, try again".
 *
 * The logic that decides what to say is pure and lives at the top. The part
 * that touches `navigator` takes its dependencies as arguments, so the whole
 * flow can be driven in a test without a browser — which matters here more
 * than usual, since the one step no container can perform is the real
 * `PushManager.subscribe` against a real push service.
 */

/**
 * Base64url to bytes, for `applicationServerKey`.
 *
 * The server hands the VAPID public key over as base64url, and
 * `PushManager.subscribe` will only take a BufferSource. Passing the string
 * through is not a type error in JavaScript — it is accepted, then fails at
 * subscribe time with a message that names neither the key nor the format.
 *
 * Padding is stripped before it is recomputed. For well-formed base64 that is
 * a no-op, whatever the arithmetic looks like: a correctly padded string is
 * already a multiple of four, so nothing is added back. What it buys is that a
 * *mis*-padded one decodes instead of throwing — and a 65-byte key is 88
 * characters, which needs no padding at all, so any padding that turns up here
 * came from something that added its own.
 */
export function decodeKey(b64url: string): Uint8Array {
  const pad = b64url.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const raw = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushState =
  /** No service worker or no PushManager: Safari before 16.4, or an insecure origin. */
  | "unsupported"
  /**
   * iOS, in a browser tab.
   *
   * Not the same as unsupported, and the difference is most of the phones this
   * companion is for. Safari has had Web Push since 16.4, but *only* for a site
   * added to the Home Screen — in a tab, `window.PushManager` simply does not
   * exist. Telling that user "this browser cannot receive push notifications"
   * is both false and a dead end, when the fix is one entry in the share sheet.
   */
  | "needs-install"
  /** The user denied notifications. Only they can undo this, in browser settings. */
  | "blocked"
  /** Supported and allowed, but this device is not registered. */
  | "off"
  /** Registered. Alerts reach this device with its screen off. */
  | "on";

/**
 * Is this an Apple phone or tablet?
 *
 * iPadOS 13 and later report a desktop Safari user agent — "Macintosh", no
 * "iPad" anywhere — so the string alone says Mac. A touchscreen is what tells
 * them apart: a real Mac reports `maxTouchPoints` 0.
 */
export function isApplePortable(ua: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && maxTouchPoints > 1;
}

/**
 * Would this device support push, but only once it is on the Home Screen?
 *
 * Asked only when push is missing: if `PushManager` is there, the question
 * does not arise, and an installed PWA that somehow lost it should not be told
 * to install itself again.
 */
export function needsHomeScreen(env: {
  hasPushManager: boolean; ua: string; maxTouchPoints: number; standalone: boolean;
}): boolean {
  if (env.hasPushManager) return false;
  return isApplePortable(env.ua, env.maxTouchPoints) && !env.standalone;
}

export function pushStateOf(env: {
  supported: boolean;
  permission: "default" | "granted" | "denied";
  subscribed: boolean;
  /** Set when the only thing missing is Add to Home Screen. */
  needsInstall?: boolean;
}): PushState {
  if (!env.supported) return env.needsInstall ? "needs-install" : "unsupported";
  // Subscribed wins over permission on purpose. A browser can report
  // "default" while an active subscription exists — permission is per-origin
  // and can be reset without the subscription being torn down — and showing
  // "off" for a device that is in fact receiving is the one wrong answer that
  // would have somebody turn it on twice and get two of every alert.
  if (env.subscribed) return "on";
  if (env.permission === "denied") return "blocked";
  return "off";
}

/** What the settings row says, for each of the five ways this can stand. */
export function pushCopy(state: PushState): { sub: string; action: string | null } {
  switch (state) {
    case "needs-install":
      // No button, because there is nothing here to press — the action is in
      // Safari's share sheet. So the row has to name it, or it is the same
      // dead end as saying "unsupported".
      return { sub: "Add to Home Screen first — Share ⇧, then Add to Home Screen", action: null };
    case "on":
      return { sub: "Alerts reach this phone with the screen off", action: "Turn off" };
    case "off":
      return { sub: "Get held gates on this phone, screen off", action: "Turn on" };
    case "blocked":
      // No button: the browser will not ask again, and a button that silently
      // does nothing is worse than none. Say where the switch actually is.
      return { sub: "Notifications are blocked in your browser settings", action: null };
    case "unsupported":
      return { sub: "This browser cannot receive push notifications", action: null };
  }
}

/** Whatever the phone should call itself in the device list. Free text, only
 *  ever shown back — a name, not an identifier. */
export function deviceLabel(ua: string): string {
  // Order matters: an iPad reports "Macintosh" on iPadOS, and every Android
  // browser string also contains "Linux".
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Linux/i.test(ua)) return "Linux";
  return "This device";
}

export interface PushEnv {
  /** Usually `navigator.serviceWorker`. */
  sw: {
    register: (url: string, opts?: { scope?: string }) => Promise<ServiceWorkerRegistrationLike>;
    ready: Promise<ServiceWorkerRegistrationLike>;
  } | null;
  hasPushManager: boolean;
  permission: "default" | "granted" | "denied";
  requestPermission: () => Promise<"default" | "granted" | "denied">;
  ua: string;
  /** iPadOS reports a Mac user agent; a touchscreen is what gives it away. */
  maxTouchPoints: number;
  /** Running from the Home Screen rather than in a browser tab. */
  standalone: boolean;
  /** This app's server. */
  getKey: () => Promise<{ key: string }>;
  subscribe: (sub: unknown, label: string) => Promise<{ ok: boolean; error?: string }>;
  unsubscribe: (endpoint: string) => Promise<{ ok: boolean }>;
  /** Injected so the timeout above can be exercised without a 20s test. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface ServiceWorkerRegistrationLike {
  pushManager: {
    getSubscription: () => Promise<PushSubscriptionLike | null>;
    subscribe: (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => Promise<PushSubscriptionLike>;
  };
}

export interface PushSubscriptionLike {
  endpoint: string;
  toJSON: () => unknown;
  unsubscribe: () => Promise<boolean>;
}

export type PushResult =
  | { ok: true; state: PushState }
  | { ok: false; state: PushState; error: string };

/**
 * How long to wait for the browser to produce a subscription.
 *
 * `PushManager.subscribe` talks to the push service over the network, and when
 * it cannot reach one it does not fail — it waits, for minutes, with no signal
 * of any kind. In a real browser with the service unreachable the settings
 * toggle sat on "…" indefinitely, which is the worst of the three outcomes:
 * not on, not off, and not saying so. This is the bound that turns that into
 * an answer.
 */
export const SUBSCRIBE_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, sleep: (ms: number) => Promise<void>): Promise<T> {
  // No "did it already land" guard: the race is settled by whichever finishes
  // first, and a rejection from the loser afterwards is discarded — `race`
  // attaches its own handler to both, so it is not an unhandled rejection
  // either. A guard here looked like caution and could never fire, which a
  // mutation proved by walking straight through it.
  return Promise.race([
    p,
    sleep(ms).then<T>(() => {
      throw new Error("The push service could not be reached. Check the connection and try again.");
    }),
  ]);
}

/**
 * Register the worker and find out where this device currently stands.
 *
 * Registering on every open, not only when the toggle is used: a worker is
 * replaced by an update, and `navigator.serviceWorker.register` with an
 * unchanged file is a no-op, so this is the cheapest way to make sure the
 * shipped worker is the one that will receive the next push.
 */
export async function currentPushState(env: PushEnv): Promise<PushState> {
  const cannot = (): PushState =>
    pushStateOf({ supported: false, permission: env.permission, subscribed: false, needsInstall: needsHomeScreen(env) });
  if (!env.sw || !env.hasPushManager) return cannot();
  try {
    await env.sw.register("./sw.js");
    const reg = await env.sw.ready;
    const sub = await reg.pushManager.getSubscription();
    return pushStateOf({ supported: true, permission: env.permission, subscribed: !!sub });
  } catch {
    // A registration that throws means no worker, which means no push —
    // whatever the browser claims to support.
    //
    // Plainly "unsupported", not the Home Screen hint: reaching here means
    // `hasPushManager` was true, so this is not an iOS tab and telling anyone
    // to install something would be wrong. Routing it through the same helper
    // as the branch above looked more careful and could only ever return this
    // — a mutation swapping the two changed nothing, which is how that showed.
    return "unsupported";
  }
}

/**
 * Turn it on: permission, then a subscription, then tell the server.
 *
 * The order is not arbitrary. Permission must be requested from a user
 * gesture or the browser refuses without asking, and `subscribe()` fails
 * outright unless permission is already granted — so a flow that subscribed
 * first would fail on every phone, every time.
 */
export async function enablePush(env: PushEnv): Promise<PushResult> {
  if (!env.sw || !env.hasPushManager) {
    return needsHomeScreen(env)
      ? { ok: false, state: "needs-install", error: pushCopy("needs-install").sub }
      : { ok: false, state: "unsupported", error: "This browser cannot receive push notifications." };
  }
  try {
    const permission = env.permission === "granted" ? "granted" : await env.requestPermission();
    if (permission !== "granted") {
      return {
        ok: false,
        state: permission === "denied" ? "blocked" : "off",
        error: permission === "denied"
          ? "Notifications are blocked. Allow them for this site in your browser settings."
          : "Notifications were not allowed.",
      };
    }

    await env.sw.register("./sw.js");
    const reg = await env.sw.ready;

    // The key is fetched before subscribing, and a failure here stops the
    // flow. Subscribing against the wrong key produces a subscription the
    // server can never send to: the push service rejects its token, and the
    // phone shows a perfectly healthy-looking "on".
    const { key } = await env.getKey();
    if (!key) return { ok: false, state: "off", error: "The server did not hand over a key." };

    // An existing subscription is reused rather than replaced. It may have
    // been made against this same key and simply not be known to the server —
    // a restored config, or a server that lost its file — and re-subscribing
    // would mint a second endpoint for one phone.
    const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const sub = await reg.pushManager.getSubscription()
      ?? await withTimeout(reg.pushManager.subscribe({
        // Required, and enforced: a browser will revoke a subscription that
        // receives pushes and shows nothing. Every push this server sends
        // does show something, so this costs nothing and is honest.
        userVisibleOnly: true,
        applicationServerKey: decodeKey(key),
      }), env.timeoutMs ?? SUBSCRIBE_TIMEOUT_MS, sleep);

    const res = await env.subscribe(sub.toJSON(), deviceLabel(env.ua));
    if (!res.ok) return { ok: false, state: "off", error: res.error || "The server would not take the subscription." };
    return { ok: true, state: "on" };
  } catch (e) {
    return { ok: false, state: "off", error: String((e as Error)?.message ?? e) };
  }
}

/**
 * Turn it off, at both ends.
 *
 * The server is told first. If the browser's `unsubscribe()` succeeded and
 * the server call then failed, this machine would keep pushing to a dead
 * endpoint until the push service answered 410 — which is eventual, silent,
 * and leaves a phone listed as a device it no longer is.
 */
export async function disablePush(env: PushEnv): Promise<PushResult> {
  if (!env.sw) return { ok: true, state: "unsupported" };
  try {
    const reg = await env.sw.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return { ok: true, state: "off" };
    await env.unsubscribe(sub.endpoint);
    await sub.unsubscribe();
    return { ok: true, state: "off" };
  } catch (e) {
    return { ok: false, state: "on", error: String((e as Error)?.message ?? e) };
  }
}

/** The live browser, wired to this app's server. Split out so the flow above
 *  never touches a global and can be driven whole in a test. */
export function browserPushEnv(api: {
  pushKey: () => Promise<{ key: string }>;
  pushSubscribe: (sub: unknown, label: string) => Promise<{ ok: boolean; error?: string }>;
  pushUnsubscribe: (endpoint: string) => Promise<{ ok: boolean }>;
}): PushEnv {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const canNotify = typeof Notification !== "undefined";
  // Two ways to be on the Home Screen, because the reliable one on iOS is
  // Apple's own non-standard flag: `display-mode: standalone` is honoured
  // there, but it is the media query that arrived late and the flag has been
  // right since long before Web Push existed. Either counts.
  const standalone = (() => {
    try {
      if ((nav as { standalone?: boolean } | null)?.standalone) return true;
      return typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
    } catch {
      return false;
    }
  })();
  return {
    sw: nav && "serviceWorker" in nav ? (nav.serviceWorker as unknown as PushEnv["sw"]) : null,
    hasPushManager: typeof PushManager !== "undefined",
    permission: canNotify ? Notification.permission : "denied",
    requestPermission: () => (canNotify ? Notification.requestPermission() : Promise.resolve("denied" as const)),
    ua: nav?.userAgent ?? "",
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    standalone,
    getKey: api.pushKey,
    subscribe: api.pushSubscribe,
    unsubscribe: api.pushUnsubscribe,
  };
}
