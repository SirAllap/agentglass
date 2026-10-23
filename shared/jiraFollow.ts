/*
 * Watching a Jira card and voting for it, as the pane and the door both decide it.
 *
 * Both are the connected account's own mark on a card, not a change to the card: neither moves the card's `updated`
 * stamp, so there is no stamp to check, and both are idempotent (watching twice is watching). That is why a toggle is
 * one request and carries no read-back. The count the pane shows after one is the count it read when the card opened,
 * moved by one only when the toggle really changed this account's own state; the next read of the card says the site's.
 */

/** What the card's own read says about it. A count the site did not give is `null`, and a site with voting off has no `votes`. */
export interface CardFollow {
  watching: boolean;
  /** Everybody watching, or null when the site does not say (it hides the count from an account that may not see the list). */
  watchers: number | null;
  voted: boolean;
  /** Everybody who voted, or null when the site has voting off for this card: there is then nothing to draw. */
  votes: number | null;
}

export type FollowKind = "watch" | "vote";

/** The card's marks after this account turned one on or off: the count moves only when the account's own state did. */
export function followAfter(f: CardFollow, kind: FollowKind, on: boolean): CardFollow {
  const was = kind === "watch" ? f.watching : f.voted;
  const step = was === on ? 0 : on ? 1 : -1;
  const bump = (n: number | null): number | null => (n === null ? null : Math.max(0, n + step));
  return kind === "watch" ? { ...f, watching: on, watchers: bump(f.watchers) } : { ...f, voted: on, votes: bump(f.votes) };
}

/** What happened, in the past tense, said after the site took it. */
export function followSaid(kind: FollowKind, on: boolean, key: string): string {
  if (kind === "watch") return on ? `You are watching ${key}` : `You stopped watching ${key}`;
  return on ? `You voted for ${key}` : `You took your vote off ${key}`;
}

/** What a control does, in the present tense, for its label and the tooltip. */
export function followAction(kind: FollowKind, on: boolean): string {
  if (kind === "watch") return on ? "Stop watching" : "Watch";
  return on ? "Remove vote" : "Vote";
}

/** "1 watcher", "3 watchers": a count is said with its noun, and an unknown one is not said at all. */
export function countSaid(n: number | null, one: string): string {
  if (n === null) return "";
  return `${n} ${n === 1 ? one : `${one}s`}`;
}
