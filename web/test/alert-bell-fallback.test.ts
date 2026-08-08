import { test, expect, beforeAll, beforeEach } from "bun:test";

/*
 * The bell must not be gated on the thing it is a fallback FOR.
 *
 * `fireDesktopAlert` had `recordNote` as its last statement, under two early
 * returns — `typeof Notification === "undefined"` and `Notification.permission
 * !== "granted"`. The comment above that line says what the row is for: "the
 * desktop notification is gone in four seconds; the row behind the notch is
 * what is still there when somebody comes back to the machine." So in exactly
 * the case where the transient popup cannot happen, the durable record did not
 * happen either, and every surface said the machine had been quiet.
 *
 * How often that fired depended on the surface, and all three were measured
 * rather than reasoned about:
 *
 *   agentglass://app in the desktop shell   secure, "granted"  (Electron 43.3.0,
 *                                           the app's own privileged scheme, and
 *                                           no permission handler anywhere in
 *                                           main.js — the installed app.asar has
 *                                           none either)
 *   http://127.0.0.1:PORT in Chrome         secure, "default"
 *   http://<lan-ip>:PORT in Chrome          insecure, "denied"
 *
 * So the desk was fine and every browser tab lost both halves — and, since the
 * app has never called requestPermission in its life, "default" is where a tab
 * stayed for ever.
 */

const cell = new Map<string, string>();
let sysNotify: typeof import("../src/lib/sysNotify.ts");

/** The three answers a browser can give, plus the host that has no such API. */
let permission: NotificationPermission = "granted";
let asked = 0;
let built = 0;

class FakeNotification {
  static get permission(): NotificationPermission { return permission; }
  static requestPermission(): Promise<NotificationPermission> {
    asked++;
    return Promise.resolve(permission);
  }
  onclick: (() => void) | null = null;
  constructor(_title: string, _opts?: unknown) { built++; }
  close() { /* nothing to tear down */ }
}

beforeAll(async () => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  (globalThis as any).Notification = FakeNotification;
  sysNotify = await import("../src/lib/sysNotify.ts");
});

beforeEach(() => {
  sysNotify.clearNotes();
  permission = "granted";
  asked = 0;
  built = 0;
});

test("granted: the popup and the bell row, as before", () => {
  sysNotify.fireDesktopAlert({ title: "✋ Approval needed", body: "agentglass · main:3", urgency: 2, pane: "%8" });
  expect(built).toBe(1);
  const history = sysNotify.notifyHistory();
  expect(history.length).toBe(1);
  expect(history[0]!.summary).toBe("✋ Approval needed");
  // The destination travels with it. This is the only place that still has the
  // pane as a fact rather than as a phrase.
  expect(history[0]!.goto).toEqual({ kind: "pane", pane: "%8" });
});

test("default — a browser tab nobody has asked — still writes the bell row", () => {
  permission = "default";
  sysNotify.fireDesktopAlert({ title: "❌ Tool error", body: "agentglass · Bash failed", urgency: 2 });
  expect(built).toBe(0); // no popup is possible, and that is the point
  expect(sysNotify.notifyHistory().length).toBe(1);
  expect(sysNotify.notifyHistory()[0]!.summary).toBe("❌ Tool error");
});

test("denied — an insecure origin — still writes the bell row", () => {
  permission = "denied";
  sysNotify.fireDesktopAlert({ title: "⏳ Approval needed", body: "agentglass is waiting", urgency: 2 });
  expect(built).toBe(0);
  expect(sysNotify.notifyHistory().length).toBe(1);
});

test("a host with no Notification API at all still writes the bell row", () => {
  const saved = (globalThis as any).Notification;
  delete (globalThis as any).Notification;
  try {
    sysNotify.fireDesktopAlert({ title: "🔔 heads up", body: "agentglass", urgency: 1 });
    expect(sysNotify.notifyHistory().length).toBe(1);
  } finally {
    (globalThis as any).Notification = saved;
  }
});

/*
 * And the ask, which never existed.
 *
 * alerts.ts claimed "the browser then asks its own permission before anything
 * native happens (sysNotify.ts:178)". sysNotify.ts:178 was `shouldInterrupt`, a
 * product rule about urgency. Nothing asked, anywhere.
 */
test("switching agentglass's own notifications ON asks the browser, once", async () => {
  permission = "default";
  sysNotify.setAppNotify(false);
  asked = 0;

  sysNotify.setAppNotify(true);
  await Promise.resolve();
  expect(asked).toBe(1);

  // Answered now, so there is nothing left to ask: re-asking would spend a user
  // gesture on a dialog the browser will not show.
  permission = "granted";
  sysNotify.setAppNotify(false);
  sysNotify.setAppNotify(true);
  await Promise.resolve();
  expect(asked).toBe(1);
});

test("a denied browser is never asked again — script cannot undo that", async () => {
  permission = "denied";
  sysNotify.setAppNotify(false);
  asked = 0;
  sysNotify.setAppNotify(true);
  await Promise.resolve();
  expect(asked).toBe(0);
  expect(sysNotify.notifyPermission()).toBe("denied");
});
