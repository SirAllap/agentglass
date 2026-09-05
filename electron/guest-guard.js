// The boundary that makes `webviewTag: true` safe to turn on.
//
// Its own file, and that is the point rather than tidiness. `main.js` is 1200
// lines of shell — a lock, a scheme, a sidecar, IPC, a window — and this is the
// twenty lines of it that decide whether a page the app did not write can hold
// the app's bridge. Read in one screen, with nothing else in the screen.
//
// It is also the only way to test it. main.js is the Electron entry point:
// importing it takes the single-instance lock and registers protocol schemes
// against an `electron` module that does not exist under bun, which is why
// server/test/desktop-token.test.ts has to lift functions out of it with a
// regex. This file requires nothing, so a test can just import it — see
// web/test/browser-guest-guard.test.ts. docs/BROWSER-TIER1.md asked for that
// test when the browser shipped and it did not exist until the Electron 43
// upgrade needed to prove the guard survived.
//
// CommonJS with no build step, like main.js, because main.js requires it. Add
// nothing here that needs bundling, and keep it in `build.files` in
// package.json — left out of the asar, the app does not start.

/** The default browsing session. Named, and persisted, so logins survive a
 *  restart — and separate from the app's own session, so browsing never touches
 *  the cookies or storage of the `agentglass://` origin. */
const BROWSER_PARTITION = "persist:agentglass-browser";

/**
 * The family of partitions a guest may attach on: the default, and one per
 * browsing profile.
 *
 * Still fail-closed, and that is the whole point of spelling it as a pattern
 * rather than opening the check up. A renderer bug that could name any
 * partition would be the attack — `persist:agentglass` is the app's own
 * session, holding the API token's storage — so the suffix alphabet is
 * lowercase and digits, which cannot express a path, a scheme, or the app's
 * name on its own.
 *
 * What a renderer CAN do with this is mint a profile nobody asked for, and that
 * costs an empty cookie jar in a directory Chromium creates lazily. Worth
 * saying out loud rather than leaving as an implication: the boundary being
 * held here is "browsing storage is not app storage", not "the renderer may
 * only have one of them".
 */
const BROWSER_PARTITION_RE = /^persist:agentglass-browser(-[a-z0-9]{1,16})?$/;
const isBrowserPartition = (p) => typeof p === "string" && BROWSER_PARTITION_RE.test(p);

/** http(s) only, and no credentials in the URL.
 *
 *  Deliberately small and deliberately not shared with the web app's
 *  address-bar parser: a boundary you can read in one screen is worth more than
 *  one that shares its code with an autocomplete, and the two answer different
 *  questions — that one decides what you meant to type, this one decides what a
 *  guest is allowed to be. */
function safeGuestUrl(src) {
  if (typeof src !== "string" || !src) return null;
  // The empty page. It is what "leave the home page blank" means, it carries no
  // content and no origin, and refusing it would make that setting a guest that
  // never attaches.
  if (src === "about:blank") return src;
  try {
    const u = new URL(src);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // `https://user:pass@host` in a src attribute is a credential-stuffing
    // shape, never something a person typed.
    if (u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}

/**
 * Everything enabling `<webview>` costs, paid back in one place.
 *
 * A guest is a page the app did not write, so it gets nothing: no preload (it
 * would inherit the `window.agentglass` bridge and with it the API token), no
 * Node, no relaxed web security, its own session, and a src that has already
 * been checked. Fail closed — a src or partition that is not recognised is
 * refused rather than corrected, because a renderer bug that can choose either
 * is the whole attack.
 *
 * `will-attach-webview` is the only hook that runs before the guest exists;
 * attributes set in the markup are advisory until this handler agrees with
 * them. Traced again at Electron 43 before the upgrade: `createGuest` in
 * lib/browser/guest-view-manager.ts still builds `webPreferences`, emits this
 * event, honours `defaultPrevented`, and then spreads the SAME object into
 * `webContents.create()` — so every mutation below still lands, and returning
 * false here still stops the guest existing.
 *
 * @returns true if the guest may attach (webPreferences has been hardened in
 *          place), false if the caller must preventDefault.
 */
function applyGuestGuard(webPreferences, params) {
  const src = safeGuestUrl(params && params.src);
  if (!src || !isBrowserPartition(webPreferences.partition)) return false;
  // Kept, not overwritten: which profile a tab is in is the renderer's to
  // decide, and it has already been checked against the family above.
  const partition = webPreferences.partition;
  // Both spellings: older Electron carries preloadURL alongside preload, and
  // leaving either is how a guest ends up holding the app's bridge.
  delete params.preload;
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.enableBlinkFeatures = "";
  /* `allowpopups` is deliberately NOT stripped. A guest may ASK for a window;
     what happens to the request is decided by the window-open handler in
     main.js, which turns a link into a tab and gives a sign-in popup a real
     window. Refusing it here would put that decision back in Chromium's hands,
     where the answer is always null — and a null is what breaks every OAuth
     flow. */
  // Every tab but the frontmost one sits behind `visibility: hidden` in
  // BrowserPanel — on purpose, that is how a background tab keeps existing
  // without painting. Left at Chromium's default, that same hidden state
  // throttles the guest's timers, which is where a page's WebSocket client
  // usually lives: measured against a real softphone-style tab, a push
  // notification that had already arrived over the wire sat undelivered to
  // page JS until the tab was brought to the front. A guest a person is
  // knowingly leaving in the background to keep receiving pushes is the
  // whole reason tabs exist here, so it never gets to opt in.
  webPreferences.backgroundThrottling = false;
  webPreferences.partition = partition;
  return true;
}

module.exports = {
  BROWSER_PARTITION,
  BROWSER_PARTITION_RE,
  isBrowserPartition,
  safeGuestUrl,
  applyGuestGuard,
};
