// Choosing what to bring over from another browser.
//
// The list this drives had 201 sites in it and asked you to tick them one at a
// time, having pre-selected a browser with three. Everything here exists to
// make the first screen already correct: the right browser, everything chosen,
// the sites you would recognise first.
//
// Pure, because every one of these is a judgement that can be wrong in a way a
// screenshot will not show — "the biggest profile" is not the same as "the
// first readable one", and the difference is 198 sites.

import type { CookieSite, CookieSource } from "./desktop.ts";

/**
 * Which browser to start on.
 *
 * The one with the most sites, not the first that happens to be readable. On
 * this machine that is the difference between Zen (201 sites, the browser
 * actually in use) and Firefox (3, opened twice last year) — and the old rule
 * picked Firefox, so the panel opened on an all-but-empty list and looked
 * broken.
 *
 * Locked profiles cannot win, but they are not invisible: see `reachable`.
 */
export function bestSource(sources: CookieSource[]): CookieSource | null {
  const usable = sources.filter((s) => s.readable && s.sites.length);
  if (!usable.length) return sources.find((s) => s.readable) ?? sources[0] ?? null;
  return usable.reduce((best, s) => (s.sites.length > best.sites.length ? s : best));
}

/**
 * Sites, most-used first.
 *
 * By cookie count, which is the closest thing to "how much of your life is on
 * this site" that a cookie jar knows. Ties break alphabetically so the order is
 * stable between reads rather than shifting under a scroll.
 */
export function rankSites(sites: CookieSite[]): CookieSite[] {
  return [...sites].sort((a, b) => b.cookies - a.cookies || a.site.localeCompare(b.site));
}

/** How many rows are worth drawing. Past this it is a wall, and the wall is
 *  the same information as a number. */
export const SHOWN_MAX = 40;

export interface SiteView {
  /** The rows to draw, already ranked and filtered. */
  rows: CookieSite[];
  /** Matched the filter but is past SHOWN_MAX. Chosen all the same. */
  hidden: number;
  /** Everything the filter matched, drawn or not — what "all visible" means. */
  matched: CookieSite[];
}

export function siteView(sites: CookieSite[], filter: string): SiteView {
  const q = filter.trim().toLowerCase();
  const matched = rankSites(sites).filter((s) => !q || s.site.toLowerCase().includes(q));
  return { rows: matched.slice(0, SHOWN_MAX), hidden: Math.max(0, matched.length - SHOWN_MAX), matched };
}

/**
 * What is chosen when a browser is picked: all of it.
 *
 * The old default was nothing, on the argument that a login is yours to opt
 * into one at a time. That argument does not survive contact with 201 sites —
 * it is not a safeguard, it is a reason never to finish. And the asymmetry runs
 * the other way anyway: a cookie for a site you never visit costs nothing,
 * while the one you forgot to tick is the one that has you signed out at the
 * moment you needed it.
 *
 * You untick what you do not want, which is a thing you can actually do.
 */
export function allSites(sites: CookieSite[]): Set<string> {
  return new Set(sites.map((s) => s.site));
}

/** Add every site the filter is currently matching, keeping whatever was
 *  already chosen outside it — "all visible" must not silently drop the rest. */
export function addVisible(chosen: ReadonlySet<string>, view: SiteView): Set<string> {
  const next = new Set(chosen);
  for (const s of view.matched) next.add(s.site);
  return next;
}

/** And take them away again, leaving everything outside the filter alone. */
export function dropVisible(chosen: ReadonlySet<string>, view: SiteView): Set<string> {
  const next = new Set(chosen);
  for (const s of view.matched) next.delete(s.site);
  return next;
}

/**
 * Why a profile cannot be read, in words that say whether you can do anything.
 *
 * Chrome-family browsers seal their cookies with a key held by the desktop
 * keyring; that is not a lock that closing the browser opens, and saying "try
 * again" would be a lie. The honest answer names the one thing that does work.
 */
export function lockedWhy(s: CookieSource): string {
  // Chrome's keyring key is fetched now — see secretservice.ts — so reaching
  // this at all means the fetch did not work, and the old message ("there is
  // no way to ask for it") became a lie the moment it did. These are the three
  // reasons left, and two of them somebody can act on.
  if (s.reason === "app-bound") {
    return `${s.label} uses app-bound encryption, which ties the key to the browser's own binary. Nothing outside it can read those cookies — not this, not another browser's importer.`;
  }
  return `${s.label} has ${s.rows} cookies and none of them would decrypt. Its key lives in the desktop keyring: if your keyring is locked, unlock it and press Check again. If this is a second profile signed in as another user, its key may belong to a different login session.`;
}

/** A profile you can select in order to be told why it is unusable. Locked
 *  ones used to be disabled, which meant the explanation of the lock was
 *  attached to a state nobody could ever reach. */
export const reachable = (s: CookieSource): boolean => s.readable || s.rows > 0;
