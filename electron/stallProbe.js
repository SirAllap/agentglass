// @ts-check
// Pure math for the freeze trace: an event-loop lag probe (main process and
// server both run the same one, see electron/main.js and server/src/stallProbe.ts)
// and the log-rotation plan that keeps a trace file from growing forever.
//
// Pure on purpose — a `setInterval` and `fs.renameSync` are not things a test
// can assert on, the drift number and the rename plan they produce are.

"use strict";

/** How often the probe ticks: 1,800 wakeups an hour, always on. A block is
 *  seen only when it covers a tick's due moment, so a short one between ticks
 *  is missed; a freeze a person notices (seconds) always covers one. One
 *  second caught no more of those and woke the app twice as often. */
const INTERVAL_MS = 2_000;
/** A tick late by more than this is the thread having done something else. */
const STALL_MS = 500;

/** How big a trace file gets before it rotates. */
const ROTATE_BYTES = 1_000_000;
/** Files kept besides the live one: `file`, `file.1`, `file.2`. */
const ROTATE_KEEP = 3;

/** The lag of one tick: how much later than scheduled `now` actually is.
 *  Never negative — a clock that ran backwards is not a stall. */
/** @param {number} scheduledAt @param {number} now */
function lagOf(scheduledAt, now) {
  return Math.max(0, now - scheduledAt);
}

/** Is this lag worth a log line. */
/** @param {number} lagMs */
function isStall(lagMs) {
  return lagMs > STALL_MS;
}

/** The rename plan to apply, oldest pair first, when a file has grown past
 *  the cap. Applying `[from, to]` in order and skipping a missing `from`
 *  rotates `file` -> `file.1` -> `file.2`, the old `file.2` dropped by the
 *  final rename overwriting it. No fs here: the caller does the renaming,
 *  this just says what to rename. */
/** @param {string} file @param {number} [keep] @returns {[string, string][]} */
function rotationPaths(file, keep = ROTATE_KEEP) {
  /** @type {[string, string][]} */
  const pairs = [];
  for (let i = keep - 1; i >= 1; i--) {
    pairs.push([i === 1 ? file : `${file}.${i - 1}`, `${file}.${i}`]);
  }
  return pairs;
}

/** Whether a file this size needs to rotate before the next write. */
/** @param {number} sizeBytes @param {number} [maxBytes] */
function shouldRotate(sizeBytes, maxBytes = ROTATE_BYTES) {
  return sizeBytes > maxBytes;
}

module.exports = { INTERVAL_MS, STALL_MS, ROTATE_BYTES, ROTATE_KEEP, lagOf, isStall, rotationPaths, shouldRotate };
