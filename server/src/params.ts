// Query-param parsing kept out of index.ts so tests can import it without
// booting the server.

/** Default /stats window: the last 24 hours. */
export const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;
/** Widest window we compute over — same order of magnitude as the UI's "all"
 *  chip (3650d), so both spellings of "everything" cover the whole database. */
export const MAX_WINDOW_MS = 3660 * 86_400_000;

/**
 * Parse the /stats `window` query param.
 *
 * "all" means unbounded, served as the cap — no retention setting outlives a
 * decade. A number is clamped to [1 minute, cap]. Anything else (absent,
 * empty, garbage) falls back to the default rather than NaN: the window
 * becomes a `timestamp > since` cutoff, and a NaN there matches no rows, so
 * every total silently reads zero.
 */
export function parseWindowMs(raw: string | null): number {
  if (raw && raw.toLowerCase() === "all") return MAX_WINDOW_MS;
  const n = Number(raw || DEFAULT_WINDOW_MS);
  return Number.isFinite(n) ? Math.min(MAX_WINDOW_MS, Math.max(60_000, n)) : DEFAULT_WINDOW_MS;
}
