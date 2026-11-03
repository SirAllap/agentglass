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

/**
 * S6: a lane forked from a template (`lane new --from-template`). No
 * `persist:` prefix at all, on purpose — Electron keeps an unprefixed
 * partition in memory only, so a crash leaves nothing on disk for the
 * template's cookies to leak from. D6 rejected `persist:` + delete-on-close:
 * that leaks on a crash, which is exactly the failure this whole feature
 * exists to remove. The suffix is the lane id `lane new` mints, never
 * renderer-chosen, but it is the same `{1,16}` lowercase-and-digits alphabet
 * as `BROWSER_PARTITION_RE`'s suffix above — one lane-id shape, not two.
 */
const EPHEMERAL_PARTITION_RE = /^agentglass-browser-eph-[a-z0-9]{1,16}$/;
const isEphemeralPartition = (p) => typeof p === "string" && EPHEMERAL_PARTITION_RE.test(p);
/** The one place this string is built in the main process; main.js's
 *  `destroyLaneHost` calls this rather than holding its own copy of the
 *  literal. web/src/components/LaneHost.tsx builds the same string again on
 *  the renderer side, which cannot require() this CommonJS file — a copy
 *  with a comment pointing back here, same as `shared/csp.ts`'s. */
const ephemeralPartition = (id) => `agentglass-browser-eph-${id}`;
const isBrowserPartition = (p) => (typeof p === "string" && BROWSER_PARTITION_RE.test(p)) || isEphemeralPartition(p);

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
    // `https://user:<password>@host` in a src attribute is a credential-stuffing
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
/**
 * Whether the app's OWN window (never a lane's) may attach a guest on
 * PARTITION, given the tab-ephemeral partitions it currently holds a jar
 * open for.
 *
 * S6 shipped lanes only: the app's own window was refused ANY ephemeral
 * partition, full stop, because nothing there could tell one fork's jar from
 * another's or from a lane's. `newtab --from-template` needs exactly one
 * exception to that "full stop" — the app's window minting its OWN fork for
 * its OWN new tab — so this is the one new door, and it is still fail-closed:
 * an ordinary (non-ephemeral) partition is unaffected, and an ephemeral one
 * this window did not itself mint (a lane's, or a guess) is still refused.
 *
 * A plain function so a test can hand it a `Set` without importing
 * `electron/main.js` — see the header comment for why that file cannot be
 * imported at all.
 * @param {unknown} partition
 * @param {Set<string> | ReadonlySet<string>} tabEphemerals
 */
function mayAttachOnMainWindow(partition, tabEphemerals) {
  if (!isEphemeralPartition(partition)) return true;
  return tabEphemerals.has(/** @type {string} */ (partition));
}

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

/**
 * The permissions a page in the browser may be granted, and nothing else.
 *
 * With no handler Electron grants every request, so a page an agent opened got
 * the camera, the microphone, the clipboard and notifications with no prompt
 * and nobody to see one. An allowlist rather than a list of the known-bad
 * names, because the set of permission names grows with Chromium and a new one
 * should start refused. What is left is what a page needs to behave: going
 * fullscreen, writing (never reading) the clipboard from a user gesture, and
 * pointer lock. The browser has no prompt UI, so "ask" is not an answer here.
 * @param {unknown} permission */
const permissionAllowed = (permission) =>
  typeof permission === "string" && GRANTED_PERMISSIONS.has(permission);
const GRANTED_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

/**
 * What to do with a permission request, given who is asking.
 *
 * The allowlist above is the floor. On top of it, the microphone, the camera
 * and notifications — what a call, a chat or a dev server under test needs —
 * go to whoever the tab belongs to, and nobody else:
 *
 *   - the PERSON's own tab (one they opened in the window, or typed an address
 *     into), when it is the one on screen, is asked in a native dialog the
 *     page cannot draw or click; their tab in the background is refused;
 *   - every other tab — an agent's, a lane, or one whose opener is not known
 *     yet — is HELD, never put to the person: the agent finds it pending in
 *     its next answer and says grant or deny itself, and nobody answering
 *     denies it. Measured: an agent's freshly opened tab was "the front tab"
 *     to this process until the renderer said otherwise, and its microphone
 *     request reached the person as a dialog whose own text said agents'
 *     tabs are never asked. Being in front is not owning.
 *
 * Clipboard reads, HID, serial, USB, screen capture, location and everything
 * this does not name stay refused for everyone; neither the dialog nor an
 * agent's answer is a way to widen them.
 * @param {unknown} permission
 * @param {{ frontTab?: boolean, lane?: boolean, person?: boolean, mediaTypes?: unknown }} ctx
 * @returns {{ verdict: "allow" | "deny" | "ask" | "hold", what?: string, needs?: string[] }} */
