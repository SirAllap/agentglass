// @ts-check
// The person watching an agent's lane from the Browser pane.
//
// A lane host is an offscreen window, so every frame it paints already comes
// out of it as a `paint` event (see lane-paint.js for the rate). Watching is
// listening to those events and passing the newest one on at most every
// WATCH_MIN_MS: nothing is asked of the page, the agent or its paint rate, so
// watching takes nothing from the agent. No timer runs while the page is still;
// one trailing timer carries the last frame of a burst.

/** At most this often a frame goes to the person's window (5 a second). */
const WATCH_MIN_MS = 200;

/**
 * One lane's watch.
 * @param {{ on(ev: "paint", fn: (...a: any[]) => void): unknown, off(ev: "paint", fn: (...a: any[]) => void): unknown, invalidate?(): void, isDestroyed(): boolean }} host the lane host's webContents
 * @param {(image: any) => void} send hands one frame on
 * @param {{ setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout, now?: () => number, minMs?: number }} [opts]
 */
function createLaneWatch(host, send, opts = {}) {
  const st = opts.setTimeout || setTimeout;
  const ct = opts.clearTimeout || clearTimeout;
  const now = opts.now || Date.now;
  const minMs = opts.minMs ?? WATCH_MIN_MS;
  let on = false;
  let last = -Infinity;
  /** @type {any} */
  let pending = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const flush = () => {
    timer = null;
    if (!on || pending === null || host.isDestroyed()) return;
    const img = pending;
    pending = null;
    last = now();
    send(img);
  };
  /** @param {unknown} _e @param {unknown} _dirty @param {any} image */
  const onPaint = (_e, _dirty, image) => {
    if (!on) return;
    pending = image;
    const wait = last + minMs - now();
    if (wait <= 0) { if (timer) { ct(timer); timer = null; } flush(); return; }
    if (!timer) timer = st(flush, wait);
  };
  return {
    start() {
      if (on || host.isDestroyed()) return;
      on = true;
      host.on("paint", onPaint);
      /* A still page paints nothing: one fresh frame so the view is not empty. */
      try { host.invalidate?.(); } catch { /* destroyed in between */ }
    },
    stop() {
      if (!on) return;
      on = false;
      pending = null;
      if (timer) { ct(timer); timer = null; }
      try { host.off("paint", onPaint); } catch { /* destroyed */ }
    },
    watching: () => on,
  };
}

module.exports = { createLaneWatch, WATCH_MIN_MS };
