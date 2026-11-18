"use strict";
/**
 * The decisions behind the sleep inhibitor, kept pure so they can be tested
 * without logind, a child process or Electron.
 */

/** First number of `systemctl --version` ("systemd 257 (257.2-1)"), or null. */
function parseSystemdVersion(text) {
  const m = /^systemd\s+(\d+)/m.exec(String(text ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * Which logind mode the sleep lock may use. Only `block-weak` (systemd 257+):
 * a person's own suspend must win over "agents are working", and the hard
 * `block` mode stops it ("Operation inhibited"). Before 257 there is no weak
 * spelling, so NO sleep lock is held there and only the idle lock keeps the
 * machine from dozing off on its own. An unknown version tries block-weak;
 * an old logind refuses it at once and the caller then holds none.
 * @param {number | null} version
 * @returns {"block-weak" | null}
 */
function sleepModeFor(version) {
  if (version === null) return "block-weak";
  return version >= 257 ? "block-weak" : null;
}

/**
 * Which logind locks to hold for the sleep half.
 * @param {{ version: number | null, weakRefused: boolean }} s
 * @returns {{ sleep: "block-weak" | null, idle: boolean }}
 */
function sleepLockPlan({ version, weakRefused }) {
  const sleep = weakRefused ? null : sleepModeFor(version);
  return { sleep, idle: sleep === null };
}

/**
 * "Let it sleep" lasts until the next agent turn starts: the poll going from
 * not working to working. Still working, or idle, keeps the release.
 * `wasWorking: null` is "no earlier answer": the first poll only sets the
 * baseline, so releasing mid-turn in a mode that was not polling is not a new turn.
 * @param {{ released: boolean, wasWorking: boolean | null, working: boolean }} s
 */
function releaseStillApplies({ released, wasWorking, working }) {
  return released && !(working && wasWorking === false);
}

module.exports = { parseSystemdVersion, sleepModeFor, sleepLockPlan, releaseStillApplies };
