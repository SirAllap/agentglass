/*
 * The service worker, evaluated as the browser evaluates it.
 *
 * public/sw.js is the one file in the project that runs when nothing else
 * does: the tab is closed, the app is not loaded, and a push message arrives
 * anyway. There is no console to read and no UI to look at, so a mistake in it
 * is invisible — the phone simply never buzzes, or buzzes with the browser's
 * own "This site has been updated in the background", which says nothing.
 *
 * So this reads the shipped file and runs it against a fake global scope,
 * rather than testing a TypeScript copy of the same logic. A copy would drift,
 * and the copy is not what gets served.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../public/sw.js", import.meta.url).pathname, "utf8");

interface Shown { title: string; options: Record<string, any> }

/** Enough of a ServiceWorkerGlobalScope to run the file and see what it did. */
interface Sent { url: string; init: any }

/**
 * @param auth what the page mirrored into IndexedDB, or null for a device that
 *   never did — which is what a worker on a phone that has not paired sees.
 * @param reply how the server answers /gate/decide.
 */
function loadWorker(opts: {
  clients?: any[];
  auth?: { origin: string; token: string } | null;
  reply?: { status?: number; body?: unknown; throws?: boolean };
} = {}) {
  const listeners = new Map<string, (e: any) => void>();
  const shown: Shown[] = [];
  const opened: string[] = [];
  const focused: string[] = [];
  const waits: Promise<unknown>[] = [];
  let claimed = false, skipped = false;

  const messaged: { url: string; data: unknown }[] = [];
  // One list, so the order of the two is a fact rather than an inference.
  const order: string[] = [];
  const windows = (opts.clients ?? []).map((c) => ({
    ...c,
    focus() { order.push("focus"); focused.push(c.url); return Promise.resolve(this); },
    postMessage(data: unknown) { order.push("message"); messaged.push({ url: c.url, data }); },
  }));

  // Enough IndexedDB for the worker's read: an object store with one key in
  // it, driven by the same onsuccess/onerror callbacks the real thing uses.
  const sent: Sent[] = [];
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined && opts.auth !== null) store.set("server", opts.auth);
  const settle = <T,>(req: any, ok: boolean, result?: T) => {
    queueMicrotask(() => {
      req.result = result;
      if (ok) req.onsuccess?.({}); else req.onerror?.({});
    });
    return req;
  };
  const fakeIdb = {
    open: () => {
      const req: any = {};
      const db = {
        createObjectStore: () => {},
        transaction: () => ({
          objectStore: () => ({ get: (k: string) => settle({}, true, store.get(k)) }),
        }),
      };
      return settle(req, true, db);
    },
  };

  const scope = {
    indexedDB: fakeIdb,
    fetch: (url: string, init: any) => {
      sent.push({ url, init });
      if (opts.reply?.throws) return Promise.reject(new Error("offline"));
      const status = opts.reply?.status ?? 200;
      return Promise.resolve({
        status,
        json: () => (opts.reply && "body" in opts.reply
          ? Promise.resolve(opts.reply.body)
          : Promise.resolve({ ok: true })),
      });
    },
    addEventListener: (type: string, fn: (e: any) => void) => { listeners.set(type, fn); },
    skipWaiting: () => { skipped = true; },
    registration: {
      scope: "https://box.local/",
      showNotification: (title: string, options: Record<string, any>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      claim: () => { claimed = true; return Promise.resolve(); },
      matchAll: () => Promise.resolve(windows),
      openWindow: (url: string) => { opened.push(url); return Promise.resolve(null); },
    },
  };

  // The real thing, run the way the browser runs it: as a script with `self`
  // as its global.
  new Function("self", SRC)(scope);

  const fire = async (type: string, event: Record<string, any>) => {
    const fn = listeners.get(type);
    if (!fn) throw new Error(`sw.js registered no ${type} listener`);
    fn({ waitUntil: (p: Promise<unknown>) => { waits.push(p); }, ...event });
    await Promise.all(waits);
  };

  return { fire, shown, opened, focused, messaged, order, listeners, waits, sent,
    get claimed() { return claimed; }, get skipped() { return skipped; } };
}

