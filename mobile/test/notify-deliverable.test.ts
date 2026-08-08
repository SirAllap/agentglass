import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { alertKey, remember, shouldNotify, SAME_ALERT_MS } from "../src/notifications/policy.ts";
import type { AlertNote } from "../../shared/types.ts";

// react-native's entry point is Flow, not TypeScript, so importing it under
// `bun test` is a syntax error — which is why every other suite here tests
// pure modules only. notify.ts wants exactly two things from the native side,
// and both are constants, so they are stood up rather than the module.
mock.module("react-native", () => ({ Platform: { OS: "android" } }));
mock.module("expo-constants", () => ({
  default: { executionEnvironment: "bare" },
  ExecutionEnvironment: { StoreClient: "storeClient", Standalone: "standalone", Bare: "bare" },
}));

let notify: typeof import("../src/notifications/notify.ts");
let __setNotificationsModule: typeof notify.__setNotificationsModule;
let alertsDeliverable: typeof notify.alertsDeliverable;
let askForAlerts: typeof notify.askForAlerts;
let lastAlertFailure: typeof notify.lastAlertFailure;
let notificationsSupported: typeof notify.notificationsSupported;
let raise: typeof notify.raise;

beforeAll(async () => {
  notify = await import("../src/notifications/notify.ts");
  ({ __setNotificationsModule, alertsDeliverable, askForAlerts, lastAlertFailure, notificationsSupported, raise } = notify);
});

/*
 * "Permission granted" is not "an alert will be drawn".
 *
 * This file used to keep a one-way latch — `let ready = false`, set only by the
 * setup function, whose catch was deliberately silent — and `raise()` opened
 * with `if (!N || !ready) return;`. The Settings switch read the OS PERMISSION
 * instead, and disabled itself once that was true.
 *
 * So: permission granted + a setup that threw = a switch reading ON, every
 * alert dropped without a line anywhere, and the "send a test" button doing
 * nothing visible. Reproduced on emulator-5554 before the fix — the card said
 * "This phone may buzz", the button did nothing, and the notification shade
 * stayed empty.
 *
 * The sharper half is that the latch was never re-checked against the OS. Turn
 * the channel off in Android's settings and `ready` stays true,
 * `scheduleNotificationAsync` resolves, nothing is drawn — and the caller had
 * ALREADY written the 90-second dedupe entry, so the next ninety seconds of
 * that alert were spent on a notification nobody ever saw. This comment used to
 * end "so the re-broadcast that would have been the natural retry was swallowed
 * too"; there is no re-broadcast — see the note above `remember` in policy.ts.
 * The cost is the dead window, and it is enough on its own.
 */

const ANDROID_IMPORTANCE = { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4, MAX: 5 };

interface Fake {
  granted: boolean;
  /** Android's own importance for our channel; NONE means the user switched it
   *  off in system settings, where the app is never told. */
  channelImportance: number;
  channelThrows: boolean;
  scheduleThrows: boolean;
  posted: { title: string; body: string }[];
}

function fakeModule(over: Partial<Fake> = {}): { mod: any; state: Fake } {
  const state: Fake = {
    granted: true, channelImportance: ANDROID_IMPORTANCE.HIGH,
    channelThrows: false, scheduleThrows: false, posted: [], ...over,
  };
  const mod = {
    setNotificationHandler: () => {},
    setNotificationChannelAsync: async () => {
      if (state.channelThrows) throw new Error("channel refused");
    },
    getNotificationChannelAsync: async () => ({ id: "agentglass-alerts", importance: state.channelImportance }),
    getPermissionsAsync: async () => ({ granted: state.granted, status: state.granted ? "granted" : "denied" }),
    requestPermissionsAsync: async () => { state.granted = true; return { granted: true, status: "granted" }; },
    scheduleNotificationAsync: async (req: any) => {
      if (state.scheduleThrows) throw new Error("android refused");
      state.posted.push({ title: req.content.title, body: req.content.body });
      return "id";
    },
    AndroidImportance: ANDROID_IMPORTANCE,
    AndroidNotificationPriority: { MAX: "max", HIGH: "high" },
  };
  return { mod, state };
}

const NOTE: AlertNote = { title: "✋ Approval needed", body: "agentglass · main:3 «claude»", urgency: 2 };

beforeEach(() => { __setNotificationsModule(undefined); });

