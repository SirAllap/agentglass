/*
 * Raising a notification, from an alert the computer sent.
 *
 * LOCAL notifications, not push. There is no Firebase project, no APNs
 * certificate, no server holding device tokens and no third party in the path
 * — the phone is already connected to the machine over the live socket, and
 * `{type:"alert"}` is the same thing the server hands to `notify-send` on the
 * desk. Turning that into a buzz is the whole mechanism.
 *
 * ── why expo-notifications is loaded lazily ───────────────────────────────
 * Because importing it at module scope took the whole app down.
 *
 * Expo Go on Android does not ship it. Measured on emulator-5554, Expo Go,
 * SDK 57, Android 14: `require("expo-notifications")` returns `undefined` AND
 * raises "Android Push notifications … was removed from Expo Go with the
 * release of SDK 53" as an UNCAUGHT error — a red box over whatever you were
 * looking at, on every cold start. This file is reached from the host store,
 * which is reached from the tab layout, so that is not "notifications are
 * off", it is expo-router failing to build a route. That is what "la app sigue
 * rota" was.
 *
 * So it is required inside the functions, once, behind a try, and behind the
 * Expo Go check that stops it being attempted at all. A phone that cannot
 * notify still gets every screen; the switch in Settings reports that it
 * cannot, which is a true thing to say rather than a blank app.
 *
 * ── nothing here may fail silently ────────────────────────────────────────
 * Everything below returns a REASON rather than `undefined`, and that is the
 * whole shape of this file.
 *
 * It used to hold a one-way latch — `let ready = false`, set only by a setup
 * function whose catch was deliberately silent — and `raise()` began with
 * `if (!N || !ready) return;`. So a setup that threw anywhere (the Android
 * channel is one call that can) left `ready` false for the life of the
 * process, Settings read the OS PERMISSION and drew itself ON, and every alert
 * was dropped without a line anywhere. Reproduced on the emulator, screenshot
 * to screenshot: the card said "This phone may buzz", "Send a test alert" did
 * nothing, and the shade stayed empty.
 *
 * The sharper half was that the latch was never re-checked. Turn the channel
 * off in Android's settings and it stays true, `scheduleNotificationAsync`
 * resolves, nothing is drawn — and the caller had already counted the alert as
 * delivered. So the state is asked of the OS on every raise instead of
 * remembered, which costs two IPC round-trips on a path that fires a few times
 * an hour.
 *
 * What local notifications cost even when they work: the app has to be alive
 * to hear the socket. Android keeps one open for a while after the screen goes
 * off and then freezes the process, so this reaches a pocket for a while and
 * not for ever. Settings says so rather than implying otherwise.
 */
import Constants, { ExecutionEnvironment } from "expo-constants";
import { Platform } from "react-native";
import type { AlertNote } from "../../../shared/types.ts";
import { importanceOf } from "./policy.ts";

/**
 * Expo Go, where this module is not merely missing but deliberately removed.
 *
 * Asked BEFORE the require, not after catching it. The catch does not even
 * help: measured, the require does not throw into it — it returns `undefined`
 * and the error arrives out of band as a red box. Not attempting it is the
 * difference between a known limitation and what reads like a crash.
 */
const IN_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/** One channel, named for what it carries. Android shows channels in the
 *  system settings, so the name is somebody's only way to silence THIS and not
 *  everything — which is a better outcome than uninstalling. */
const CHANNEL = "agentglass-alerts";

type NotificationsModule = typeof import("expo-notifications");

/** `undefined` until asked, `null` once asked and found missing. The three
 *  states are distinct on purpose: "not tried" and "not available" lead to
 *  different behaviour, and collapsing them retries a failing require on
 *  every alert. */
let module: NotificationsModule | null | undefined;

function load(): NotificationsModule | null {
  if (module !== undefined) return module;
  if (IN_EXPO_GO && Platform.OS === "android") { module = null; return module; }
  try {
    // `require` rather than a dynamic import: this has to answer synchronously
    // for the callers below, and the failure to catch is a THROW at load time,
    // which an await would turn into an unhandled rejection instead.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require("expo-notifications") as NotificationsModule | undefined;
    // `?? null` is not defensive noise. Measured in Expo Go: this require
    // ANSWERS `undefined` rather than throwing, and `undefined` is this
    // variable's "not tried yet" — so without it the sentinel reads as
    // untried for ever and `notificationsSupported()` (`load() !== null`)
    // answers TRUE for a module that is not there.
    module = m ?? null;
  } catch {
    module = null;
  }
  return module;
}

