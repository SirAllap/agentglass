// @ts-check
// Should the shell bring the sidecar back after it exited, and after how long?
// Pure on purpose: main.js owns the process, this owns the verdict, so the
// verdict can be tested without Electron.

const DELAYS_MS = [1000, 3000, 10000];
const WINDOW_MS = 2 * 60 * 1000;

/**
 * @param {{ started: boolean, quitting: boolean, now: number, failures: number[] }} s
 *   `started`: it answered as ours before it died. `failures`: timestamps of
 *   earlier unexpected exits. A deliberate restart never reaches this.
 * @returns {{ respawn: boolean, delayMs: number, failures: number[] }}
 *   `failures` is the list to keep, this exit included.
 */
function decideRespawn({ started, quitting, now, failures }) {
  const recent = failures.filter((t) => now - t < WINDOW_MS);
  // Never started: the port/boot banner owns that case. Quitting: we asked.
  if (!started || quitting) return { respawn: false, delayMs: 0, failures: recent };
  const kept = [...recent, now];
  // Three earlier failures in the window plus this one: stop and keep the banner.
  if (kept.length > DELAYS_MS.length) return { respawn: false, delayMs: 0, failures: kept };
  return { respawn: true, delayMs: DELAYS_MS[kept.length - 1], failures: kept };
}

module.exports = { decideRespawn, DELAYS_MS, WINDOW_MS };
