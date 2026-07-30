/*
 * The service worker: the only part of agentglass that runs when the app is not.
 *
 * A Web Push message is delivered to this file, by the browser, with the tab
 * closed and the phone in a pocket. That is the entire point of the feature —
 * everything else in the notification path (a webhook, a desktop toast, the
 * socket) needs somebody already looking.
 *
 * Deliberately plain JavaScript in `public/`, copied verbatim by Vite rather
 * than bundled. A service worker is fetched by the browser at its own URL and
 * has no import map, no JSX and no TypeScript; making it a build target would
 * buy nothing and would let a bundler decide what runs in the one context that
 * has to keep working after everything else is gone. It is tested by being
 * evaluated as-is — see web/test/service-worker.test.ts — so what the suite
 * checks is this file, not a copy of it.
 *
 * Nothing here is cached. This is not an offline shell: the app is useless
 * without the server it reports on, and a stale cached bundle pretending
 * otherwise would be worse than a failed load.
 */

/**
 * Take over as soon as installed, rather than waiting for every tab to close.
 *
 * Without these, a phone that already had the app open keeps the previous
 * worker until every tab is gone — so the first subscribe after an update
 * would register against a worker that has no push handler, and the alerts
 * would simply not arrive, with nothing to see anywhere.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

var FALLBACK = { title: "agentglass", body: "Something needs you." };

/**
 * What arrived, as something showable.
 *
 * A push payload is JSON from this machine's own server, but "own server" is
 * not a guarantee of shape: an older server pushing to a newer worker is the
 * normal state of affairs for a few minutes after an update, and a phone is
 * exactly where nobody will see a console error. So every field is checked,
 * and anything missing falls back rather than throwing.
 *
 * Throwing here is not neutral. A push handler that rejects makes the browser
 * show its own "This site has been updated in the background" notification —
 * which tells the user nothing, cannot be acted on, and looks like a bug in
 * the app rather than a bug in the message.
 */
function toNotification(raw) {
  var data = null;
  try {
    data = raw && typeof raw.json === "function" ? raw.json() : null;
  } catch (e) {
    // Not JSON. Fall through to the text form below.
  }
  if (!data || typeof data !== "object") {
    var text = "";
    try { text = raw && typeof raw.text === "function" ? raw.text() : ""; } catch (e) { /* nothing usable */ }
    data = text ? { body: text } : {};
  }
  var title = typeof data.title === "string" && data.title ? data.title : FALLBACK.title;
  var body = typeof data.body === "string" && data.body ? data.body : FALLBACK.body;
  return {
    title: title,
    options: {
      body: body,
      // Rasters, not the SVG that used to be here. Chrome on Android is not
      // expected to draw an SVG notification icon and falls back to a generic
      // glyph, so every alert this app sent arrived wearing somebody else's
      // mark. The badge is a separate, monochrome file because Android throws
      // the colours away and draws it from the alpha channel — the full mark
      // reduced to a stencil is a blob.
      icon: "./icon-192.png",
      badge: "./icon-badge.png",
      // Two pushes carrying the same thing collapse into one notification
      // instead of stacking. The server already debounces by key, so a repeat
      // means a retry or a reconnect, not a second event — and a lock screen
      // with the same approval on it four times is how people learn to swipe
      // the whole app away.
      tag: title + "\n" + body,
      // A held gate stays on screen until it is dealt with: an agent is
      // stopped until a human answers, and a toast that fades after four
      // seconds while the phone is face-down is the same as no toast. Anything
      // less than urgency 2 is informational and is allowed to disappear.
      requireInteraction: data.urgency === 2,
      // The timestamp the server stamped, not the moment of delivery. A push
      // service holds a message for up to the TTL — twelve hours here — so a
      // phone coming back online shows "3h ago", which is the truth, rather
      // than "now", which is not.
      timestamp: typeof data.at === "number" ? data.at : undefined,
      renotify: false,
    },
  };
}

self.addEventListener("push", function (event) {
  var n = toNotification(event.data);
  // waitUntil, or the worker may be killed before the notification is shown —
  // the push arrives, the process is torn down, and nothing appears.
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

/**
 * Tapping the notification puts the decision in front of you.
 *
 * Focus an existing window if there is one, rather than opening a second copy:
 * the app holds live socket state and a back stack, and a fresh tab throws
 * both away — you would tap an approval and land on a cold start.
 *
 * `includeUncontrolled` matters: a tab loaded before this worker took over is
 * not controlled by it, and without the flag it is invisible here. That tab is
 * the single most likely one to exist.
 *
 * Focusing alone is not enough, though. The app is wherever it was left — the
 * fleet, a diff, a conversation — so tapping "Approval needed" would raise a
 * window showing something else entirely, and the thing you were woken for
 * would be one or two taps away and unmentioned. So the window is also told
 * why it was raised. A fresh one needs no telling: it opens on the queue.
 */
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var home = new URL("./", self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (all) {
      for (var i = 0; i < all.length; i++) {
        if (all[i].url.indexOf(self.registration.scope) === 0 && "focus" in all[i]) {
          var client = all[i];
          // Told before focusing, not after: `focus()` resolves when the window
          // is actually raised, which on a phone waking from a locked screen is
          // long enough to see the wrong screen first.
          try { client.postMessage({ type: "agentglass:opened-from-notification" }); } catch (e) { /* gone */ }
          return client.focus();
        }
      }
      return self.clients.openWindow(home);
    }),
  );
});
