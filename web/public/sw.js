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
  // A non-empty string, or nothing. An older server sends no `gate` at all and
  // a newer one could send something unexpected; either way the notification
  // has to end up showable rather than throwing (see above).
  var gate = typeof data.gate === "string" && data.gate ? data.gate : null;
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
      // The gate this is about, if it is about one. Carried through so the
      // click handler knows what it is answering without going back to the
      // server to ask, and so the buttons below have something to send.
      data: gate ? { gate: gate } : undefined,
      // Answer it here, rather than being told where to go and answer it.
      //
      // A held gate is the only alert with two obvious replies and an agent
      // stopped until one of them arrives — so the notification carries them.
      // Everything else this app sends is news, and news with buttons on it is
      // a worse notification, not a better one.
      //
      // Ignored where they are not supported, which today means iPhone: Safari
      // draws the notification without them and tapping it opens the queue, as
      // it did before. Nothing here is required for that path to work.
      actions: gate
        ? [{ action: "allow", title: "Allow" }, { action: "deny", title: "Deny" }]
        : undefined,
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
 * Where the worker finds out who it is.
 *
 * The page holds the credential in `localStorage`, which a service worker
 * cannot read — it has no `window` and no `localStorage`. IndexedDB is the one
 * store both halves can reach, so the app mirrors two things into it whenever
 * push is switched on: the server this device is paired to, and the credential
 * it was given. See web/src/lib/swAuth.ts, which also clears it.
 *
 * It is the same credential the page already holds on the same origin, at the
 * same level it was paired at — not a wider one minted for the worker. A phone
 * paired to answer gates can answer a gate from here and can do nothing else,
 * because the server checks the scope on the route, not on the caller's
 * politeness. Forgetting the device at the machine kills this copy too.
 *
 * Every failure resolves to null rather than throwing: this runs with no UI
 * anywhere, and a rejection here would turn a tapped button into the browser's
 * own "site updated in the background" notification.
 */
function openDb() {
  return new Promise(function (resolve) {
    try {
      // `self.`-qualified, like everything else this file touches. In a real
      // worker `self` *is* the global, so it changes nothing there — and it is
      // what lets the suite run this file against a fake scope instead of
      // reaching past it to the host's real IndexedDB and its real network.
      var req = self.indexedDB.open("agentglass", 1);
      req.onupgradeneeded = function () {
        try { req.result.createObjectStore("auth"); } catch (e) { /* already there */ }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    } catch (e) { resolve(null); }
  });
}

function readAuth() {
  return openDb().then(function (db) {
    if (!db) return null;
    return new Promise(function (resolve) {
      try {
        var r = db.transaction("auth", "readonly").objectStore("auth").get("server");
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  });
}

/**
 * Answer the gate.
 *
 * Every outcome is named, because the phone is about to be told one of them
 * and "something went wrong" is the answer that makes somebody unlock the
 * screen and go looking — which is the whole thing this is here to avoid.
 *
 * `decideGate` on the server is idempotent: a gate that is already decided, or
 * that timed out while the phone was in a pocket, comes back not-ok rather
 * than as a conflict. That is a real answer and is reported as one.
 */
function decide(gate, decision) {
  return readAuth().then(function (auth) {
    if (!auth || !auth.origin) return { ok: false, why: "unpaired" };
    var headers = { "content-type": "application/json" };
    if (auth.token) headers.authorization = "Bearer " + auth.token;
    return self.fetch(String(auth.origin).replace(/\/$/, "") + "/gate/decide", {
      method: "POST",
      headers: headers,
      credentials: "omit",
      body: JSON.stringify({ id: gate, decision: decision }),
    }).then(function (r) {
      // 401 is a credential that no longer works — the device was forgotten,
      // or the machine's code was rotated. 403 is a device that works and is
      // not allowed to decide, which is what a look-only phone gets. Different
      // sentences, because they need different things done about them.
      if (r.status === 401) return { ok: false, why: "unpaired" };
      if (r.status === 403) return { ok: false, why: "notAllowed" };
      return r.json().then(
        function (j) { return j && j.ok ? { ok: true, why: "" } : { ok: false, why: "gone" }; },
        function () { return { ok: false, why: "gone" }; },
      );
    }, function () { return { ok: false, why: "offline" }; });
  });
}

/** What the tap did, said back. A button that answers silently is a button
 *  nobody trusts the second time. */
function report(result, decision, gate) {
  var text =
    result.ok ? (decision === "allow" ? "Allowed. The agent is going." : "Denied. The agent has been told why.")
    : result.why === "gone" ? "Already answered, or it timed out waiting."
    : result.why === "notAllowed" ? "This device is paired to look, not to answer. Change that on the computer."
    : result.why === "unpaired" ? "This device is not connected any more. Open agentglass to pair it again."
    : "Could not reach the computer. It may be asleep, or you may be on another network.";
  return self.registration.showNotification(result.ok ? "✓ agentglass" : "agentglass", {
    body: text,
    icon: "./icon-192.png",
    badge: "./icon-badge.png",
    // Same tag as nothing else, and keyed to the gate: the answer to one
    // approval must not replace the notification for a different one that is
    // still waiting.
    tag: "gate-result:" + gate,
    requireInteraction: false,
  });
}

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

  // A button, rather than the notification itself. Answer it and stop — the
  // point of the buttons is that the phone stays locked and the app stays
  // closed, so opening a window here would undo the whole thing.
  var gate = event.notification.data && event.notification.data.gate;
  var action = event.action;
  if (gate && (action === "allow" || action === "deny")) {
    event.waitUntil(
      decide(gate, action).then(function (r) { return report(r, action, gate); }),
    );
    return;
  }

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