describe("what the switch is allowed to claim", () => {
  test("no module in this build: unsupported, and it says so", async () => {
    __setNotificationsModule(null);
    expect(notificationsSupported()).toBe(false);
    expect(await alertsDeliverable()).toEqual({ ok: false, why: "unsupported" });
  });

  test("and it says so to the card, without a warning on the screen", async () => {
    /*
     * `unsupported` is Expo Go on Android, where the module was removed from
     * the runtime: a property of the build, not an event. The warning it used
     * to write is a banner over whatever you were looking at, and it fired on
     * every cold start AND every Metro reload — the module state it is
     * deduplicated by goes with the reloaded bundle. The Settings card already
     * states it permanently and in red, which is where a condition that will
     * still be true tomorrow belongs.
     *
     * Only the SAYING is dropped. Everything the screen reads is still
     * recorded, which is what this asserts alongside the silence — a version of
     * this that quietly stopped recording would take the card down with the
     * banner.
     */
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };
    try {
      __setNotificationsModule(null);
      await alertsDeliverable();
      await raise(NOTE);
    } finally {
      console.warn = warn;
    }
    expect(said).toEqual([]);
    expect(lastAlertFailure()).toEqual({ ok: false, why: "unsupported" });
  });

  test("but a channel somebody switched off still speaks", async () => {
    // The mirror image, and the reason this is not "stop warning". A channel
    // set to no importance takes a post without complaining and draws nothing:
    // it CHANGED, somebody can undo it, and it is the quiet failure this file
    // was rewritten to stop hiding.
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };
    try {
      __setNotificationsModule(fakeModule({ channelImportance: ANDROID_IMPORTANCE.NONE }).mod);
      await alertsDeliverable();
    } finally {
      console.warn = warn;
    }
    expect(said.join(" ")).toContain("channel-off");
  });

  /*
   * The one the emulator run turned up. In Expo Go on Android SDK 57 the
   * require does not throw — it ANSWERS `undefined`, which is this module's
   * "not tried yet". Without normalising it, `notificationsSupported()` is
   * `load() !== null` and answers TRUE for a module that is not there.
   */
  test("a module that is undefined is a module that is missing, not one untried", () => {
    __setNotificationsModule(undefined);
    // Nothing to require under `bun test` either, so load() falls to its catch
    // and settles on null rather than leaving the sentinel untried.
    expect(notificationsSupported()).toBe(false);
  });

  test("permission granted and setup working: deliverable", async () => {
    const { mod } = fakeModule();
    __setNotificationsModule(mod);
    expect(await alertsDeliverable()).toEqual({ ok: true });
  });

  test("permission granted but the channel refused: NOT deliverable", async () => {
    const { mod } = fakeModule({ channelThrows: true });
    __setNotificationsModule(mod);
    const d = await alertsDeliverable();
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.why).toBe("setup-failed");
  });

  test("permission granted and the channel switched off in Android: NOT deliverable", async () => {
    const { mod } = fakeModule({ channelImportance: ANDROID_IMPORTANCE.NONE });
    __setNotificationsModule(mod);
    const d = await alertsDeliverable();
    expect(d.ok === false && d.why).toBe("channel-off");
  });

  /** Taken away in system settings, where the app is never told. Asked of the
   *  OS every time rather than remembered, which is the whole fix. */
  test("permission revoked after it was once granted: NOT deliverable, on the next ask", async () => {
    const { mod, state } = fakeModule();
    __setNotificationsModule(mod);
    expect(await alertsDeliverable()).toEqual({ ok: true });
    state.granted = false;
    expect(await alertsDeliverable()).toEqual({ ok: false, why: "denied" });
  });

  /** A failed setup is not a life sentence. The boolean latch had no way back:
   *  one refused channel and the app was deaf until it was killed. */
  test("a setup that failed once is retried, not latched", async () => {
    const { mod, state } = fakeModule({ channelThrows: true });
    __setNotificationsModule(mod);
    expect((await alertsDeliverable()).ok).toBe(false);
    state.channelThrows = false;
    expect(await alertsDeliverable()).toEqual({ ok: true });
  });
});

describe("raising one", () => {
  test("it posts, and says it did", async () => {
    const { mod, state } = fakeModule();
    __setNotificationsModule(mod);
    expect(await raise(NOTE)).toEqual({ ok: true });
    expect(state.posted).toEqual([{ title: NOTE.title, body: NOTE.body }]);
  });

  /** The silent return this whole file exists to remove. */
  test("it never fails silently: every refusal comes back with a reason", async () => {
    const { mod } = fakeModule({ channelImportance: ANDROID_IMPORTANCE.NONE });
    __setNotificationsModule(mod);
    const d = await raise(NOTE);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.why).toBe("channel-off");
    expect(lastAlertFailure()).toEqual(d);
  });

  test("a post that Android rejects is reported, not swallowed", async () => {
    const { mod } = fakeModule({ scheduleThrows: true });
    __setNotificationsModule(mod);
    const d = await raise(NOTE);
    expect(d.ok === false && d.why).toBe("threw");
  });

  test("asking from the switch reports what can be DELIVERED, not what the dialog said", async () => {
    // Permission is about to be granted, and the channel is still off: a phone
    // that cannot buzz. The old flow returned the permission result and drew
    // the switch ON.
    const { mod } = fakeModule({ granted: false, channelImportance: ANDROID_IMPORTANCE.NONE });
    __setNotificationsModule(mod);
    const d = await askForAlerts();
    expect(d.ok === false && d.why).toBe("channel-off");
  });
});