/** Why an alert could not be raised. Each one leads somewhere different, which
 *  is why this is not a boolean. */
export type Blocked =
  /** No notifications module in this build at all — Expo Go on Android. */
  | "unsupported"
  /** The OS permission is not granted, or was taken away in system settings. */
  | "denied"
  /** The Android channel exists and the user has switched it to no importance:
   *  posting succeeds and nothing is ever drawn. */
  | "channel-off"
  /** The module is present and would not set itself up. */
  | "setup-failed"
  /** The post itself was rejected. */
  | "threw";

export type Delivery = { ok: true } | { ok: false; why: Blocked; detail?: string };

const no = (why: Blocked, detail?: string): Delivery =>
  ({ ok: false, why, ...(detail ? { detail } : {}) });

/** The last thing that stopped an alert, so Settings can say it instead of
 *  drawing a switch that claims everything is fine. Cleared on a success. */
let lastFailure: Delivery | null = null;
export function lastAlertFailure(): Delivery | null { return lastFailure; }

/** Said once per reason. The cause of any of these is a state of the phone, so
 *  it will be just as true the next hundred alerts, and a line per alert is
 *  how a log stops being read. */
const warned = new Set<Blocked>();

/**
 * The one reason that is not worth saying out loud.
 *
 * `unsupported` is Expo Go on Android, where the module was removed from the
 * runtime — a property of the build, not an event. In development a
 * `console.warn` is a yellow banner over whatever you were looking at, and this
 * one fired on every cold start AND on every Metro reload, because the module
 * state it is deduplicated by goes with the reloaded bundle. Meanwhile the
 * Settings card already states it permanently and in red, which is the right
 * place for a condition that will still be true tomorrow.
 *
 * Everything else still speaks. A channel switched off, a permission taken
 * away, a setup that threw, a post that was rejected — those are things that
 * CHANGED, they are things somebody can undo, and each of them is the quiet
 * failure this file was rewritten to stop hiding.
 */
const SILENT: Blocked = "unsupported";

/** The in-flight or successful setup, kept only while it succeeded. See
 *  ensureSetUp — declared here so everything __setNotificationsModule resets
 *  is above it. */
let setUp: Promise<Delivery> | null = null;

function record(d: Delivery): Delivery {
  if (d.ok) { lastFailure = null; return d; }
  lastFailure = d;
  // Recorded either way — `lastAlertFailure` is what the Settings card reads,
  // and the card is where a permanent condition belongs. Only the saying is
  // skipped. See SILENT.
  if (!warned.has(d.why)) {
    warned.add(d.why);
    if (d.why !== SILENT) {
      console.warn(`[alerts] not raised on this phone: ${d.why}${d.detail ? ` — ${d.detail}` : ""}`);
    }
  }
  return d;
}

/**
 * The seam the tests drive.
 *
 * There is no expo-notifications under `bun test`, and the interesting
 * behaviour of this file is entirely about what it does when the module
 * misbehaves — a channel that refuses, a permission that was taken away, a
 * schedule call that resolves and draws nothing. None of that is reachable
 * without being able to hand it a module.
 *
 * Declared BELOW everything it touches, and that is not tidiness. It was above
 * them for one run on the emulator and the app came up as a red box: "Cannot
 * read property 'clear' of undefined" — a `const` read before its initialiser,
 * which this project has had take the whole window black once already. A
 * function that resets module state has to be defined after the state it
 * resets, or it works everywhere except the one call site that matters.
 */
export function __setNotificationsModule(m: NotificationsModule | null | undefined): void {
  module = m;
  setUp = null;
  lastFailure = null;
  warned.clear();
}

/** Whether this build can raise one at all. False in Expo Go on Android, where
 *  the module is not there — and that is worth saying out loud rather than
 *  showing a switch that does nothing. */
export function notificationsSupported(): boolean {
  return load() !== null;
}

/**
 * Install the foreground handler and the Android channel.
 *
 * The handler matters on Android: without it a notification raised while the
 * app is in the foreground is delivered silently and never drawn — so the
 * "send a test" button in Settings would do nothing visible and read as broken,
 * which is exactly the wrong first impression for the feature you are trying to
 * decide whether to trust.
 *
 * Memoised only while it SUCCEEDS (in `setUp`, declared with the other module
 * state above). The version of this that latched a boolean had no way back:
 * one failed channel call and the app was deaf until it was killed. A failure
 * clears the memo, so the next alert tries again.
 */
