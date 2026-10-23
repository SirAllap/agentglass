/*
 * Which pull requests have an "Update branch" on its way.
 *
 * Keyed by repository + number, because that is the only thing the request is
 * about: GitHub merges the base into each head on its own, so one pull request
 * waiting says nothing about another. Held as a set that is replaced, never
 * changed in place, so a state setter can take the result as it is.
 *
 * Ceiling: one window. The head ref and the checkout a request touches are
 * resolved on the server from (repository, number), which is also where two
 * syncs into one checkout take turns.
 */
export const flightKey = (root: string, number: number): string => `${root}#${number}`;

/** The set with this pull request added, or null when it was already there. */
export function enterFlight(flights: ReadonlySet<string>, key: string): Set<string> | null {
  if (flights.has(key)) return null;
  return new Set(flights).add(key);
}

export function leaveFlight(flights: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(flights);
  next.delete(key);
  return next;
}

export const inFlight = (flights: ReadonlySet<string>, root: string, number: number): boolean =>
  flights.has(flightKey(root, number));