function permissionVerdict(permission, ctx) {
  if (permissionAllowed(permission)) return { verdict: "allow" };
  /** @type {string[]} */
  let needs = [];
  if (permission === "notifications") needs = ["notifications"];
  else if (permission === "media") {
    const types = ctx && Array.isArray(ctx.mediaTypes) ? ctx.mediaTypes : [];
    if (types.includes("audio")) needs.push("microphone");
    if (types.includes("video")) needs.push("camera");
  }
  if (needs.length === 0) return { verdict: "deny" };
  const what = needs.join(" and ");
  const person = !!ctx && ctx.person === true && ctx.lane !== true;
  if (!person) return { verdict: "hold", what, needs };
  return ctx.frontTab === true ? { verdict: "ask", what } : { verdict: "deny" };
}

/**
 * Whose a tab is, for the policy above, once `event` has happened.
 *
 * Set by who OPENED it, from its first moment: the window when the person
 * opened it, an agent's ask (named or `--shared`) when an agent did, and the
 * opener's owner for a page a tab opened as a window. After that only two
 * things move it: ANY agent ask that acts on it takes it — named or
 * `--shared`, on the person's own tab too, because with several agents at
 * once the person cannot know which of them a request is for — and the
 * person typing an address into it takes it back. Looking at a tab, or
 * clicking it in the strip, is not owning it.
 * @param {"person" | "agent" | undefined} current
 * @param {{ kind: "opened", by: unknown } | { kind: "popup", opener: unknown } | { kind: "driven" } | { kind: "typed" }} event
 * @returns {"person" | "agent" | undefined} */
function holderAfter(current, event) {
  const who = (/** @type {unknown} */ v) => (v === "person" || v === "agent" ? v : undefined);
  if (!event) return current;
  if (event.kind === "opened") return who(event.by) ?? current;
  if (event.kind === "popup") return who(event.opener);
  if (event.kind === "driven") return "agent";
  if (event.kind === "typed") return "person";
  return current;
}

/** What an agent may grant or deny on its own tab: the three things the
 *  policy above holds for it, and nothing it refuses outright. */
const AGENT_ANSWERABLE = new Set(["microphone", "camera", "notifications"]);

/**
 * The agents' side of the permission policy: requests held for an agent to
 * answer, and the answers it gave, per container (a Session) and origin.
 *
 * An answer is remembered for that container and origin until the app closes,
 * like the person's own — a page that got the microphone asks the check
 * handler again later, and a "no" there would take it back. A request nobody
 * answers within `timeoutMs` is DENIED and that denial is not remembered, so
 * the agent can still grant it for the next try. Timers and the clock are
 * passed in so a test can run it without waiting.
 *
 * shortcut: answers live in memory only, gone when the app closes; persist
 * them per container if an agent ever needs a grant to survive a restart.
 * @template S
 * @param {{ timeoutMs?: number, now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown, clearTimer?: (t: unknown) => void }} [opts] */
