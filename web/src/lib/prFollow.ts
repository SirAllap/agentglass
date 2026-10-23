/*
 * The colleagues somebody follows on the pull-request board, kept in this
 * browser per repository: one click opens that person's board.
 *
 * Until anyone is followed, the people used most (the same score the "@" menu
 * ranks with, see personUsage.ts) are offered as suggestions, at most
 * FREQUENT_MAX. Following one replaces the suggestions with the follows.
 * Nothing here asks anybody for anything; opening a board has its own budget.
 */
import { FREQUENT_MAX, rankPeople, type PersonUse } from "./personUsage.ts";

export const FOLLOW_MAX = 12;
const KEY = "agentglass.pr.follows.v1:";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function isFollowed(follows: readonly string[], login: string): boolean {
  return follows.some((f) => same(f, login));
}

/** Follow or unfollow. Logins are GitHub's, which are not case-sensitive; the first spelling stays. */
export function toggleFollow(follows: readonly string[], login: string): string[] {
  const who = login.trim().replace(/^@/, "");
  if (!who) return [...follows];
  if (isFollowed(follows, who)) return follows.filter((f) => !same(f, who));
  return [...follows, who].slice(-FOLLOW_MAX);
}

/**
 * The People section: the follows, or, with none, the colleagues used most.
 * Suggestions come only from the roster, so a login that left the repository is
 * not brought back by an old score; with the roster not loaded yet there are none.
 */
export function peopleRows(
  follows: readonly string[], roster: readonly string[] | null, use: PersonUse, now = Date.now(),
): { followed: string[]; suggested: string[] } {
  if (follows.length) return { followed: [...follows], suggested: [] };
  if (!roster) return { followed: [], suggested: [] };
  return { followed: [], suggested: rankPeople(roster, use, now).frequent.slice(0, FREQUENT_MAX) };
}

export function loadFollows(repoKey: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY + repoKey) || "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(-FOLLOW_MAX) : [];
  } catch { return []; }
}

export function saveFollows(repoKey: string, follows: readonly string[]): void {
  try { localStorage.setItem(KEY + repoKey, JSON.stringify(follows)); } catch { /* private mode */ }
}
