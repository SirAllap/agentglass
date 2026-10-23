/*
 * A folder, a page at a time.
 *
 * `browseDir` answers a menu: it sorts the whole folder, stats up to 2000 rows
 * and only then replies. A file manager needs the opposite order — first rows
 * on screen at once, the rest while somebody is already reading. Measured on
 * this machine with 100,000 entries: readdir 14 ms, the first 128 with lstat
 * 15 ms, all of them 99 ms. So the names are read once, pages of 128 are
 * statted as they are asked for, and the caller sorts what it has: the order
 * here is the disk's, and a sort that needs every row is the client's to do.
 *
 * What it does not do is loosen anything. The boundary is `browseAllows`, asked
 * of the folder on EVERY page (a cursor is not a capability), and each row is
 * the same `entryOf` the whole-folder listing uses, so a symlink to somewhere
 * this may not look is a link here too and not a folder. Entering one is a new
 * request for the link's path and is judged on where it lands.
 *
 * The names are cached for a few seconds so that walking the cursor does not
 * read a 100,000-entry directory 782 times. Page 0 always reads afresh: a
 * refresh, or opening the folder, must see what is there now.
 */
import { readdirSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { BrowseEntry } from "./browse.ts";
import { browseAllows, entryOf } from "./browse.ts";
import { diskAllows } from "./disk.ts";
import { safeAbs } from "./git.ts";
import { realish } from "./config.ts";

/** What a page holds unless the caller asks for fewer. */
export const BATCH = 128;
/** The most any caller can ask for in one page; the cap lives here, not in the UI. */
const MAX_BATCH = 512;
/** How long a folder's names are kept for the pages after the first. */
const KEEP_MS = 5000;
/** Folders kept at once: one per open column is plenty. */
const KEEP_MAX = 8;
/** Names kept across all folders. A cache of eight million-entry folders is a leak with a good reason. */
const KEEP_NAMES = 1_000_000;

export interface BrowsePage {
  ok: boolean;
  path: string;
  /** Entries in this folder after the hidden rule, so the client can size a scrollbar before it has them. */
  total: number;
  entries: BrowseEntry[];
  /** Where the next page starts, or null when this was the last. */
  next: number | null;
  hiddenSkipped: number;
  error?: string;
}

interface Kept { stamp: bigint; at: number; names: string[]; hiddenSkipped: number }
const kept = new Map<string, Kept>();

const refuse = (path: string, error: string): BrowsePage =>
  ({ ok: false, path, total: 0, entries: [], next: null, hiddenSkipped: 0, error });

export function browseBatch(
  pathIn: unknown,
  cursor: unknown,
  opt: { limit?: number; showHidden?: boolean; local?: boolean } = {},
): BrowsePage {
  const local = !!opt.local;
  const showHidden = !!opt.showHidden && local;
  // `safeAbs` resolves a relative path against the server's cwd, which is wherever the app was started from.
  if (typeof pathIn !== "string" || !isAbsolute(pathIn) || pathIn.includes("\0")) return refuse("", "invalid path");
  const abs = safeAbs(pathIn);
  if (!abs) return refuse("", "invalid path");
  if (!browseAllows(abs, local)) return refuse(abs, "outside the places this may look");

  const from = Number.isInteger(cursor) && (cursor as number) > 0 ? (cursor as number) : 0;
  const size = Math.min(MAX_BATCH, Math.max(1, Math.floor(opt.limit ?? BATCH) || BATCH));
  // Inside a dotted place every row is judged, not only the dotted ones (see browseDir).
  const viaDot = local && !diskAllows(realish(abs));

  const key = `${abs}\0${showHidden ? 1 : 0}`;
  const now = Date.now();
  let k = kept.get(key);
  const fresh = from > 0 && !!k && now - k.at <= KEEP_MS;
  if (!fresh) {
    let stamp: bigint;
    try {
      const st = statSync(abs, { bigint: true });
      if (!st.isDirectory()) return refuse(abs, "not a folder");
      stamp = st.mtimeNs;
    } catch (e) {
      return refuse(abs, (e as NodeJS.ErrnoException)?.code === "EACCES" ? "no permission to read this folder" : "no such folder");
    }
    if (from === 0 || !k || k.stamp !== stamp) {
      let all: string[];
      try { all = readdirSync(abs); }
      catch (e) { return refuse(abs, (e as NodeJS.ErrnoException)?.code === "EACCES" ? "no permission to read this folder" : "no such folder"); }
      const names = showHidden ? all : all.filter((n) => !n.startsWith("."));
      k = { stamp, at: now, names, hiddenSkipped: all.length - names.length };
      kept.delete(key);
      kept.set(key, k);
      let held = 0;
      for (const v of kept.values()) held += v.names.length;
      // The folder just read always stays: its pages are what is being walked.
      while (kept.size > 1 && (kept.size > KEEP_MAX || held > KEEP_NAMES)) {
        const oldest = kept.keys().next().value as string;
        held -= kept.get(oldest)!.names.length;
        kept.delete(oldest);
      }
    }
  }
  if (!k) return refuse(abs, "no such folder");

  const entries: BrowseEntry[] = [];
  const end = Math.min(k.names.length, from + size);
  for (let i = from; i < end; i++) {
    try { entries.push(entryOf(abs, k.names[i]!, viaDot, local)); }
    catch { /* vanished between readdir and lstat: it is not there, so it is not a row */ }
  }
  return { ok: true, path: abs, total: k.names.length, entries, next: end < k.names.length ? end : null, hiddenSkipped: k.hiddenSkipped };
}