/*
 * The dedupe window, and the two ways of getting it wrong.
 *
 * host-context.tsx opened it on the line BEFORE `void raise(alert)`, so a phone
 * whose channel was switched off in Android's settings drew nothing and still
 * spent the window. It was then moved behind the raise — and the reason given
 * was wrong: "the server re-broadcasts on reconnect, which is the app's one
 * natural retry". Grepped: `{type:"alert"}` has exactly one producer,
 * `index.ts:502`, reached only when an alert happens, and a socket that
 * attaches is sent `{type:"initial"}`. Nothing is replayed.
 *
 * Moving it also opened a race, which is the second test below: `raise` is
 * async, and two identical alerts inside that await both find an empty map.
 *
 * So the window is opened first and rolled back on failure, and both tests here
 * drive the same three lines host-context.tsx runs.
 */
describe("the dedupe window is opened first and taken back if nothing was drawn", () => {
  test("a dropped alert does not spend its window", async () => {
    const { mod, state } = fakeModule({ channelImportance: ANDROID_IMPORTANCE.NONE });
    __setNotificationsModule(mod);
    const lastSeen = new Map<string, number>();
    const now = Date.now();

    // The path host-context takes for an incoming frame.
    const undo = remember(NOTE, { lastSeen, now });
    const first = await raise(NOTE);
    if (!first.ok) undo();
    expect(first.ok).toBe(false);
    expect(lastSeen.has(alertKey(NOTE))).toBe(false);

    // The channel comes back on and the situation happens again. Nothing about
    // this alert is inside the 90-second window, so it is allowed through.
    state.channelImportance = ANDROID_IMPORTANCE.HIGH;
    expect(shouldNotify(NOTE, { foreground: false, lastSeen, now: now + 1_000 })).toEqual({ notify: true });
    const undo2 = remember(NOTE, { lastSeen, now: now + 1_000 });
    const second = await raise(NOTE);
    if (!second.ok) undo2();
    expect(second).toEqual({ ok: true });
    expect(state.posted.length).toBe(1);
  });

  test("a second copy arriving DURING the raise does not buzz as well", async () => {
    // The race the deferred version had, and the reason the window is opened
    // before the await rather than after it. `raise` is not resolved here: this
    // is exactly the gap in which the old code's map still said nothing.
    const { mod } = fakeModule();
    __setNotificationsModule(mod);
    const lastSeen = new Map<string, number>();
    const now = Date.now();

    const inFlight = raise(NOTE);
    remember(NOTE, { lastSeen, now });
    expect(shouldNotify(NOTE, { foreground: false, lastSeen, now: now + 5 }))
      .toEqual({ notify: false, because: "repeat" });
    expect(await inFlight).toEqual({ ok: true });
  });

  test("a delivered alert keeps its window, so the same situation twice buzzes once", async () => {
    const { mod } = fakeModule();
    __setNotificationsModule(mod);
    const lastSeen = new Map<string, number>();
    const now = Date.now();

    const undo = remember(NOTE, { lastSeen, now });
    const d = await raise(NOTE);
    if (!d.ok) undo();
    expect(shouldNotify(NOTE, { foreground: false, lastSeen, now: now + SAME_ALERT_MS - 1 }))
      .toEqual({ notify: false, because: "repeat" });
  });

  test("rolling back restores the earlier window instead of clearing it", async () => {
    // A delete would be wrong: an earlier delivery of the same alert has its
    // own live window, and taking the key out would let that one buzz again.
    const { mod, state } = fakeModule();
    __setNotificationsModule(mod);
    const lastSeen = new Map<string, number>();
    const now = Date.now();

    remember(NOTE, { lastSeen, now });                    // delivered a moment ago
    state.channelImportance = ANDROID_IMPORTANCE.NONE;    // …and now the channel is off
    const undo = remember(NOTE, { lastSeen, now: now + 1_000 });
    const d = await raise(NOTE);
    expect(d.ok).toBe(false);
    undo();

    expect(lastSeen.get(alertKey(NOTE))).toBe(now);
    expect(shouldNotify(NOTE, { foreground: false, lastSeen, now: now + 1_000 }))
      .toEqual({ notify: false, because: "repeat" });
  });
});
