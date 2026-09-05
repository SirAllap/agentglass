/*
 * What "find" means on the pull-request board.
 *
 * Not the text on the screen — the CARD. A board search is asked one of two
 * questions, "which of these mentions billing" and "where is javidoe on this
 * board", and the second one is answered by fields the card only half shows:
 * the requested reviewers, the assignees, both branch names. Matching the
 * rendered text finds the first and misses the second, which is how typing a
 * name used to dim every card including the one that says "Waiting on javidoe"
 * in as many words.
 *
 * Pulled out of the board so the app's own find bar can drive exactly the same
 * rule — one search on this screen instead of two that disagree — and so the
 * rule itself can be tested without a board.
 */

/** Only what a card can be asked about. Deliberately structural: anything with
 *  these fields can be searched, including the rows of the table view. */
export interface FindableCard {
  number: number;
  title: string;
  author: string;
  headRefName?: string;
  baseRefName?: string;
  labels?: { name: string }[];
  assignees?: string[];
  reviewers?: { login: string }[];
}

/** Everything one card can be found by, as one lowercase string. */
export function haystack(p: FindableCard): string {
  return [
    `#${p.number}`, String(p.number), p.title, p.author, p.headRefName ?? "", p.baseRefName ?? "",
    ...(p.labels ?? []).map((l) => l.name),
    // The PEOPLE. Who owns it and who is being waited on are one question to
    // somebody looking for their own name.
    ...(p.assignees ?? []),
    ...(p.reviewers ?? []).map((r) => r.login),
  ].join(" ").toLowerCase();
}

/** Does this card answer to that? An empty needle matches everything, which is
 *  what "no search" looks like from here. */
export function prMatches(p: FindableCard, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  return !q || haystack(p).includes(q);
}

/** How many of them do. */
export function prHits<T extends FindableCard>(cards: T[], needle: string): number {
  const q = needle.trim().toLowerCase();
  return q ? cards.filter((p) => prMatches(p, q)).length : 0;
}

/**
 * Step through matches in board order, wrapping.
 *
 * `from` is where you are — the index of the card under the cursor within the
 * SAME list — and `-1` for "nowhere yet", which lands on the first match rather
 * than on the second. Answers `-1` when nothing matches, so the caller leaves
 * the cursor where it was instead of moving it somewhere arbitrary.
 */
export function stepMatch(flags: boolean[], from: number, dir: 1 | -1): number {
  const n = flags.length;
  if (!n || !flags.some(Boolean)) return -1;
  if (from < 0) return dir === 1 ? flags.indexOf(true) : flags.lastIndexOf(true);
  for (let k = 1; k <= n; k++) {
    const i = (from + dir * k + n * (k + 1)) % n;
    if (flags[i]) return i;
  }
  return -1;
}

/** Which match you are on, 1-based, or 0 when the cursor is not on one. */
export function matchIndex(flags: boolean[], at: number): number {
  if (at < 0 || at >= flags.length || !flags[at]) return 0;
  let n = 0;
  for (let i = 0; i <= at; i++) if (flags[i]) n++;
  return n;
}