function createPermissionDesk(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(/** @type {any} */ (t)));
  /** @type {WeakMap<object, Map<string, boolean>>} */
  const answers = new WeakMap();
  /** @typedef {{ guest: number, store: object, origin: string, needs: string[], since: number, timer: unknown, done: (ok: boolean) => void }} Held */
  /** @type {Set<Held>} */
  const held = new Set();
  const key = (/** @type {string} */ origin, /** @type {string} */ what) => `${origin}\u0000${what}`;
  const book = (/** @type {object} */ store) => {
    let m = answers.get(store);
    if (!m) { m = new Map(); answers.set(store, m); }
    return m;
  };
  /** true / false when every need has an answer, undefined while one is missing.
   *  @param {object} store @param {string} origin @param {string[]} needs */
  const decided = (store, origin, needs) => {
    const m = book(store);
    if (needs.some((n) => m.get(key(origin, n)) === false)) return false;
    return needs.every((n) => m.get(key(origin, n)) === true) ? true : undefined;
  };
  /** @param {Held} h @param {boolean} ok */
  const settle = (h, ok) => {
    if (!held.delete(h)) return;
    clearTimer(h.timer);
    h.done(ok);
  };
  return {
    /** A request from an agent's tab: answered at once when the agent already
     *  answered it for this container and origin, otherwise held.
     *  @param {number} guest @param {object} store @param {string} origin
     *  @param {string[]} needs @param {(ok: boolean) => void} done */
    hold(guest, store, origin, needs, done) {
      const known = decided(store, origin, needs);
      if (known !== undefined) return done(known);
      /** @type {Held} */
      const h = { guest, store, origin, needs, since: now(), timer: null, done };
      h.timer = setTimer(() => settle(h, false), timeoutMs);
      held.add(h);
    },
    /** The synchronous check: only a grant the agent gave counts.
     *  @param {object} store @param {string} origin @param {string[]} needs */
    allowed: (store, origin, needs) => decided(store, origin, needs) === true,
    /** The agent's answer. Without `origin` it is for what this tab is
     *  waiting on; with one it is a grant or a refusal ahead of the ask.
     *  @param {number} guest @param {object} store @param {string[]} what
     *  @param {boolean} allow @param {string} [origin]
     *  @returns {{ error: string } | { answered: string[], origins: string[], settled: number }} */
    answer(guest, store, what, allow, origin) {
      const bad = what.filter((w) => !AGENT_ANSWERABLE.has(w));
      if (what.length === 0 || bad.length) {
        return { error: `${bad.join(", ") || "nothing"} cannot be answered here — microphone, camera and notifications can` };
      }
      const mine = [...held].filter((h) => h.guest === guest && h.store === store && h.needs.some((n) => what.includes(n)));
      const origins = origin ? [origin] : [...new Set(mine.map((h) => h.origin))];
      if (origins.length === 0) return { error: "nothing is waiting on this tab — name the site with --origin to answer ahead of the ask" };
      for (const o of origins) for (const w of what) book(store).set(key(o, w), allow);
      let settled = 0;
      for (const h of held) {
        if (h.store !== store || !origins.includes(h.origin)) continue;
        const v = decided(store, h.origin, h.needs);
        if (v !== undefined) { settle(h, v); settled++; }
      }
      return { answered: what, origins, settled };
    },
    /** What a tab is waiting on, and what its container has been told.
     *  @param {number} guest @param {object} store */
    list(guest, store) {
      const t = now();
      const pending = [...held].filter((h) => h.guest === guest && h.store === store).map((h) => ({
        what: h.needs.join(" and "), origin: h.origin,
        deniedInMs: Math.max(0, timeoutMs - (t - h.since)),
      }));
      const answered = [...book(store)].map(([k, allow]) => {
        const [origin, what] = k.split("\u0000");
        return { origin, what, allow };
      });
      return { pending, answered };
    },
    /** Takes a tab's held requests off the desk, unanswered, for the
     *  person's dialog once the tab turns out to be theirs.
     *  @param {number} guest */
    handOver(guest) {
      const out = [];
      for (const h of held) {
        if (h.guest !== guest) continue;
        held.delete(h); clearTimer(h.timer);
        out.push({ origin: h.origin, needs: h.needs, done: h.done });
      }
      return out;
    },
    /** A tab that closed takes its held requests with it, refused.
     *  @param {number} guest */
    drop(guest) { for (const h of held) if (h.guest === guest) settle(h, false); },
  };
}

/** The sentence an agent reads in its next answer for each held request. */
function pendingPermissionNote(/** @type {{ what: string, origin: string, deniedInMs: number }} */ p) {
  return `pending permission: ${p.what} for ${p.origin} — answer with \`permission grant|deny ${p.what.split(" and ").join(" ")}\` `
    + `within ${Math.ceil(p.deniedInMs / 1000)}s, or it is denied`;
}

/** The dialog's question: the site's own host and the thing asked for. The
 *  origin is parsed, never printed as the page gave it.
 * @param {string} what @param {string} origin */
function permissionPrompt(what, origin) {
  let host = "This page";
  try { host = new URL(origin).host || host; } catch { /* keep the generic name */ }
  return `${host} wants to ${what === "notifications" ? "show" : "use your"} ${what}`;
}

/**
 * Where a download lands: `dir`, under a name that is not taken.
 *
 * The name comes from the page, so only its last segment is kept — a
 * `../x` or an absolute path stays inside `dir` — and a name that already
 * exists gets " (1)", " (2)" before the extension, so a page cannot pick the
 * name of a file that is already there and have it replaced. `exists` is
 * passed in so this stays a function of its inputs. Only the last extension
 * is kept apart: "a.tar.gz" becomes "a.tar (1).gz", which is a free name and
 * that is all this promises.
 * @param {string} dir @param {string} name @param {(p: string) => boolean} exists */
function uniqueSavePath(dir, name, exists) {
  let base = String(name).split(/[\\/]/).pop() || "";
  if (!base || base === "." || base === "..") base = "download";
  const dot = base.lastIndexOf(".");
  const [head, tail] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  let at = `${dir}/${base}`;
  for (let n = 1; exists(at); n++) at = `${dir}/${head} (${n})${tail}`;
  return at;
}

module.exports = {
  BROWSER_PARTITION,
  BROWSER_PARTITION_RE,
  EPHEMERAL_PARTITION_RE,
  isBrowserPartition,
  isEphemeralPartition,
  ephemeralPartition,
  safeGuestUrl,
  mayAttachOnMainWindow,
  applyGuestGuard,
  permissionAllowed,
  permissionVerdict,
  holderAfter,
  createPermissionDesk,
  pendingPermissionNote,
  permissionPrompt,
  uniqueSavePath,
};
