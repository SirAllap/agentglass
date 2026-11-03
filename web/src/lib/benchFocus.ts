/*
 * Where the keyboard goes when the bench closes.
 *
 * The person types in a terminal, opens the bench with its chord and closes it
 * with the same chord. Closing blurs whatever had focus inside the window and
 * nothing gave it back, so the next key went nowhere until a click: measured at
 * two closes out of three. The decision is pulled out here because it is three
 * booleans and no DOM, and each one is a way to steal focus the person did not
 * leave behind.
 */

type Node = { isConnected: boolean };

/** Remember what had focus at open: a live element, not the page and not the bench itself. */
export function focusToRemember<T extends Node>(active: T | null, isBody: boolean, inBench: boolean): T | null {
  return active && active.isConnected && !isBody && !inBench ? active : null;
}

/**
 * What to focus at close. Only when focus is lost (on the page, or still in the
 * bench): if the person moved it somewhere on purpose while the bench faded, it
 * stays there. A remembered element that was unmounted falls back to `fallback`.
 */
export function focusToRestore<T extends Node>(remembered: T | null, fallback: T | null, focusLost: boolean): T | null {
  if (!focusLost) return null;
  return remembered && remembered.isConnected ? remembered : fallback;
}
