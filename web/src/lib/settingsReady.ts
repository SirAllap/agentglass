/**
 * When a Settings page is ready to be seen, and when its data is worth fetching early.
 *
 * A long page (Understudy, Permissions, Engines & usage) used to paint at once and then grow as each
 * read came back, pushing everything under it down for a few hundred ms. The shell now mounts the
 * page it was asked for out of sight, keeps the page that was on screen for up to HOLD_MS (a fast
 * page swaps with no flash), shows a quiet skeleton after that, and swaps the whole page in once
 * every read it declared has answered. CAP_MS is the most a page can keep itself out of sight: a
 * read that never answers must not leave the person looking at a skeleton.
 *
 * These are the decisions only, with no React and no clock, so test/settings-ready.test.ts can
 * check them.
 */

export const HOLD_MS = 150;
export const CAP_MS = 1500;
/** A cached read younger than this is not fetched again: a hover then a click is one request, not two. */
export const FRESH_MS = 2000;

export type SwitchPhase = "swap" | "hold" | "skeleton";

/** What to show while the page asked for is mounted out of sight. */
export function switchPhase(ready: boolean, elapsedMs: number, holdMs = HOLD_MS, capMs = CAP_MS): SwitchPhase {
  if (ready || elapsedMs >= capMs) return "swap";
  return elapsedMs >= holdMs ? "skeleton" : "hold";
}

/** A page is ready when it has mounted and none of its declared reads is still out. */
export function pageReady(mounted: boolean, pending: ReadonlySet<string> | undefined): boolean {
  return mounted && (!pending || pending.size === 0);
}

export type SlotRole = "plain" | "shown" | "pending" | "none";
export type Layer = "a" | "b";

export const otherLayer = (l: Layer): Layer => (l === "a" ? "b" : "a");

/**
 * The page the back layer mounts out of sight: the page asked for while it is not the one on screen.
 * While a query runs there is none: search results stack in the front layer and are never held back.
 */
export function backPane(front: string | null, target: string, searching: boolean): string | null {
  return searching || front === target ? null : target;
}

/** How a layer is drawn: on screen, out of sight while its page loads, or not at all. */
export function layerRole(isFront: boolean, page: string | null, searching: boolean): SlotRole {
  if (searching) return isFront ? "plain" : "none";
  if (page === null) return "none";
  return isFront ? "shown" : "pending";
}

/** Whether a read should go out now: nothing cached, or the cached value is stale, and none already out. */
export function shouldFetch(entry: { at: number } | undefined, inFlight: boolean, now: number, freshMs = FRESH_MS): boolean {
  if (inFlight) return false;
  return !entry || now - entry.at >= freshMs;
}

/** Whether a hover or focus on a nav row should warm that page's reads: not the page already on screen. */
export function shouldPrefetch(page: string, current: string, registered: boolean): boolean {
  return registered && page !== current;
}
