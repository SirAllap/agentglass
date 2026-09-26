/*
 * Whether this phone should be running the foreground service that keeps its
 * process out of Android 15's background network block, and the switch that
 * starts or stops it.
 *
 * ── the block this works around ───────────────────────────────────────────
 * On API 35 the network is cut for a process below FOREGROUND_SERVICE state a
 * few seconds after it leaves the screen, and `openLive`'s socket dies with
 * it — every alert that would have arrived while the phone was in a pocket is
 * lost, not delayed. A foreground service lifts the process to FGS state,
 * which is exempt from that block and from Doze's, and the JS keeps running
 * in the same process: the socket and the `raise()` path in host-context.tsx
 * are unchanged.
 *
 * ── why a preference, defaulted on ────────────────────────────────────────
 * The service posts a notification — Android will not grant foreground state
 * without one — and that is a cost the owner should be able to decline. It
 * defaults to true anyway: the blocked-agent alert is the one thing this app
 * exists to not miss, and the notification itself asks for the quietest
 * channel Android allows: silent, no badge, no sound. Measured on the API 35
 * emulator: a MIN-importance channel still gets a status-bar icon — the
 * system will not go below LOW for a foreground service's own notification —
 * so this is silent and unobtrusive, not invisible. See KeepAliveService.kt.
 *
 * ── why the keystore comes from termPrefs.ts ──────────────────────────────
 * Not a second copy of the lazy `require("expo-secure-store")`: termPrefs.ts
 * already has one, exported as `keystore()`, with the same Metro constraint
 * (the require has to be a literal string, not a name passed to a shared
 * helper — see its own comment) and the same reason it has to be lazy at all
 * — `bun test` cannot import expo-secure-store as a value at module scope:
 * the import resolves through expo-modules-core to the real react-native
 * package, and react-native's own `index.js` is Flow source Bun's transpiler
 * cannot parse outside a React-Native-aware build ("Unexpected typeof" on
 * `import typeof * as ReactNativePublicAPI …`). Measured: a plain
 * `import * as SecureStore from "expo-secure-store"` at the top of this file
 * fails every test that imports anything from it, including `wantKeepAlive`,
 * which touches no storage at all.
 */
import { Platform } from "react-native";
import { keystore } from "../terminal/termPrefs.ts";

const PREF_KEY = "agx.keepAlive";

export interface WantInputs {
  alertsOk: boolean;
  pref: boolean;
}

/** Pure: whether the foreground service should be running right now. Both
 *  have to hold — a phone that cannot raise an alert has nothing to keep
 *  alive for, and the switch is the owner's own no. (A third condition used
 *  to live here — "paired" — but every call site passed `true`: there is no
 *  path to either check that runs on an unpaired phone, so it was dead
 *  weight a truth table had to carry anyway.) */
export function wantKeepAlive({ alertsOk, pref }: WantInputs): boolean {
  return alertsOk && pref;
}

/** Default true: see the file comment above. */
export async function loadKeepAlivePref(): Promise<boolean> {
  const store = keystore();
  if (!store) return true;
  try {
    const raw = await store.getItemAsync(PREF_KEY);
    if (raw === null) return true;
    return raw === "1";
  } catch {
    // A keystore that will not open is not a "no" — it is the same as never
    // having been asked, and the default holds.
    return true;
  }
}

export async function saveKeepAlivePref(on: boolean): Promise<void> {
  const store = keystore();
  if (!store) return;
  try {
    await store.setItemAsync(PREF_KEY, on ? "1" : "0");
  } catch {
    /* Nothing this call can do differently; the next load falls back to the
       same default it would have used anyway. */
  }
}

/** `undefined` until asked, `null` once asked and found missing — same three
 *  states as notify.ts's `module`, and for the same reason: a build without
 *  this native module (Expo Go, iOS, web) is not an error to retry. */
let native: typeof import("expo-modules-core") | null | undefined;

function loadNative(): typeof import("expo-modules-core") | null {
  if (native !== undefined) return native;
  try {
    // Required lazily, inside the function, behind a try — see
    // test/native-imports.test.ts's rule and notify.ts's version of the same
    // guard. A top-level import of expo-modules-core would run this module's
    // native lookup on every platform this file is reached from, including
    // web and Expo Go, where there is no "AgxKeepAlive" to find.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    native = require("expo-modules-core") as typeof import("expo-modules-core");
  } catch {
    native = null;
  }
  return native;
}

interface AgxKeepAlive {
  start(): boolean;
  stop(): boolean;
  isRunning(): boolean;
}

/** Reset for tests: see notify.ts's __setNotificationsModule for the same
 *  reasoning — module-scope state has to be resettable or one test's stub
 *  leaks into the next. */
export function __resetKeepAliveModule(): void {
  native = undefined;
}

function loadModule(): AgxKeepAlive | null {
  const core = loadNative();
  if (!core) return null;
  try {
    return core.requireOptionalNativeModule<AgxKeepAlive>("AgxKeepAlive");
  } catch {
    return null;
  }
}

/**
 * Whether this build even HAS the switch — Android only, and only where the
 * native module linked. iOS and web have no service to keep alive; Expo Go
 * and a build without the module answer the same way `null` does elsewhere in
 * this file. Settings gates the row on this rather than drawing a switch that
 * would do nothing wherever it answers false.
 */
export function keepAliveAvailable(): boolean {
  return Platform.OS === "android" && loadModule() !== null;
}

/**
 * Whether the service is ACTUALLY running right now, asked of the native side
 * rather than assumed from the saved preference. `KeepAliveModule.isRunning()`
 * reads `KeepAliveService`'s own lifecycle (set in its onCreate/onDestroy), so
 * this answers "no" the moment the OS or the person kills the service from
 * Android's own UI — a case the preference alone cannot see and would
 * otherwise keep drawing the switch ON forever.
 */
export function keepAliveRunning(): boolean {
  return loadModule()?.isRunning() ?? false;
}

/**
 * Start or stop the service to match `want`, and answer what is actually
 * running afterwards.
 *
 * On web, Expo Go, or iOS there is no "AgxKeepAlive" native module at all —
 * `requireOptionalNativeModule` answers `null` rather than throwing, which is
 * exactly the shape a no-op wants. Any exception the native side raises (see
 * KeepAliveModule.kt: Android can refuse to start a foreground service) is
 * swallowed here too, because a phone this fails on should still be a working
 * app with alerts that just do not survive the background as long — and the
 * `false` this returns in that case is the true answer, not a fallback.
 */
export function syncKeepAlive(want: boolean): boolean {
  const mod = loadModule();
  if (!mod) return false;
  try {
    if (want) return mod.start();
    mod.stop();
    return false;
  } catch {
    /* See the file comment: nothing here may take the app down. */
    return false;
  }
}