function ensureSetUp(): Promise<Delivery> {
  if (setUp) return setUp;
  const attempt = (async (): Promise<Delivery> => {
    const N = load();
    if (!N) return no("unsupported");
    try {
      N.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });

      if (Platform.OS === "android") {
        await N.setNotificationChannelAsync(CHANNEL, {
          name: "Agent alerts",
          description: "A gate waiting on you, a tool that failed, a run that stopped.",
          importance: N.AndroidImportance.HIGH,
          // Distinct from the default so a held gate is recognisable from a
          // pocket without reading it.
          vibrationPattern: [0, 220, 120, 220],
          lightColor: "#a78bfa",
        });
      }
      return { ok: true };
    } catch (e) {
      return no("setup-failed", String((e as Error)?.message ?? e));
    }
  })();
  setUp = attempt;
  void attempt.then((r) => { if (!r.ok) setUp = null; });
  return attempt;
}

/**
 * Can an alert actually be drawn on this phone, right now?
 *
 * Asked of the OS, not of a latch — and it asks about the CHANNEL as well as
 * the permission, because those are two different switches and only one of
 * them is what `getPermissionsAsync` answers. A channel the user has set to no
 * importance takes a `scheduleNotificationAsync` without complaining and draws
 * nothing, which is the quietest way this feature can be off.
 */
export async function alertsDeliverable(): Promise<Delivery> {
  const N = load();
  if (!N) return record(no("unsupported"));
  const prepared = await ensureSetUp();
  if (!prepared.ok) return record(prepared);
  try {
    if (!(await N.getPermissionsAsync()).granted) return record(no("denied"));
    if (Platform.OS === "android") {
      const channel = await N.getNotificationChannelAsync(CHANNEL);
      if (channel && channel.importance === N.AndroidImportance.NONE) return record(no("channel-off"));
    }
  } catch (e) {
    return record(no("setup-failed", String((e as Error)?.message ?? e)));
  }
  return record({ ok: true });
}

/**
 * Ask for permission, from the switch in Settings.
 *
 * Asked only when somebody has actually turned it on. An app that asks on
 * first launch, before it has shown what it would notify about, gets "no" —
 * and Android will not ask again.
 *
 * Answers with what can actually be DELIVERED afterwards, not with what the
 * permission dialog said: granting the permission while the channel is off is
 * a phone that still cannot buzz, and the switch has to know that.
 */
export async function askForAlerts(): Promise<Delivery> {
  const N = load();
  if (!N) return record(no("unsupported"));
  const prepared = await ensureSetUp();
  if (!prepared.ok) return record(prepared);
  try {
    if (!(await N.getPermissionsAsync()).granted) await N.requestPermissionsAsync();
  } catch (e) {
    return record(no("setup-failed", String((e as Error)?.message ?? e)));
  }
  return alertsDeliverable();
}

/**
 * Show one.
 *
 * `null` trigger means immediately. The data rides along so that tapping it
 * can land on the queue rather than just opening the app — a notification you
 * have to go and find the cause of is a notification that wasted the
 * interruption.
 *
 * Returns whether it was DELIVERED, and the caller is expected to care: the
 * dedupe window that says "this alert has already been shown" must not be
 * written by a raise that did not show anything. See host-context.tsx.
 *
 * "Delivered" is as close to "drawn" as Android will say — permission, channel
 * importance and a post it accepted. Do Not Disturb is still invisible from
 * here, and nothing on the platform can see it. The three states this used to
 * confuse with success are all covered.
 */
export async function raise(alert: AlertNote): Promise<Delivery> {
  const can = await alertsDeliverable();
  if (!can.ok) return can;
  const N = load();
  if (!N) return record(no("unsupported"));
  try {
    await N.scheduleNotificationAsync({
      content: {
        title: alert.title,
        body: alert.body,
        data: { kind: "alert" },
        priority: importanceOf(alert.urgency) === "max"
          ? N.AndroidNotificationPriority.MAX
          : N.AndroidNotificationPriority.HIGH,
        ...(Platform.OS === "android" ? { channelId: CHANNEL } : {}),
      },
      trigger: null,
    });
  } catch (e) {
    // Still not worth taking the app down for — the alert is on screen in the
    // queue either way — but it is worth SAYING. The version of this catch
    // that returned nothing is why a deaf phone looked like a working one.
    return record(no("threw", String((e as Error)?.message ?? e)));
  }
  return record({ ok: true });
}