/** A PushMessageData, as the browser hands it over. */
const pushData = (payload: unknown) => ({
  json: () => {
    if (typeof payload === "string") return JSON.parse(payload); // throws, on purpose
    return payload;
  },
  text: () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
});

describe("taking over", () => {
  it("activates without waiting for every tab to close", async () => {
    // A phone that already has the app open keeps the previous worker until
    // every tab is gone. The first subscribe after an update would then attach
    // to a worker with no push handler, and the alerts would silently not
    // arrive — the worst possible failure for this feature, because there is
    // nothing anywhere to see.
    const w = loadWorker();
    await w.fire("install", {});
    expect(w.skipped).toBe(true);
    await w.fire("activate", {});
    expect(w.claimed).toBe(true);
  });
});

describe("a push arrives", () => {
  it("shows what the server sent", async () => {
    const w = loadWorker();
    await w.fire("push", {
      data: pushData({ title: "⏳ Approval needed", body: "claude-code:a1b2 is waiting (Bash).", at: 1_700_000_000_000, urgency: 2 }),
    });
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]!.title).toBe("⏳ Approval needed");
    expect(w.shown[0]!.options.body).toBe("claude-code:a1b2 is waiting (Bash).");
  });

  it("waits for the notification before letting the worker die", async () => {
    // Without waitUntil the browser is free to tear the worker down the moment
    // the handler returns. The push arrives, the process ends, and nothing is
    // ever shown — intermittently, and only on a real device.
    const w = loadWorker();
    await w.fire("push", { data: pushData({ title: "t", body: "b" }) });
    expect(w.waits.length).toBeGreaterThan(0);
  });

  it("keeps a held gate on screen, and lets an FYI fade", async () => {
    // An agent is stopped until somebody answers. A notification that fades
    // after four seconds while the phone is face-down is the same as no
    // notification at all.
    const w = loadWorker();
    await w.fire("push", { data: pushData({ title: "✋", body: "gate", urgency: 2 }) });
    expect(w.shown[0]!.options.requireInteraction).toBe(true);
    await w.fire("push", { data: pushData({ title: "🔔", body: "note", urgency: 1 }) });
    expect(w.shown[1]!.options.requireInteraction).toBe(false);
  });

  it("shows when it happened, not when it was delivered", async () => {
    // A push service holds a message for up to the TTL — twelve hours. A phone
    // coming back online should say "3h ago", which is true, not "now".
    const w = loadWorker();
    await w.fire("push", { data: pushData({ title: "t", body: "b", at: 1_700_000_000_000 }) });
    expect(w.shown[0]!.options.timestamp).toBe(1_700_000_000_000);
  });

  it("collapses an exact repeat instead of stacking it", async () => {
    // The server debounces by key, so a repeat is a retry or a reconnect, not
    // a second event. Four copies of one approval on a lock screen is how
    // people learn to swipe the whole app away.
    const w = loadWorker();
    await w.fire("push", { data: pushData({ title: "✋ Approval needed", body: "same" }) });
    await w.fire("push", { data: pushData({ title: "✋ Approval needed", body: "same" }) });
    await w.fire("push", { data: pushData({ title: "✋ Approval needed", body: "different" }) });
    expect(w.shown[0]!.options.tag).toBeTruthy();
    // Same alert, same tag: the second replaces the first on the lock screen.
    expect(w.shown[1]!.options.tag).toBe(w.shown[0]!.options.tag);
    // A different alert must not be swallowed by the one before it, which is
    // the mistake a single constant tag would make.
    expect(w.shown[2]!.options.tag).not.toBe(w.shown[0]!.options.tag);
    // And it must not silently re-buzz for the repeat.
    expect(w.shown[0]!.options.renotify).toBe(false);
  });
});

