/*
 * The last "Update branch" this window asked for, kept for the session.
 *
 * The hold on the button ("requested, not moved yet") lived in component
 * state only, so a reload of the window enabled the button again for a pull
 * request whose request was still pending, and a second press queues a second
 * merge. sessionStorage survives a reload and dies with the window; entries
 * older than the longest standing that reads them (STALLED_SHOWN_MS) are
 * dropped on read. Keyed by repo + number; the head it was pressed on rides
 * inside, which is what `updateStanding` compares against.
 *
 * Ceiling: one window. Another window, or a request made from the terminal
 * with `gh`, is not seen here.
 */
import { STALLED_SHOWN_MS } from "../../../shared/justUpdated.ts";

export interface StoredOwnUpdate { number: number; at: number; headBefore: string; note?: string }

const prefix = "agx.ownUpdate:";

export function saveOwnUpdate(key: string, v: StoredOwnUpdate): void {
  try { sessionStorage.setItem(prefix + key, JSON.stringify(v)); } catch { /* private window or blocked: the in-memory hold still works */ }
}

export function loadOwnUpdate(key: string, number: number, now = Date.now()): StoredOwnUpdate | null {
  try {
    const raw = sessionStorage.getItem(prefix + key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredOwnUpdate>;
    if (v.number !== number || typeof v.at !== "number" || typeof v.headBefore !== "string") return null;
    if (!(now >= v.at) || now - v.at >= STALLED_SHOWN_MS) return null;
    return { number: v.number, at: v.at, headBefore: v.headBefore, ...(typeof v.note === "string" ? { note: v.note } : null) };
  } catch { return null; }
}
