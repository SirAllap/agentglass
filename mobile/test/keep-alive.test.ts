/*
 * The foreground keep-alive service, which lifts this process to FGS state so
 * Android 15 (API 35) does not cut its network a few seconds after the screen
 * goes off. See src/notifications/keepAlive.ts for the full story.
 *
 * `wantKeepAlive` is pure and gets a truth table. The native side (a Kotlin
 * service, a manifest, a module) has no `bun test` runtime, so what is
 * checked instead is the SOURCE: the shape a reviewer would otherwise have to
 * read by eye every time this file changes. Each guard here was broken once
 * on purpose and watched go red before being trusted — see the comments next
 * to each assertion for what that break was.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// react-native's entry point is Flow, not TypeScript, and importing it under
// `bun test` is a syntax error — see notify-deliverable.test.ts's identical
// comment. keepAlive.ts wants exactly Platform.OS, a constant, so it is stood
// up rather than the module. Registered before the dynamic import below,
// which is why this is not a static `import` at the top: a static import of
// keepAlive.ts would be hoisted above this mock and load the real
// react-native first.
mock.module("react-native", () => ({ Platform: { OS: "android" } }));

let wantKeepAlive: typeof import("../src/notifications/keepAlive.ts").wantKeepAlive;

beforeAll(async () => {
  ({ wantKeepAlive } = await import("../src/notifications/keepAlive.ts"));
});

const root = join(import.meta.dir, "..");
const manifest = readFileSync(
  join(root, "modules/agx-keepalive/android/src/main/AndroidManifest.xml"),
  "utf8",
);
const service = readFileSync(
  join(root, "modules/agx-keepalive/android/src/main/java/app/agentglass/keepalive/KeepAliveService.kt"),
  "utf8",
);
const keepAliveSource = readFileSync(join(root, "src/notifications/keepAlive.ts"), "utf8");
const hostContext = readFileSync(join(root, "src/state/host-context.tsx"), "utf8");
const moduleKt = readFileSync(
  join(root, "modules/agx-keepalive/android/src/main/java/app/agentglass/keepalive/KeepAliveModule.kt"),
  "utf8",
);
const settings = readFileSync(join(root, "app/(tabs)/settings.tsx"), "utf8");

describe("wantKeepAlive", () => {
  test("alerts that cannot be delivered are nothing to keep alive for", () => {
    expect(wantKeepAlive({ alertsOk: false, pref: true })).toBe(false);
  });

  test("the owner's own switch, off, is off", () => {
    expect(wantKeepAlive({ alertsOk: true, pref: false })).toBe(false);
  });

  test("both on is the only yes", () => {
    expect(wantKeepAlive({ alertsOk: true, pref: true })).toBe(true);
  });
});

describe("the manifest", () => {
  test("declares both foreground-service permissions", () => {
    // Broken on purpose: dropping FOREGROUND_SERVICE_REMOTE_MESSAGING leaves
    // this failing.
    expect(manifest).toContain("android.permission.FOREGROUND_SERVICE\"");
    expect(manifest).toContain("android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING\"");
  });

  test("declares the service with the remoteMessaging type", () => {
    // Broken on purpose: a service declared without foregroundServiceType, or
    // with a different type string, fails this.
    expect(manifest).toMatch(/android:name="app\.agentglass\.keepalive\.KeepAliveService"/);
    expect(manifest).toContain('android:foregroundServiceType="remoteMessaging"');
  });
});

describe("the service", () => {
  test("requests the quietest channel and stays silent", () => {
    // Broken on purpose: IMPORTANCE_DEFAULT or a missing setSilent(true) both
    // fail this — either would make the keep-alive notification behave like
    // an alert, which is the one thing it must never do.
    //
    // This checks the REQUEST, not what the phone draws: measured on the API
    // 35 emulator (`adb shell dumpsys notification`), Android raises a
    // foreground service's own channel from MIN to LOW regardless — a
    // status-bar icon shows. "Minimum importance" was wrong to claim anywhere
    // as a result; "silent" still holds, and is what setSilent(true) is for.
    expect(service).toContain("NotificationManager.IMPORTANCE_MIN");
    expect(service).toContain("setSilent(true)");
  });

  test("returns START_NOT_STICKY, not a restart with no JS behind it", () => {
    expect(service).toMatch(/return START_NOT_STICKY/);
  });

  test("does not use the launcher icon as the status-bar icon", () => {
    // Broken on purpose: applicationInfo.icon is the adaptive launcher icon,
    // which renders as a plain white blob in the status bar and shade (and
    // has crashed SystemUI on 8.0) — a notification's small icon has to be
    // its own monochrome asset.
    expect(service).not.toContain("applicationInfo.icon");
    expect(service).toContain("R.drawable.ic_agx_keepalive");
  });

  test("wraps startForeground in a try/catch that stops the service on failure", () => {
    // Broken on purpose: removing the try or the stopSelf() call lets a
    // refused channel, a null launch intent, or the OS refusing
    // startForeground itself crash the whole process — taking the socket
    // this service exists to protect down with it.
    const body = service.match(/override fun onStartCommand\([^)]*\): Int \{([\s\S]*)\n {2}\}/)?.[1] ?? "";
    expect(body).toMatch(/try \{/);
    expect(body).toMatch(/catch \(e: Exception\) \{\s*stopSelf\(\)/);
  });

  test("tracks running from its own onCreate/onDestroy, for isRunning() to read", () => {
    // Broken on purpose: dropping either override, or the module reading a
    // flag it sets on start() success instead, leaves this switch answering
    // "on" after the OS or the person has already killed the service.
    expect(service).toMatch(/override fun onCreate\(\) \{\s*super\.onCreate\(\)\s*running = true/);
    expect(service).toMatch(/override fun onDestroy\(\) \{\s*running = false/);
  });
});

describe("the module", () => {
  test("isRunning reads the service's own lifecycle, not a locally-set flag", () => {
    // Broken on purpose: `private var running = false` set from start()'s
    // return is the bug this guards — it never learns the service stopped
    // any other way.
    expect(moduleKt).not.toContain("private var running");
    expect(moduleKt).toMatch(/Function\("isRunning"\) \{\s*KeepAliveService\.running/);
  });

  test("has no API-31-only catch redundant with the Exception catch below it", () => {
    // Broken on purpose: re-adding
    // `catch (e: ForegroundServiceStartNotAllowedException)` is exactly what
    // Lint's NewApi flags on a module whose minSdk is below 31, and it added
    // nothing the generic catch does not already cover.
    expect(moduleKt).not.toContain("ForegroundServiceStartNotAllowedException");
  });
});

describe("keepAlive.ts", () => {
  test("never imports expo-modules-core at the top of the file", () => {
    // Broken on purpose: `import { requireOptionalNativeModule } from
    // "expo-modules-core"` at module scope is exactly the mistake
    // test/native-imports.test.ts polices for expo-notifications, and it
    // would take down every platform this file is reached from (web, Expo
    // Go, iOS) the same way.
    expect(/^\s*import[^\n]*["']expo-modules-core["']/m.test(keepAliveSource)).toBe(false);
  });

  test("requires it lazily instead, inside a function", () => {
    expect(keepAliveSource).toMatch(/require\("expo-modules-core"\)/);
  });

  test("gates availability on Android, not just on the module resolving", () => {
    // Broken on purpose: without the Platform.OS check, Settings would gate
    // its row on something true on iOS too the moment any native module of
    // that name existed there, which it never will — but the check is what
    // makes that impossible rather than accidental.
    expect(keepAliveSource).toMatch(/Platform\.OS === "android"/);
  });
});

describe("host-context.tsx", () => {
  test("syncs the keep-alive service only on the ACTIVE path", () => {
    // Broken on purpose: moving `syncNow()` outside the `onChange`/mount-if-
    // active block (say, into the socket effect that also runs while
    // backgrounded) fails this — Android refuses to start a foreground
    // service from a process that is not itself foregrounded, so a call site
    // that is not gated on ACTIVE would fail silently on every real device.
    const activeBlock = hostContext.match(/if \(AppState\.currentState === "active"\) \{[^}]*\}/)?.[0] ?? "";
    const onChangeBlock = hostContext.match(/if \(state === "active"\) \{[^}]*\}/)?.[0] ?? "";
    expect(activeBlock).toContain("syncNow()");
    expect(onChangeBlock).toContain("syncNow()");
  });

  test("calls syncNow() from exactly those two places, and nowhere else", () => {
    // Broken on purpose: a THIRD call site (say, added to the socket effect
    // that also runs while backgrounded) passes the test above unchanged —
    // it only checks the two known blocks CONTAIN a call, not that no other
    // one exists.
    expect(hostContext.match(/syncNow\(\)/g)?.length).toBe(2);
  });

  test("stops the service on forget()", () => {
    expect(hostContext).toMatch(/forget: async \(\): Promise<void> => \{\s*syncKeepAlive\(false\)/);
  });

  test("stops the service on a revoked credential, not just on forget()", () => {
    // Broken on purpose: the 401 REVOKED path used to call forgetHost() and
    // setHost(null) with no syncKeepAlive(false) — a revoke noticed while the
    // phone is in the background left the service (and its notification) up
    // after the pairing was already gone.
    const revokedBlock = hostContext.match(/if \(!gates\.ok && gates\.error === REVOKED\) \{[\s\S]*?\n {4}\}/)?.[0] ?? "";
    expect(revokedBlock).toContain("syncKeepAlive(false)");
  });

  test("the ACTIVE-path effect stops the service the moment host goes null", () => {
    // Broken on purpose: reverting to a plain `if (!host) return;` is exactly
    // the bug above's OTHER path — whatever set `host` to null (forget(),
    // revoke, anything later) left the effect's own cleanup as the only thing
    // that could stop it, and that cleanup does not run syncKeepAlive at all.
    expect(hostContext).toMatch(/if \(!host\) \{ syncKeepAlive\(false\); return; \}/);
  });

  test("syncNow checks an `alive` flag before acting, cleared on teardown", () => {
    // Broken on purpose: dropping the check (or the `alive = false` in
    // cleanup) lets a sync already in flight when this effect tears down
    // resolve afterwards and call start() — including right after a
    // syncKeepAlive(false) from forget() or a revoke.
    expect(hostContext).toMatch(/let alive = true;/);
    expect(hostContext).toMatch(/if \(!alive\) return;/);
    expect(hostContext).toMatch(/return \(\) => \{ alive = false; stop\(\); sub\.remove\(\); \};/);
  });
});

describe("app/(tabs)/settings.tsx", () => {
  test("gates the row on Android and the native module being present", () => {
    // Broken on purpose: gating on `alerts?.ok` alone (the bug this guards)
    // draws the row — and a switch that does nothing when pressed — on iOS,
    // in Expo Go, and in any build without the module linked.
    expect(settings).toContain("keepAliveAvailable");
    expect(settings).toMatch(/alerts\?\.ok && canKeepAlive/);
  });

  test("the Note is drawn only where the row it names is drawn", () => {
    // Broken on purpose: the Note used to be unconditional — visible on iOS,
    // in Expo Go, and with alerts off, where there is no "Stay connected in
    // the background" switch for it to be talking about.
    const noteBlock = settings.match(/\{alerts\?\.ok && canKeepAlive \? \(\s*<View[\s\S]*?<\/View>\s*\) : null\}/)?.[0] ?? "";
    expect(noteBlock).toContain("Note");
  });

  test("shows what syncKeepAlive/keepAliveRunning actually answered, not the tap", () => {
    // Broken on purpose: `setKeepAlive(on)` before syncing (the original
    // code) draws ON through a start() Android refused.
    expect(settings).toMatch(/setKeepAlive\(syncKeepAlive\(/);
    expect(settings).toContain("keepAliveRunning()");
  });
});
