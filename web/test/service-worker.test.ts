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
function loadWorker(opts: { clients?: any[] } = {}) {
  const listeners = new Map<string, (e: any) => void>();
  const shown: Shown[] = [];
  const opened: string[] = [];
  const focused: string[] = [];
  const waits: Promise<unknown>[] = [];
  let claimed = false, skipped = false;

  const windows = (opts.clients ?? []).map((c) => ({
    ...c,
    focus() { focused.push(c.url); return Promise.resolve(this); },
  }));

  const scope = {
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

  return { fire, shown, opened, focused, listeners, waits,
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

  it("dismisses the notification it came from", async () => {
    let closed = false;
    const w = loadWorker({ clients: [{ url: "https://box.local/" }] });
    await w.fire("notificationclick", { notification: { close() { closed = true; } } });
    expect(closed).toBe(true);
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
