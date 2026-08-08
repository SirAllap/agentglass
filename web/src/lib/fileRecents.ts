// The files you opened, most recent first.
//
// This is the third question the palette answers, and the only one that cannot
// be asked of the disk: "the thing I was reading twenty minutes ago" is not a
// name you remember and not a string that appears in the file. Everybody knows
// the document by where they were when they had it open, which is a fact about
// this session and nowhere else.
//
// In localStorage rather than on the server, and that is the same call made for
// mdPrefs: it is a list about this machine's window, it changes on every open,
// and a round trip for it would make the fastest tab in the palette the slowest.
//
// Keyed by checkout as well as path. With ten worktrees of one repository open,
// `docs/plan.md` names ten different files, and a recents list that collapsed
// them would reopen the wrong branch's copy — silently, since the text usually
// looks nearly the same.

const KEY = "agentglass.files.recent";

/**
 * How many to keep.
 *
 * Enough to cover a working day of jumping between documents, small enough that
 * the list is still a list rather than a search of its own — past about thirty
 * you are scrolling, and scrolling is what the other two tabs are for.
 */
const CAP = 40;

export type Recent = {
  /** The checkout's absolute path. */
  root: string;
  /** Repo-relative path of the file. */
  rel: string;
  /** When it was last opened (epoch ms), so the list can be ordered and aged. */
  at: number;
};

const ok = (r: unknown): r is Recent =>
  !!r && typeof r === "object"
  && typeof (r as Recent).root === "string" && (r as Recent).root.length > 0
  && typeof (r as Recent).rel === "string" && (r as Recent).rel.length > 0
  && typeof (r as Recent).at === "number" && Number.isFinite((r as Recent).at);

let cache: Recent[] | null = null;
const subs = new Set<() => void>();

export function recents(): Recent[] {
  if (cache) return cache;
  let raw: unknown = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { /* corrupt or absent */ }
  // Filtered rather than trusted: this is parsed from storage that a previous
  // version wrote, and one malformed entry must not take the whole list with it.
  cache = Array.isArray(raw) ? raw.filter(ok).slice(0, CAP) : [];
  return cache;
}

/**
 * Record an open.
 *
 * Re-opening a file MOVES it to the front rather than adding a second entry:
 * the list is "where I have been", and a document you keep coming back to
 * filling the first five rows with itself is the one shape that makes it
 * useless.
 */
export function remember(root: string, rel: string, at = Date.now()): void {
  if (!root || !rel) return;
  const rest = recents().filter((r) => !(r.root === root && r.rel === rel));
  cache = [{ root, rel, at }, ...rest].slice(0, CAP);
  persist();
}

/** Drop one entry — for a file that turned out not to be there any more. */
export function forget(root: string, rel: string): void {
  cache = recents().filter((r) => !(r.root === root && r.rel === rel));
  persist();
}

export function clearRecents(): void {
  cache = [];
  persist();
}

export function subscribeRecents(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

function persist(): void {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* private mode, non-fatal */ }
  for (const fn of subs) fn();
}

/** "hace 3 min" in the app's language: short, and never a date for something
 *  that happened while you were looking at it. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
