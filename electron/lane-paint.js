// @ts-check
// An agent lane's paint rate: 30 fps while an agent drives it, none when idle.
//
// A lane host is an offscreen window (see "A LANE HOST" in main.js), and
// offscreen paints in software on its own clock: at 30 fps that is CPU spent
// every frame on a page nobody is looking at and no agent is touching.
//
// The signal that a lane is in use: every verb reaches the guest as a call on
// its webContents in main. The lane's renderer drives the `<webview>` with
// executeJavaScript, and Electron 43 runs that (and every other async
// `<webview>` method) in main as `guest[method](...args)` from its
// GUEST_VIEW_MANAGER_CALL handler (read in the shipped binary). Main's own
// capture/CDP/input paths call `guest.capturePage`, `guest.debugger.sendCommand`
// and `guest.sendInputEvent`. So wrapping those methods on the guest instance
// sees every verb, with no polling and no new message from the server.
//
// A stopped lane's last frame can be any age, so a capture right after
// an idle drop waits WARM_MS for the raised rate to paint a fresh one first.
// The wait counts from the raise, not from the capture: `observe --shot` sends
// an executeJavaScript (which raises) a few ms before its capturePage, and that
// capture still owes the rest of the warm-up.
//
// Idle used to mean 1 fps (521ddc980). Measured before that: 30 software
// frames a second per lane with nothing on it changing. 1 fps still paints a
// page nobody reads and no agent touches, so idle now stops painting outright
// (`stopPainting`) and the next verb starts it again before it acts: a lane
// paints only while something is driving it. Nothing reads an idle lane's
// pixels without a verb first — every capture path is a wrapped method below.
// A screencast is the one reader that keeps reading with no verb, so a lane
// stays busy from Page.startScreencast until Page.stopScreencast.
//
// The decision is pure (`laneFrameRate`, `laneWarmMs`) so a test can assert it;
// `createLanePaint` is the one timer per lane (reset on each verb, not a poll).

const LANE_BUSY_FPS = 30;
/** 0 = not painting at all (`stopPainting`), not a frame rate of zero. */
const LANE_IDLE_FPS = 0;
/** No verb for this long and the lane drops to the idle rate. */
const LANE_IDLE_MS = 10_000;
/** Three frames at the busy rate: time for a fresh frame after a raise. */
const WARM_MS = Math.ceil(3000 / LANE_BUSY_FPS);

/** The rate a lane should paint at, `sinceVerbMs` after its last verb.
 *  A lane being screencast never idles: the stream reads frames with no verb.
 *  @param {number} sinceVerbMs @param {number} [idleMs] @param {boolean} [held] */
function laneFrameRate(sinceVerbMs, idleMs = LANE_IDLE_MS, held = false) {
  return held || sinceVerbMs < idleMs ? LANE_BUSY_FPS : LANE_IDLE_FPS;
}

/** How long a capture must wait for a fresh frame, given the rate the lane
 *  was painting at before this verb raised it.
 *  @param {number} prevRate */
function laneWarmMs(prevRate) {
  return prevRate >= LANE_BUSY_FPS ? 0 : WARM_MS;
}

/** Async guest methods that are a verb. A capture waits for a fresh frame. */
const VERB_METHODS = ["executeJavaScript", "executeJavaScriptInIsolatedWorld", "sendInputEvent", "loadURL", "reload", "insertText"];
/** CDP methods that read pixels, so they wait for a fresh frame too. */
const CDP_CAPTURE = new Set(["Page.captureScreenshot", "Page.startScreencast"]);

/**
 * One lane's paint controller.
 * @param {{ setFrameRate(fps: number): void, isDestroyed(): boolean, stopPainting?(): void, startPainting?(): void }} host the lane host's webContents
 * @param {{ setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout, now?: () => number, idleMs?: number }} [opts]
 */
function createLanePaint(host, opts = {}) {
  const st = opts.setTimeout || setTimeout;
  const ct = opts.clearTimeout || clearTimeout;
  const now = opts.now || Date.now;
  const idleMs = opts.idleMs ?? LANE_IDLE_MS;
  /** -1 until the first set: a new window already paints, so no startPainting. */
  let rate = -1;
  /** When the lane last went up to the busy rate. */
  let raisedAt = -Infinity;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** Screencasts running on this lane; while any is, the lane stays busy. */
  let holds = 0;
  const set = (/** @type {number} */ fps) => {
    if (fps === rate || host.isDestroyed()) return;
    const prev = rate;
    rate = fps;
    try {
      if (fps === LANE_IDLE_FPS) host.stopPainting?.();
      else {
        if (prev === LANE_IDLE_FPS) host.startPainting?.();
        host.setFrameRate(fps);
      }
    } catch { /* the window went */ }
  };
  /** A verb arrived: paint at the busy rate now, drop after `idleMs` of none.
   *  Returns how long a capture should wait for a fresh frame: what is left
   *  of the warm-up since the last raise, 0 once it has passed. */
  const touch = () => {
    const prev = rate;
    set(laneFrameRate(0, idleMs));
    const t = now();
    if (rate !== prev) raisedAt = t;
    if (timer) ct(timer);
    timer = st(() => { timer = null; set(laneFrameRate(idleMs, idleMs, holds > 0)); }, idleMs);
    if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
    return Math.max(0, raisedAt + WARM_MS - t);
  };
  /** A screencast started (+1) or stopped (-1); 0 = the debugger went, so
   *  every screencast on it ended. The last stop restarts the idle window
   *  from now, as a verb would. */
  const hold = (/** @type {1 | -1 | 0} */ d) => {
    const had = holds;
    holds = d === 0 ? 0 : Math.max(0, holds + d);
    if (had > 0 && holds === 0) touch();
  };
  const dispose = () => { if (timer) ct(timer); timer = null; };
  return { touch, hold, dispose, rate: () => rate };
}

/**
 * Wrap a lane guest's verb methods so each one raises the lane first.
 * @param {any} guest the lane's guest webContents
 * @param {{ touch(): number, hold?(d: 1 | -1 | 0): void }} paint
 */
function watchLaneGuest(guest, paint) {
  const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
  for (const m of VERB_METHODS) {
    const orig = guest[m];
    if (typeof orig !== "function") continue;
    guest[m] = function (/** @type {unknown[]} */ ...args) { paint.touch(); return orig.apply(this, args); };
  }
  const cap = guest.capturePage;
  if (typeof cap === "function") {
    guest.capturePage = async function (/** @type {unknown[]} */ ...args) {
      const ms = paint.touch();
      if (ms) await wait(ms);
      return cap.apply(this, args);
    };
  }
  const dbg = guest.debugger;
  const send = dbg && dbg.sendCommand;
  if (typeof send === "function") {
    dbg.sendCommand = async function (/** @type {string} */ method, /** @type {unknown[]} */ ...rest) {
      const ms = paint.touch();
      if (ms && CDP_CAPTURE.has(method)) await wait(ms);
      const out = await send.call(this, method, ...rest);
      if (method === "Page.startScreencast") paint.hold?.(1);
      else if (method === "Page.stopScreencast") paint.hold?.(-1);
      return out;
    };
    // A detached debugger ends its screencasts without a stopScreencast.
    dbg.on?.("detach", () => paint.hold?.(0));
  }
}

module.exports = { laneFrameRate, laneWarmMs, createLanePaint, watchLaneGuest, LANE_BUSY_FPS, LANE_IDLE_FPS, LANE_IDLE_MS, WARM_MS };
