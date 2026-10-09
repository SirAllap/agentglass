/*
 * The tones a row's words can have, and how lists across repositories group.
 * Where the review stands and what CI says are prCard.ts's.
 */
export type Tone = "neutral" | "accent" | "good" | "warn" | "bad";

export interface RepoGroup<T> { root: string; name: string; items: T[] }

/** Rows of a list across repositories: a heading, then that repository's
 *  rows. Empty repositories are left out when more than one is shown — a
 *  heading over nothing is a line that says nothing — and kept when one is,
 *  so the screen can say "nothing open in orbit". */
export function flatten<T>(groups: RepoGroup<T>[]): ({ heading: string; count: number } | { item: T; root: string })[] {
  const shown = groups.length > 1 ? groups.filter((g) => g.items.length) : groups;
  return shown.flatMap((g) => [
    ...(groups.length > 1 ? [{ heading: g.name, count: g.items.length }] : []),
    ...g.items.map((item) => ({ item, root: g.root })),
  ]);
}