describe("a payload that is not what this worker expected", () => {
  // An older server pushing to a newer worker is the normal state of affairs
  // for a few minutes after an update, and a phone is exactly where nobody
  // sees a console error.

  it("still shows something when the payload is not JSON", async () => {
    const w = loadWorker();
    await w.fire("push", { data: pushData("not json at all") });
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]!.options.body).toBe("not json at all");
  });

  it("still shows something when there is no payload at all", async () => {
    const w = loadWorker();
    await w.fire("push", { data: null });
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]!.title).toBe("agentglass");
    expect(w.shown[0]!.options.body).toBeTruthy();
  });

  it("fills in a missing title or body rather than showing 'undefined'", async () => {
    const w = loadWorker();
    await w.fire("push", { data: pushData({ body: "only a body" }) });
    expect(w.shown[0]!.title).toBe("agentglass");
    expect(w.shown[0]!.options.body).toBe("only a body");
    await w.fire("push", { data: pushData({ title: "only a title" }) });
    expect(w.shown[1]!.title).toBe("only a title");
    expect(String(w.shown[1]!.options.body)).not.toContain("undefined");
  });

  it("ignores fields of the wrong type instead of trusting them", async () => {
    const w = loadWorker();
    await w.fire("push", { data: pushData({ title: 42, body: { nested: true }, at: "yesterday" }) });
    expect(w.shown[0]!.title).toBe("agentglass");
    expect(typeof w.shown[0]!.options.body).toBe("string");
    expect(w.shown[0]!.options.body).not.toContain("[object Object]");
    expect(w.shown[0]!.options.timestamp).toBeUndefined();
  });
});

describe("tapping it", () => {
  it("focuses the app that is already open rather than opening a second one", async () => {
    // The app holds live socket state and a back stack. A fresh tab throws
    // both away: you tap an approval and land on a cold start.
    const w = loadWorker({ clients: [{ url: "https://box.local/#now" }] });
    await w.fire("notificationclick", { notification: { close() {} } });
    expect(w.focused).toEqual(["https://box.local/#now"]);
    expect(w.opened).toEqual([]);
  });

  it("opens one when nothing is running", async () => {
    const w = loadWorker({ clients: [] });
    await w.fire("notificationclick", { notification: { close() {} } });
    expect(w.opened).toEqual(["https://box.local/"]);
  });

  it("does not focus a window belonging to some other site", async () => {
    // matchAll with includeUncontrolled returns windows this worker can see
    // but does not own. Focusing one would raise an unrelated page when
    // somebody tapped an agentglass approval.
    const w = loadWorker({ clients: [{ url: "https://elsewhere.example/x" }] });
    await w.fire("notificationclick", { notification: { close() {} } });
    expect(w.focused).toEqual([]);
    expect(w.opened).toEqual(["https://box.local/"]);
  });

  it("tells the window why it was raised", async () => {
    // Focusing alone raises the app wherever it was left — the fleet, a diff, a
    // conversation. Tapping "Approval needed" would then show something else
    // entirely, with the thing you were woken for two taps away and
    // unmentioned.
    const w = loadWorker({ clients: [{ url: "https://box.local/#fleet" }] });
    await w.fire("notificationclick", { notification: { close() {} } });
    expect(w.messaged).toHaveLength(1);
    expect(w.messaged[0]!.data).toEqual({ type: "agentglass:opened-from-notification" });
  });

  it("says so before raising the window, not after", async () => {
    // `focus()` resolves when the window is actually up, which on a phone
    // waking from a locked screen is long enough to watch the wrong screen
    // paint first.
    const w = loadWorker({ clients: [{ url: "https://box.local/" }] });
    await w.fire("notificationclick", { notification: { close() {} } });
    expect(w.order).toEqual(["message", "focus"]);
  });

  it("does not message a window belonging to some other site", async () => {
    const w = loadWorker({ clients: [{ url: "https://elsewhere.example/x" }] });
    await w.fire("notificationclick", { notification: { close() {} } });
    expect(w.messaged).toEqual([]);
  });

  it("dismisses the notification it came from", async () => {
    let closed = false;
    const w = loadWorker({ clients: [{ url: "https://box.local/" }] });
    await w.fire("notificationclick", { notification: { close() { closed = true; } } });
    expect(closed).toBe(true);
  });
});

/**
 * The half that makes the notification worth having.
 *
 * A held gate stops an agent until a person answers, and until now the
 * notification could only say so — the answering was still tied to unlocking
 * the phone, finding the app and waiting for it to load. These are the buttons
 * that close that loop, and they run in the one place with no console, no UI
 * and nobody watching, so every branch is pinned.
 */
