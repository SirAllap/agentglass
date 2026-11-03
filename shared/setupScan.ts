/*
 * The Finder's numbers, in one place so the server's walk and the browser's
 * words cannot disagree about when a search stopped.
 */

/** How deep below a root the walk looks. Projects group a level or two down;
 *  deeper mostly finds vendored checkouts. */
export const SETUP_SCAN_DEPTH = 6;

/** The walk stops at this many repositories and says so. */
export const SETUP_SCAN_MAX_REPOS = 500;

/** The walk stops after this long and says so. */
export const SETUP_SCAN_MS = 20_000;

/** What the walk never enters, named in the Finder's own words. */
export const SETUP_SCAN_SKIPS = ["node_modules", "caches", "hidden folders", "system folders"] as const;
