import { api, IS_DEMO } from "./api.ts";
import { recordNote } from "./sysNotify.ts";
import type { UpdateStatus } from "../../../shared/types.ts";

/**
 * Whether a newer release exists, checked in the background.
 *
 * The update path works; nothing ever announced itself. `updateStatus()` had a
 * single caller — the About pane — fired when the Settings modal opens, so a
 * release could sit published for weeks and the only way to find out was to go
 * looking for it. Someone who runs the app daily has no reason to open that
 * pane, which makes a working update path invisible: shipping a fix did not
 * mean anyone received it.
 *
 * A module-level store rather than a hook, for the same reason gateStore.ts is
 * one: the answer belongs to the app, not to whichever surface happens to be
 * mounted. The notch and the settings button both read it, and neither has to
 * poll.
 */

/** Once shortly after launch, then rarely. The remote answer changes when
 *  somebody cuts a tag, which is not an hourly event; this is a `git ls-remote`
 *  against origin and there is nothing to gain from asking often. */
const FIRST_CHECK_MS = 45_000;
const EVERY_MS = 6 * 60 * 60_000;

const subs = new Set<() => void>();

/** Replaced only when the answer actually changes, so `useSyncExternalStore`
 *  can compare by identity and consumers re-render on news rather than on
 *  every poll. */
let snapshot: UpdateStatus | null = null;

export const updateState = (): UpdateStatus | null => snapshot;

/** A release newer than this build, and nothing standing in the way of taking
 *  it. `blocked` covers the honest refusals — no origin recorded, no tags
 *  published — which are not news and must not raise a badge. */
export const updateAvailable = (): boolean =>
  !!snapshot && snapshot.ok && snapshot.available && !snapshot.blocked && snapshot.behind > 0;

export function subscribeUpdate(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/**
 * Tags already announced, persisted.
 *
 * The badge is a standing state and stays for as long as the release does. The
 * notch note is an interruption, so it fires once per tag: told about v0.3.1,
 * you do not need telling again every six hours, or on every restart until you
 * take it. localStorage rather than memory is what makes the restart part
 * true.
 */
const ANNOUNCED_KEY = "agentglass_update_announced";

function announced(): string {
  try { return localStorage.getItem(ANNOUNCED_KEY) || ""; } catch { return ""; }
}

function remember(tag: string): void {
  try { localStorage.setItem(ANNOUNCED_KEY, tag); } catch { /* private mode */ }
}

/**
 * Take a status and reconcile it: publish it, and announce a tag once.
 *
 * Exported because it is the seam — everything stateful here is decided in this
 * function, which is what the tests drive and what a server push would call if
 * this ever stops being polled.
 */
export function ingestUpdate(st: UpdateStatus | null): void {
  const before = snapshot;
  snapshot = st;
  // Identity comparison upstream, so only tell anyone when the answer moved.
  if (!before || before.branch !== st?.branch || before.behind !== st?.behind || before.blocked !== st?.blocked) {
    for (const fn of subs) fn();
  }
  if (!st || !st.ok || !st.available || st.blocked || st.behind <= 0 || !st.branch) return;
  if (announced() === st.branch) return;
  remember(st.branch);
  recordNote({
    app: "update",
    summary: `${st.branch} is available`,
    body: st.behind > 1
      ? `${st.behind} releases newer than this build — Settings › About to install`
      : "Settings › About to see what is in it and install",
    urgency: 1,
  });
}

let timer: ReturnType<typeof setInterval> | null = null;

async function check(): Promise<void> {
  try {
    ingestUpdate(await api.updateStatus());
  } catch {
    // Offline, or a server that declines to answer. Not news: leave the last
    // answer standing rather than retracting a badge because a check failed.
  }
}

/**
 * Begin checking. Idempotent, so a second caller cannot double the polling.
 *
 * Deliberately late for the first check: launch is busy enough without a
 * network round trip nobody is waiting for, and an update that has been
 * available for a week can wait another forty seconds.
 */
export function startUpdateChecks(): () => void {
  if (IS_DEMO || timer) return () => {};
  const first = setTimeout(check, FIRST_CHECK_MS);
  timer = setInterval(check, EVERY_MS);
  return () => {
    clearTimeout(first);
    if (timer) clearInterval(timer);
    timer = null;
  };
}

// Started on import, the way gateStore.ts is, and for the same reason: the
// answer belongs to the app rather than to whichever surface is mounted. Tying
// it to a component would mean agentglass stops noticing releases whenever you
// are looking at something else.
if (typeof window !== "undefined") startUpdateChecks();

/** Test seam: forget everything this module remembers. */
export function __resetUpdateStore(): void {
  snapshot = null;
  if (timer) { clearInterval(timer); timer = null; }
  try { localStorage.removeItem(ANNOUNCED_KEY); } catch { /* fine */ }
}
