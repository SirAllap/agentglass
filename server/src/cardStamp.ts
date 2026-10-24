/*
 * "Somebody changed this card" — decided by what changed, not by the stamp.
 *
 * Both trackers give one number per card (ClickUp `date_updated`, Jira
 * `updated`), and every write is refused when it is not the number the person
 * was looking at. Measured on a real card: the person's own comment moved that
 * number seconds earlier, so the next write — putting a reviewer on the card —
 * was refused as "somebody changed this card", and the somebody was them.
 *
 * A stamp says that the card moved, not what moved. So every read the server
 * hands out leaves the few fields a write can set (status, assignees,
 * priority) here, filed under the stamp it was read at. When a write arrives
 * with a stamp that is no longer current, the card is read again and the two
 * are compared on the fields THIS write sets: a new comment, a tag or a due
 * date is not a conflict with an assignee change; a different assignee is.
 *
 * Ceiling: a stamp this process never saw (it restarted, or the card was read
 * by another server) has no baseline, so it stays a conflict — the safe side.
 * It also cannot say who made the change; the trackers give that only through
 * a history read per card, which the request budget does not allow.
 */

/** `assignees` is what is compared (the people's ids); `names` is only what a sentence says. */
export type Facets = { status: string; assignees: string; names: string; priority: string };
export type Facet = "status" | "assignees" | "priority";

const CARDS = 400;
const STAMPS = 4;

/** `provider:id` -> stamp -> what the card showed at that stamp. Insertion order is the eviction order. */
const seen = new Map<string, Map<number, Facets>>();

/**
 * The card as a person reads it, with the people sorted so two orders of one
 * group are one value. A person is their id, never their name: two people can
 * share a name, and one may have none, and either would read as "nobody moved".
 */
export const facetsOf = (status: string, people: readonly { key: string; name: string }[], priority: string | null | undefined): Facets => ({
  status,
  assignees: people.map((p) => p.key).sort().join(","),
  names: people.map((p) => p.name || p.key).sort().join(", "),
  priority: priority ?? "",
});

export function noteSeen(key: string, stamp: number, f: Facets): void {
  if (!stamp) return;
  const own = seen.get(key) ?? new Map<number, Facets>();
  seen.delete(key);
  own.set(stamp, f);
  while (own.size > STAMPS) own.delete(own.keys().next().value as number);
  seen.set(key, own);
  while (seen.size > CARDS) seen.delete(seen.keys().next().value as string);
}

const SAYS: Record<Facet, (v: string, f: Facets) => string> = {
  status: (v) => `its status is now ${v || "empty"}`,
  assignees: (_, f) => (f.names ? `it is now assigned to ${f.names}` : "it now has nobody assigned"),
  priority: (v) => `its priority is now ${v || "none"}`,
};

/**
 * The write may go ahead (the stamp moved, but not under the fields it sets),
 * or it stops with the sentence for the person.
 *
 * `stale` is the tracker's own sentence for a stamp with no baseline; when the
 * baseline is known the sentence names what moved instead of "somebody".
 */
export function judgeStale(
  key: string,
  expected: number,
  fresh: Facets,
  touches: readonly Facet[],
  stale: string,
): { go: true } | { go: false; error: string } {
  const was = seen.get(key)?.get(expected);
  if (!was) return { go: false, error: stale };
  const moved = touches.filter((t) => was[t] !== fresh[t]);
  if (!moved.length) return { go: true };
  return { go: false, error: `This card changed while you had it open: ${moved.map((t) => SAYS[t](fresh[t], fresh)).join(", ")}. Reloaded` };
}

/** For tests. */
export const __clearSeen = (): void => seen.clear();
