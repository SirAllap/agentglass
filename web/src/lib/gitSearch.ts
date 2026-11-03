/**
 * The search over a git list, as decisions rather than as screen code.
 *
 * Client-side and over what is LOADED: the log holds the newest few hundred
 * commits, so a hit is a hit among those, not among the whole history. A
 * search of the whole history is a different question (`git log --grep`) and
 * is not built here.
 */

const norm = (q: string) => q.trim().toLowerCase();
const has = (s: string | undefined | null, n: string) => !!s && s.toLowerCase().includes(n);
const prefix = (s: string | undefined | null, n: string) => !!s && s.toLowerCase().startsWith(n);

export const commitMatches = (l: { subject?: string; author?: string; hash?: string }, q: string): boolean => {
  const n = norm(q);
  return !n || has(l.subject, n) || has(l.author, n) || prefix(l.hash, n);
};

export const reflogMatches = (e: { subject?: string; action?: string; shortHash?: string; hash?: string }, q: string): boolean => {
  const n = norm(q);
  return !n || has(e.subject, n) || has(e.action, n) || prefix(e.shortHash, n) || prefix(e.hash, n);
};

export const pathMatches = (path: string, q: string): boolean => {
  const n = norm(q);
  return !n || has(path, n);
};

/**
 * The list a search leaves, with the selected row kept in it.
 *
 * A selection the filter would hide is put back at the top instead — the
 * inspector is open on it, and a list that no longer shows what the inspector
 * is about reads as two panes disagreeing. `pinned` says so, for the label.
 */
export function filterKeepingSelected<T extends { hash?: string }>(
  all: T[], q: string, match: (x: T, q: string) => boolean, selected: string | null,
): { rows: T[]; pinned: string | null } {
  if (!norm(q)) return { rows: all, pinned: null };
  const rows = all.filter((x) => !!x.hash && match(x, q));
  if (!selected || rows.some((x) => x.hash === selected)) return { rows, pinned: null };
  const sel = all.find((x) => x.hash === selected);
  return sel ? { rows: [sel, ...rows], pinned: selected } : { rows, pinned: null };
}

/** The "Nothing matches" frame: a search is typed and no row is left. */
export const searchEmpty = (q: string, shown: number): boolean => q.trim() !== "" && shown === 0;

/** Escape: the first press empties the box; with it empty, the key is not ours. */
export const escapeClearsSearch = (q: string): boolean => q !== "";