describe("answering a gate from the notification", () => {
  const AUTH = { origin: "https://box.local", token: "device-credential" };
  const gatePush = (gate: unknown = "gate-uuid-1") => ({
    data: pushData({ title: "✋ Approval needed", body: "claude-code:a1b2 wants to run Bash: rm -rf build", at: 1, urgency: 2, gate }),
  });

  it("a held gate arrives with Allow and Deny on it", async () => {
    const w = loadWorker();
    await w.fire("push", gatePush());
    expect(w.shown[0]!.options.actions).toEqual([
      { action: "allow", title: "Allow" },
      { action: "deny", title: "Deny" },
    ]);
    // …and the id it is about, so the click handler does not have to ask.
    expect(w.shown[0]!.options.data).toEqual({ gate: "gate-uuid-1" });
  });

  it("news does not", async () => {
    // Everything this app sends other than a held gate is news, and news with
    // buttons on it is a worse notification rather than a better one.
    const w = loadWorker();
    await w.fire("push", { data: pushData({ title: "❌ Tool error", body: "a tool failed.", urgency: 1 }) });
    expect(w.shown[0]!.options.actions).toBeUndefined();
    expect(w.shown[0]!.options.data).toBeUndefined();
  });

  it("and neither does a gate field that is not an id", async () => {
    // An older server sends none; a confused one could send anything. Buttons
    // that post `null` to /gate/decide are worse than no buttons.
    for (const junk of [null, 42, "", {}, []]) {
      const w = loadWorker();
      await w.fire("push", gatePush(junk));
      expect(w.shown[0]!.options.actions, JSON.stringify(junk)).toBeUndefined();
    }
  });

  it("tapping Allow decides it, with the credential the page mirrored", async () => {
    const w = loadWorker({ auth: AUTH });
    await w.fire("notificationclick", {
      action: "allow",
      notification: { close() {}, data: { gate: "gate-uuid-1" } },
    });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.url).toBe("https://box.local/gate/decide");
    expect(w.sent[0]!.init.method).toBe("POST");
    expect(JSON.parse(w.sent[0]!.init.body)).toEqual({ id: "gate-uuid-1", decision: "allow" });
    expect(w.sent[0]!.init.headers.authorization).toBe("Bearer device-credential");
  });

  it("tapping Deny sends deny, not allow", async () => {
    // The one mistake in here that cannot be undone by tapping again.
    const w = loadWorker({ auth: AUTH });
    await w.fire("notificationclick", {
      action: "deny",
      notification: { close() {}, data: { gate: "g" } },
    });
    expect(JSON.parse(w.sent[0]!.init.body).decision).toBe("deny");
  });

  it("and does not open the app, which is the entire point", async () => {
    // If answering raised a window, the buttons would be a slower way to do
    // what tapping the notification already did.
    const w = loadWorker({ auth: AUTH, clients: [{ url: "https://box.local/" }] });
    await w.fire("notificationclick", {
      action: "allow",
      notification: { close() {}, data: { gate: "g" } },
    });
    expect(w.opened).toEqual([]);
    expect(w.focused).toEqual([]);
  });

  it("tapping the notification itself still opens the queue", async () => {
    // The path every iPhone takes, since Safari draws no action buttons.
    const w = loadWorker({ auth: AUTH, clients: [{ url: "https://box.local/" }] });
    await w.fire("notificationclick", { notification: { close() {}, data: { gate: "g" } } });
    expect(w.sent).toEqual([]);
    expect(w.focused).toEqual(["https://box.local/"]);
  });

  it("says what the tap did", async () => {
    const w = loadWorker({ auth: AUTH });
    await w.fire("notificationclick", { action: "allow", notification: { close() {}, data: { gate: "g" } } });
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]!.options.body).toContain("Allowed");
    // Keyed to this gate, so answering one does not replace the notification
    // for another that is still waiting.
    expect(w.shown[0]!.options.tag).toBe("gate-result:g");
    expect(w.shown[0]!.options.requireInteraction).toBe(false);
  });

  it("a gate that was already answered says so, rather than nothing", async () => {
    // decideGate is idempotent: a gate decided at the desk, or one that timed
    // out while the phone was in a pocket, comes back not-ok. That is a real
    // answer and the person who just tapped is owed it.
    const w = loadWorker({ auth: AUTH, reply: { body: { ok: false } } });
    await w.fire("notificationclick", { action: "allow", notification: { close() {}, data: { gate: "g" } } });
    expect(w.shown[0]!.options.body).toContain("Already answered");
  });

  it("a device that was forgotten is told to pair again", async () => {
    const w = loadWorker({ auth: AUTH, reply: { status: 401 } });
    await w.fire("notificationclick", { action: "allow", notification: { close() {}, data: { gate: "g" } } });
    expect(w.shown[0]!.options.body).toContain("not connected any more");
  });

  it("a look-only device is told it is look-only, not that it failed", async () => {
    // 403 is a working credential that may not decide. Sending somebody to
    // re-pair a device that is paired fine fixes nothing.
    const w = loadWorker({ auth: AUTH, reply: { status: 403 } });
    await w.fire("notificationclick", { action: "allow", notification: { close() {}, data: { gate: "g" } } });
    expect(w.shown[0]!.options.body).toContain("paired to look, not to answer");
  });

  it("an unreachable machine says so, rather than claiming it was answered", async () => {
    const w = loadWorker({ auth: AUTH, reply: { throws: true } });
    await w.fire("notificationclick", { action: "allow", notification: { close() {}, data: { gate: "g" } } });
    expect(w.shown[0]!.options.body).toContain("Could not reach the computer");
    expect(w.shown[0]!.title).not.toContain("✓");
  });

  it("a worker with nothing mirrored sends no request at all", async () => {
    // Not a blind POST with no credential, which on a box with a token is a
    // 401 and on one without is an unauthenticated decision from anything that
    // can reach the port.
    const w = loadWorker({ auth: null });
    await w.fire("notificationclick", { action: "allow", notification: { close() {}, data: { gate: "g" } } });
    expect(w.sent).toEqual([]);
    expect(w.shown[0]!.options.body).toContain("not connected any more");
  });
});

