// The pull requests you keep coming back to.
//
// A panel that shows one at a time makes going between two of them a trip: back
// to the list, find it again in a list that reorders itself as things change,
// open it. Twice a minute while a suite runs, and the list is sorted by
// activity — so the row you want has usually moved since you last looked.
//
// Pinning is the small fix: the ones you are working on stay one click away
// from wherever you are in the panel, in an order you chose rather than one
// GitHub keeps rewriting.
//
// Kept on this machine rather than on GitHub. There IS a GitHub concept for
// this — subscribing to a pull request — and it is a different thing: it
// decides who gets e-mailed, it is visible to everyone, and unsubscribing to
// tidy your bar would turn off somebody's notifications. This is a shortcut,
// so it lives where shortcuts live.

const KEY = "agentglass.pr.pins";

/**
 * How many.
 *
 * They live in a menu behind one button, so the ceiling is no longer a row's
 * width: it is how long a list stays something you pick from rather than
 * search. Thirty is past where the menu's filter box is the way in, and a
 * pin kept past it is one nobody comes back to.
 */
export const PIN_MAX = 30;

export type Pin = {
  /** `owner/name`, so the same number in two repositories cannot collide. */
  repo: string;
  number: number;
  /** For the chip's tooltip. Stored rather than looked up because the whole
   *  point is to render it without fetching the pull request first. */
  title: string;
  /** When it was pinned, so the bar keeps the order you built rather than one
   *  the server rewrites. */
  at: number;
};

const ok = (p: unknown): p is Pin =>
  !!p && typeof p === "object"
  && typeof (p as Pin).repo === "string" && (p as Pin).repo.length > 0
  && Number.isInteger((p as Pin).number)
  && typeof (p as Pin).title === "string";

let cache: Pin[] | null = null;
const subs = new Set<() => void>();

export function pins(): Pin[] {
  if (cache) return cache;
  let raw: unknown = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { /* corrupt */ }
  // Filtered rather than trusted: written by a previous version, and one bad
  // row must not take the bar with it.
  cache = Array.isArray(raw) ? raw.filter(ok).slice(0, PIN_MAX) : [];
  return cache;
}

export const isPinned = (repo: string, number: number): boolean =>
  pins().some((p) => p.repo === repo && p.number === number);

/** Only the ones from this repository — the panel shows one repository at a
 *  time, and a chip that opens something the list cannot show is a dead end. */
export const pinsFor = (repo: string): Pin[] => pins().filter((p) => p.repo === repo);

/**
 * Pin it, or unpin it if it is already there.
 *
 * Appended rather than prepended: this is a bar you build, and a new pin
 * jumping to the front would move every chip you had already learned the
 * position of.
 */
export function togglePin(repo: string, number: number, title: string, at = Date.now()): boolean {
  const has = isPinned(repo, number);
  if (has) {
    cache = pins().filter((p) => !(p.repo === repo && p.number === number));
  } else {
    // Oldest out when full, so pinning one more does something rather than
    // silently nothing.
    const kept = pins();
    cache = [...(kept.length >= PIN_MAX ? kept.slice(1) : kept), { repo, number, title, at }];
  }
  persist();
  return !has;
}

/** The pins whose number or title contain what was typed; a leading "#" is ignored, case is too. */
export function filterPins(list: readonly Pin[], typed: string): Pin[] {
  const needle = typed.trim().toLowerCase().replace(/^#/, "");
  if (!needle) return [...list];
  return list.filter((p) => String(p.number).includes(needle) || p.title.toLowerCase().includes(needle));
}

export function unpinAll(): void {
  cache = [];
  persist();
}

export function subscribePins(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

function persist(): void {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* private mode */ }
  for (const fn of subs) fn();
}