/**
 * The two halves have to agree about where the credential is.
 *
 * The page writes it (src/lib/swAuth.ts) and the worker reads it (public/sw.js),
 * and neither can import from the other — a service worker has no module graph
 * and no build step here. So the database name, the store and the key are
 * written out twice, and a mutation testing pass cannot see a mismatch: both
 * files are individually correct and the feature silently does nothing.
 */
describe("where the page leaves it and where the worker looks", () => {
  const page = readFileSync(new URL("../src/lib/swAuth.ts", import.meta.url).pathname, "utf8");

  it("is the same database, store and key on both sides", () => {
    const names = (src: string) => ({
      db: src.match(/open\(\s*["'`]([^"'`]+)["'`]\s*,\s*1\s*\)/)?.[1]
        ?? src.match(/const DB = "([^"]+)"/)?.[1],
      store: src.match(/createObjectStore\((?:STORE|"([^"]+)")\)/)?.[1]
        ?? src.match(/const STORE = "([^"]+)"/)?.[1],
    });
    const w = names(SRC);
    expect(w.db, "sw.js does not open a database by a readable name").toBeTruthy();
    expect(page).toContain(`const DB = "${w.db}"`);
    // The store and the key are literals in the worker and constants in the
    // page; check the worker's literals appear as the page's values.
    const store = SRC.match(/\.transaction\("([^"]+)", "readonly"\)/)?.[1];
    const key = SRC.match(/\.objectStore\([^)]*\)\.get\("([^"]+)"\)/)?.[1];
    expect(store, "sw.js reads no object store").toBeTruthy();
    expect(key, "sw.js reads no key").toBeTruthy();
    expect(page).toContain(`const STORE = "${store}"`);
    expect(page).toContain(`const KEY = "${key}"`);
  });

  it("and the worker reads the two fields the page writes", () => {
    // `origin` decides where the decision is posted and `token` authorises it.
    // A rename on either side is a worker that posts to "undefined/gate/decide".
    expect(SRC).toContain("auth.origin");
    expect(SRC).toContain("auth.token");
    expect(page).toContain("origin: string");
    expect(page).toContain("token: string");
  });
});

describe("what this worker deliberately does not do", () => {
  it("caches nothing", async () => {
    // Not an offline shell. The app is useless without the server it reports
    // on, and a stale cached bundle pretending otherwise is worse than a
    // failed load — it would show yesterday's fleet as if it were now.
    expect(SRC).not.toContain("caches.open");
    expect(SRC).not.toContain("addEventListener(\"fetch\"");
  });
});
